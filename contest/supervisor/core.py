"""Reap, retire, sampler GC, and the dual dispatch guard.

Decisions are pure. IO helpers are thin so tests can run without a platform.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ACTIVE_CONTAINER_STATUSES = frozenset({"available", "pending", "stop_pending"})
PLATFORM_CAP = 3
WORKER_DIR_RE_PREFIX = "w"


class SupervisorError(RuntimeError):
    pass


def parse_utc_prefix(stamp: str | None) -> datetime | None:
    """Parse the first 19 chars of an ISO timestamp as UTC.

    Matches the run4 retire clock (``%Y-%m-%dT%H:%M:%S``), ignoring fractions
    and a trailing ``Z``.
    """
    if stamp is None:
        return None
    text = str(stamp).strip()
    if len(text) < 19:
        return None
    try:
        parsed = datetime.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc)


def utc_now() -> datetime:
    raw = os.environ.get("CONTEST_SUPERVISOR_NOW", "").strip()
    if not raw:
        return datetime.now(timezone.utc)
    parsed = parse_utc_prefix(raw)
    if parsed is None:
        raise SupervisorError(f"CONTEST_SUPERVISOR_NOW is not ISO time: {raw}")
    return parsed


def env_int(names: tuple[str, ...], default: int) -> int:
    for name in names:
        raw = os.environ.get(name, "").strip()
        if not raw:
            continue
        try:
            return int(raw)
        except ValueError as exc:
            raise SupervisorError(f"{name} is not an integer: {raw}") from exc
    return default


def bounded_max(value: int) -> int:
    if value > PLATFORM_CAP:
        return PLATFORM_CAP
    return max(1, value)


def max_active() -> int:
    return bounded_max(env_int(("CONTEST_MAX_ACTIVE", "CONTEST_MAX_CONCURRENCY"), PLATFORM_CAP))


def challenge_code(challenge: dict) -> str:
    return str(challenge.get("unique_code") or challenge.get("code") or "").strip()


def is_completed(challenge: dict) -> bool:
    if not isinstance(challenge, dict):
        return False
    if challenge.get("is_completed") is True or challenge.get("completed") is True:
        return True
    status = str(challenge.get("status") or "").lower()
    return status in ("completed", "solved", "passed")


def past_grace(stamp: str | None, now: datetime, grace: int) -> tuple[bool, int]:
    """Return ``(exceeded, remaining_seconds)``.

    A missing or unparseable stamp counts as exceeded (remaining 0). The run4
    script printed ``0`` in that case and did not hold.
    """
    parsed = parse_utc_prefix(stamp)
    if parsed is None:
        return True, 0
    remaining = int(grace) - int((now - parsed).total_seconds())
    return remaining <= 0, remaining


def pid_alive(pid) -> bool:
    try:
        number = int(pid)
    except (TypeError, ValueError):
        return False
    if number <= 0:
        return False
    try:
        os.kill(number, 0)
    except OSError:
        return False
    stat_path = Path(f"/proc/{number}/stat")
    try:
        stat = stat_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    tail = stat.rsplit(")", 1)[-1].split()
    if not tail:
        return True
    return tail[0] not in ("Z", "X")


def terminate_pid(pid, wait: float = 1.0) -> None:
    """SIGTERM, then SIGKILL if the process is still alive after ``wait``."""
    try:
        number = int(pid)
    except (TypeError, ValueError):
        return
    if number <= 0:
        return
    try:
        os.kill(number, signal.SIGTERM)
    except OSError:
        return
    deadline = time.time() + max(0.0, wait)
    while time.time() < deadline:
        if not pid_alive(number):
            return
        time.sleep(0.05)
    if pid_alive(number):
        try:
            os.kill(number, signal.SIGKILL)
        except OSError:
            return


def count_active(challenges, *, unknown: bool = False) -> int:
    """Count platform containers that still occupy a slot.

    ``unknown=True`` returns 99 so a failed list fails closed and does not
    dispatch (the run4 script printed 99 on a bad payload).
    """
    if unknown:
        return 99
    total = 0
    for item in challenges or []:
        if isinstance(item, dict) and item.get("container_status") in ACTIVE_CONTAINER_STATUSES:
            total += 1
    return total


def dispatch_budget(alive: int, active: int, max_slots: int, queue_len: int) -> int:
    """How many new workers may start this tick.

    Both guards must be under the cap. Either one at the cap blocks dispatch.
    """
    if max_slots <= 0 or queue_len <= 0:
        return 0
    if alive >= max_slots or active >= max_slots:
        return 0
    return min(max_slots - alive, max_slots - active, queue_len)


def reap_candidates(challenges, workers, explicit=None, *, include_dead_launched: bool = False) -> list[str]:
    if explicit:
        return [str(code).strip() for code in explicit if str(code).strip()]
    found: list[str] = []
    seen: set[str] = set()
    for item in challenges or []:
        if not isinstance(item, dict):
            continue
        if item.get("container_status") not in ACTIVE_CONTAINER_STATUSES:
            continue
        code = challenge_code(item)
        if code and code not in seen:
            seen.add(code)
            found.append(code)
    if include_dead_launched:
        for worker in workers or []:
            if not worker.get("launched") or worker.get("alive"):
                continue
            code = str(worker.get("code") or "").strip()
            if code and code not in seen:
                seen.add(code)
                found.append(code)
    return found


def plan_reap(challenges, workers, codes=None, already_closed=None, *, include_dead_launched: bool = False) -> list[dict]:
    """Close each candidate once when no worker pid is alive. Alive → keep.

    ``already_closed`` suppresses a second close for the same code. Meta state
    is ignored: a deferred problem whose process is already dead still closes.
    """
    chosen = reap_candidates(
        challenges,
        workers,
        explicit=codes,
        include_dead_launched=include_dead_launched,
    )
    closed = {str(code).strip() for code in (already_closed or []) if str(code).strip()}
    alive = {
        str(worker.get("code") or "").strip()
        for worker in (workers or [])
        if worker.get("alive") and str(worker.get("code") or "").strip()
    }
    actions = []
    for code in chosen:
        if code in closed:
            continue
        if code in alive:
            actions.append({"op": "keep", "code": code})
        else:
            actions.append({"op": "close", "code": code})
    return actions


def plan_retire(workers, challenges, *, now: datetime, grace: int, grace_solved: int) -> list[dict]:
    """Kill, close, and maybe archive alive workers past their grace.

    Deferred or solved meta uses ``grace`` (default 60). Platform
    ``is_completed`` with meta not yet ``solved`` uses the shorter
    ``grace_solved`` (default 30). Dead workers are left for reap.
    """
    completed = set()
    for item in challenges or []:
        if isinstance(item, dict) and is_completed(item):
            code = challenge_code(item)
            if code:
                completed.add(code)
    actions = []
    for worker in workers or []:
        if not worker.get("alive"):
            continue
        code = str(worker.get("code") or "").strip()
        if not code:
            continue
        meta_state = str(worker.get("meta_state") or "none").strip().lower() or "none"
        platform_done = code in completed
        state = "solved" if platform_done else meta_state
        if state not in ("deferred", "solved"):
            continue
        limit = grace_solved if platform_done and meta_state != "solved" else grace
        exceeded, remaining = past_grace(worker.get("meta_at") or "", now, limit)
        action = {
            "op": "retire" if exceeded else "hold",
            "code": code,
            "state": state,
            "pid": worker.get("pid"),
            "dir": worker.get("dir"),
            "archive": state == "solved",
            "remaining": remaining,
            "grace": limit,
        }
        actions.append(action)
    return actions


def plan_gc_samplers(alive_session_ids, samplers) -> list[dict]:
    """Kill sampler loops whose SESSION_ID is not a living worker.

    An empty session id is not owned by anyone, so it is collected.
    """
    keep = {str(item).strip() for item in (alive_session_ids or []) if str(item).strip()}
    doomed = []
    for sampler in samplers or []:
        sid = str(sampler.get("session_id") or "").strip()
        if sid in keep:
            continue
        doomed.append({"op": "gc", "pid": sampler.get("pid"), "session_id": sid})
    return doomed


def read_pid_file(path: Path):
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not text:
        return None
    try:
        number = int(text)
    except ValueError:
        return None
    return number if number > 0 else None


def read_project_meta(worker_dir: Path) -> dict:
    projects = worker_dir / ".fgs" / "projects"
    if not projects.is_dir():
        return {"_present": False}
    files = sorted(projects.glob("*/meta.json"))
    if not files:
        return {"_present": False}
    try:
        data = json.loads(files[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"_present": False}
    if not isinstance(data, dict):
        return {"_present": False}
    merged = dict(data)
    merged["_present"] = True
    return merged


def worker_record(worker_dir: Path, code: str | None = None) -> dict:
    meta = read_project_meta(worker_dir)
    pid = read_pid_file(worker_dir / "pid")
    session = ""
    session_path = worker_dir / "sessionId"
    try:
        session = session_path.read_text(encoding="utf-8").strip()
    except OSError:
        session = ""
    resolved = code
    if not resolved:
        name = worker_dir.name
        parts = name.split("_", 1)
        resolved = parts[1] if len(parts) == 2 and parts[0][1:].isdigit() and parts[0].startswith("w") else name
    return {
        "code": resolved,
        "pid": pid,
        "alive": pid_alive(pid),
        "dir": str(worker_dir),
        "launched": pid is not None,
        "meta_state": meta.get("state") if meta.get("_present") else None,
        "meta_at": (meta.get("deferredAt") or meta.get("updatedAt") or "") if meta.get("_present") else "",
        "meta_present": bool(meta.get("_present")),
        "session_id": session,
    }


def scan_workers(run: Path) -> list[dict]:
    root = run / "workers"
    if not root.is_dir():
        return []
    found = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        name = entry.name
        if not name.startswith(WORKER_DIR_RE_PREFIX) or "_" not in name:
            continue
        prefix, _code = name.split("_", 1)
        if not prefix[1:].isdigit():
            continue
        found.append(worker_record(entry))
    return found


def list_samplers() -> list[dict]:
    root = Path("/proc")
    if not root.is_dir():
        return []
    found = []
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        text = raw.replace(b"\0", b" ").decode("utf-8", "replace")
        if "monitor_sampler.sh" not in text or "loop" not in text:
            continue
        sid = ""
        try:
            env = (entry / "environ").read_bytes()
        except OSError:
            env = b""
        for item in env.split(b"\0"):
            if item.startswith(b"SESSION_ID="):
                sid = item.split(b"=", 1)[1].decode("utf-8", "replace")
                break
        found.append({"pid": int(entry.name), "session_id": sid})
    return found


def load_closed_set(run: Path) -> set[str]:
    path = run / "attempted" / "closed.txt"
    if not path.is_file():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def mark_closed(run: Path, code: str) -> None:
    path = run / "attempted" / "closed.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(code + "\n")


def mark_retired(run: Path, code: str) -> None:
    path = run / "attempted" / "retired.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(code + "\n")


def record_close(run: Path, code: str, note: str) -> None:
    path = run / "monitor" / "closes.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"code": code, "note": note}, ensure_ascii=False)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def append_log(run: Path, message: str, tag: str = "") -> None:
    path = run / "monitor" / "autosup.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%m-%d %H:%M:%S")
    prefix = f"[{stamp}]"
    if tag:
        prefix += f" [{tag}]"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{prefix} {message}\n")


def lock_path(run: Path) -> Path:
    return run / "monitor" / "scheduler.lock"


def read_lock_pid(run: Path):
    path = lock_path(run)
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def scheduler_busy(run: Path, self_pid: int | None = None) -> bool:
    holder = read_lock_pid(run)
    if holder is None:
        return False
    if self_pid is not None and holder == self_pid:
        return False
    return pid_alive(holder)


def acquire_lock(run: Path) -> None:
    path = lock_path(run)
    path.parent.mkdir(parents=True, exist_ok=True)
    pid = os.getpid()
    for _ in range(3):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            holder = read_lock_pid(run)
            if holder == pid:
                return
            if holder is not None and pid_alive(holder):
                raise SupervisorError(
                    f"scheduler lock held by pid={holder}; refusing a second dispatcher"
                )
            try:
                path.unlink()
            except OSError:
                pass
            continue
        else:
            os.write(fd, str(pid).encode("ascii"))
            os.close(fd)
            return
    raise SupervisorError("could not acquire scheduler lock")


def release_lock(run: Path) -> None:
    path = lock_path(run)
    if read_lock_pid(run) != os.getpid():
        return
    try:
        path.unlink()
    except OSError:
        return


def archive_worker(worker_dir: Path) -> Path | None:
    if not worker_dir.is_dir():
        return None
    dest = worker_dir.parent / f"_done_{worker_dir.name}"
    if dest.exists():
        dest = worker_dir.parent / f"_done_{worker_dir.name}_{int(time.time())}"
    worker_dir.rename(dest)
    return dest


def queue_len(queue: Path) -> int:
    if not queue.is_file():
        return 0
    return sum(1 for line in queue.read_text(encoding="utf-8").splitlines() if line.strip())


def pop_queue_line(queue: Path):
    if not queue.is_file():
        return None
    lines = queue.read_text(encoding="utf-8").splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if not lines:
        queue.write_text("", encoding="utf-8")
        return None
    first = lines.pop(0)
    body = "\n".join(lines)
    if body:
        body += "\n"
    queue.write_text(body, encoding="utf-8")
    if "\t" in first:
        code, brief = first.split("\t", 1)
    else:
        code, brief = first.strip(), ""
    code = code.strip()
    if not code:
        return pop_queue_line(queue)
    return code, brief.strip()


def next_worker_dir(run: Path, code: str) -> Path:
    root = run / "workers"
    root.mkdir(parents=True, exist_ok=True)
    index = 1
    while (root / f"w{index}_{code}").exists():
        index += 1
    dest = root / f"w{index}_{code}"
    dest.mkdir(parents=True)
    return dest


def dispatch_worker(run: Path, code: str, brief: str, command: list[str] | None) -> dict:
    dest = next_worker_dir(run, code)
    (dest / "brief.txt").write_text(brief, encoding="utf-8")
    pid = None
    if command:
        proc = subprocess.Popen(command, cwd=str(dest), start_new_session=True)
        pid = proc.pid
        (dest / "pid").write_text(str(pid), encoding="utf-8")
    else:
        (dest / "pid").write_text("", encoding="utf-8")
    dispatched = run / "attempted" / "dispatched.txt"
    dispatched.parent.mkdir(parents=True, exist_ok=True)
    with dispatched.open("a", encoding="utf-8") as handle:
        handle.write(code + "\n")
    return {"code": code, "dir": str(dest), "pid": pid}


def attach_platform_headers(req, token: str, *, json_body: bool = False) -> None:
    """Headers for list / start / submit / close.

    The platform requires the literal header ``BENCHMARK_TOKEN`` (FastAPI 422
    if it is missing). Assign it directly: ``Request.add_header`` runs
    ``str.capitalize()`` and would send ``Benchmark_token``.
    """
    req.headers["authorization"] = f"Bearer {token}"
    req.headers["x-benchmark-token"] = token
    req.headers["BENCHMARK_TOKEN"] = token
    req.headers["accept"] = "application/json"
    if json_body:
        req.headers["content-type"] = "application/json"


def injected_platform_hosts() -> set[str]:
    """Hosts of the platform-injected Challenges base.

    ``BENCHMARK_BASE_URL`` is opaque. The platform may already hand it over
    ending in ``.tsecbench.gw``. ``PLATFORM_BASE_URL`` is the same injection
    under the older name. Model-gateway rewrite must not touch these hosts.
    """
    hosts: set[str] = set()
    for name in ("BENCHMARK_BASE_URL", "PLATFORM_BASE_URL"):
        raw = os.environ.get(name, "").strip()
        if not raw:
            continue
        host = (urllib.parse.urlsplit(raw).hostname or "").lower()
        if host:
            hosts.add(host)
    return hosts


def challenge_url(base: str, path: str) -> str:
    """Join the injected platform base with a Challenges path.

    Allow a URL whose host is exactly the injected ``BENCHMARK_BASE_URL``
    host, including when that host already ends in ``.tsecbench.gw``. That
    value is the real Challenges API, not a rewrite this process applied.

    Refuse any other ``.tsecbench.gw`` host. That is a public Challenges host
    this process suffixed itself, or a model-gateway host. The model gateway
    rejects those URLs with "request URL is not allowed by tsecbench".
    """
    raw = str(base or "").strip().rstrip("/")
    suffix = path if str(path).startswith("/") else f"/{path}"
    url = raw + suffix
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host and host in injected_platform_hosts():
        return url
    if host.endswith(".tsecbench.gw"):
        raise SupervisorError(
            f"refusing Challenges API URL {url}: SOLVER_GATEWAY must not rewrite BENCHMARK_BASE_URL"
        )
    return url


def api_prefixes() -> list[str]:
    explicit = os.environ.get("BENCHMARK_API_PREFIX", "").strip()
    if explicit:
        if not explicit.startswith("/"):
            explicit = "/" + explicit
        return [explicit.rstrip("/")]
    return ["/api/v1", "/openapi/v1"]


def request_json(method: str, url: str, token: str, body: dict | None = None, timeout: float = 20):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    attach_platform_headers(req, token, json_body=body is not None)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            payload = json.loads(raw) if raw.strip() else {}
            return resp.status, payload
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise SupervisorError(f"HTTP {exc.code} {method} {url} {detail}") from exc
    except urllib.error.URLError as exc:
        raise SupervisorError(f"request failed {method} {url}: {exc.reason}") from exc


def coerce_challenges(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("challenges", "data", "items", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise SupervisorError("list_challenges response has no challenge list")


def load_challenges(fixture: str | None, base: str, token: str) -> tuple[list, bool]:
    """Return ``(challenges, unknown)``. Unknown list fails the active count closed."""
    if fixture:
        try:
            payload = json.loads(Path(fixture).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SupervisorError(f"CONTEST_FIXTURE unreadable: {exc}") from exc
        return coerce_challenges(payload), False
    errors = []
    for prefix in api_prefixes():
        url = challenge_url(base, prefix + "/challenges")
        try:
            _status, payload = request_json("GET", url, token)
        except SupervisorError as exc:
            errors.append(str(exc))
            continue
        try:
            return coerce_challenges(payload), False
        except SupervisorError as exc:
            errors.append(str(exc))
    if errors:
        return [], True
    return [], True


def close_challenge(base: str, token: str, code: str, prefixes: list[str] | None = None):
    encoded = urllib.parse.urlencode({"unique_code": code})
    errors = []
    for prefix in prefixes or api_prefixes():
        url = challenge_url(base, prefix + "/challenges/close?" + encoded)
        try:
            return request_json("POST", url, token, {})
        except SupervisorError as exc:
            errors.append(str(exc))
    raise SupervisorError("close_challenge failed: " + " | ".join(errors))


def perform_close(run: Path, code: str, *, base: str, token: str, fixture: str | None, already: set[str]) -> str | None:
    """Close once. Returns the note, or None if this code was already closed."""
    if code in already:
        return None
    if fixture:
        note = "fixture"
    else:
        _status, payload = close_challenge(base, token, code)
        note = json.dumps(payload, ensure_ascii=False)[:300]
    record_close(run, code, note)
    mark_closed(run, code)
    already.add(code)
    append_log(run, f"close {code} -> {note}")
    return note


def grace_settings() -> tuple[int, int]:
    grace = env_int(("CONTEST_RETIRE_GRACE", "GRACE"), 60)
    solved = env_int(("CONTEST_RETIRE_GRACE_SOLVED", "GRACE_SOLVED"), 30)
    return grace, solved
