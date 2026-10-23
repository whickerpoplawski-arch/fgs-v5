#!/usr/bin/env python3
"""TSecBench hosted contest driver (P0 skeleton).

One agent container runs a multi-challenge queue. Max active challenges is
about 3 (platform cap). Per visit, before any model turn:

  list → start → mkdir workdir/<id> → bootstrap_project.mjs → verify graph → dsh

Disk pre-seed writes `.fgs/competition.json` and a project graph that already
contains `fact_origin` and `goal_final`. The plugin `attachRun` auto-attaches.
Do not wait for the model to type `/fgs new` or call `fgs_project`.

`dsh` is not vendored here. Unless CONTEST_DSH_LAUNCH=1 and `dsh` is on PATH,
the launch step records a stub under `.fgs/dsh-launch.json`.

VPN (optional): CONTEST_VPN=1 requires CONTEST_VPN_CONFIG and CONTEST_VPN_EXEC.
Hosted sandbox VPN presence is ambiguous (integration docs vs upload page);
the default leaves VPN off and does not block pre-seed.

SOLVER_GATEWAY=1 rewrites model base URLs only: env vars such as
DEEPSEEK_BASE_URL / OPENAI_BASE_URL, and a contest profile's baseURL field,
become `http://<host>.tsecbench.gw/...` (https becomes http). It must not
rewrite BENCHMARK_BASE_URL, BENCHMARK_TOKEN, or Challenges API URLs.
BENCHMARK_BASE_URL is opaque platform injection and is used as given, even
when the platform already supplies a `.tsecbench.gw` host. Contest profiles
must use openai-completions; the responses streaming path drops function_call.

Offline fixture (no platform): CONTEST_FIXTURE=/path/to.json
  { "challenges": [ { "unique_code", "description", "is_completed", "container_addr": [] } ] }

CONTEST_SUPERVISOR defaults on. The loop lives in this process: reap containers
whose worker died, retire deferred/solved workers after grace, and start the
next visit only when both alive workers and active containers are under
CONTEST_MAX_ACTIVE. It does not exec contest/supervisor/autosup.sh (that is a
second scheduler for the worker-directory layout).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from supervisor.core import (
    SupervisorError,
    acquire_lock,
    append_log,
    archive_worker,
    attach_platform_headers,
    challenge_url,
    count_active,
    dispatch_budget,
    grace_settings,
    injected_platform_hosts,
    list_samplers,
    load_closed_set,
    mark_retired,
    perform_close,
    plan_gc_samplers,
    plan_reap,
    plan_retire,
    read_project_meta,
    release_lock,
    terminate_pid,
    utc_now,
)

ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "tools" / "bootstrap_project.mjs"
DEFAULT_CRITERION = "取得有效 flag 并 submit correct=true"
# Explicit allowlist. Do not scan os.environ for http(s) values: BENCHMARK_BASE_URL
# is opaque platform injection and may already be a *.tsecbench.gw host.
MODEL_URL_ENVS = (
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "SOLVER_BASE_URL",
    "DEEPSEEK_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "LLM_BASE_URL",
)
PROTECTED_ENVS = (
    "BENCHMARK_BASE_URL",
    "BENCHMARK_TOKEN",
    "PLATFORM_BASE_URL",
    "BENCHMARK_API_PREFIX",
)
PROFILE_URL_KEYS = ("baseURL", "baseUrl", "base_url")
MAX_ACTIVE = 3


class DriverError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"contest: {message}", file=sys.stderr)


def normalize_problem_id(raw: str) -> str:
    """Match ProjectRegistry.normalizeId: lower-case, illegal chars to `_`, max 64."""
    text = str(raw or "").strip().lower()
    return re.sub(r"[^a-z0-9_-]", "_", text)[:64]


def protected_platform_hosts() -> set[str]:
    """Hosts of the injected Challenges API. Model rewrite must leave them unchanged."""
    return injected_platform_hosts()


def is_protected_platform_url(url: str) -> bool:
    """True for the platform host and for any Challenges API path."""
    parts = urllib.parse.urlsplit(str(url or "").strip())
    host = (parts.hostname or "").lower()
    if not host:
        return False
    protected = protected_platform_hosts()
    if host in protected or (host.endswith(".tsecbench.gw") and _bare_gateway_host(host) in protected):
        return True
    path = parts.path or ""
    return "/api/v1/challenges" in path or "/openapi/v1/challenges" in path


def _bare_gateway_host(host: str) -> str:
    suffix = ".tsecbench.gw"
    return host[: -len(suffix)] if host.endswith(suffix) else host


def rewrite_model_base(url: str) -> str:
    """Apply the hosted gateway rewrite when SOLVER_GATEWAY=1.

    https://api.deepseek.com/v1 → http://api.deepseek.com.tsecbench.gw/v1
    Hosts that already end in `.tsecbench.gw` are not double-suffixed.
    BENCHMARK_BASE_URL is never rewritten, even when it already ends in
    ``.tsecbench.gw``. Challenges API URLs are returned unchanged.
    """
    raw = str(url or "").strip()
    if not raw or os.environ.get("SOLVER_GATEWAY") != "1":
        return raw
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return raw
    if is_protected_platform_url(raw):
        return raw
    host = parts.hostname
    if not host.endswith(".tsecbench.gw"):
        host = host + ".tsecbench.gw"
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    if parts.username:
        auth = parts.username
        if parts.password:
            auth = f"{auth}:{parts.password}"
        netloc = f"{auth}@{netloc}"
    return urllib.parse.urlunsplit(("http", netloc, parts.path, parts.query, parts.fragment))


def _profile_dirs() -> list[Path]:
    """Contest profile roots.

    ``CONTEST_DSH_PROFILE_DIR`` is the only root when set (tests use this).
    Otherwise ``$DSH_HOME/profiles`` is scanned. ``~/.dsh`` is not implied, so a
    local ``SOLVER_GATEWAY=1`` run does not rewrite a developer profile.
    """
    explicit = os.environ.get("CONTEST_DSH_PROFILE_DIR", "").strip()
    if explicit:
        return [Path(explicit)]
    dsh_home = os.environ.get("DSH_HOME", "").strip()
    if dsh_home:
        return [Path(dsh_home) / "profiles"]
    return []


def _rewrite_yaml_profile(text: str) -> str:
    """Rewrite only baseURL keys. Other URL lines, including the platform host, stay."""
    pattern = re.compile(r"^(\s*)(baseURL|baseUrl|base_url)(\s*:\s*)(.*)$")
    lines: list[str] = []
    changed = False
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        ending = line[len(body) :]
        match = pattern.match(body)
        if not match:
            lines.append(line)
            continue
        raw_value = match.group(4).strip()
        quote = ""
        comment = ""
        inner = raw_value
        if raw_value[:1] in ("'", '"'):
            quote = raw_value[0]
            end = raw_value.find(quote, 1)
            if end < 0:
                lines.append(line)
                continue
            inner = raw_value[1:end]
            comment = raw_value[end + 1 :]
        elif " #" in raw_value:
            inner, comment = raw_value.split(" #", 1)
            inner = inner.strip()
            comment = " #" + comment
        if not inner or is_protected_platform_url(inner):
            lines.append(line)
            continue
        rewritten = rewrite_model_base(inner)
        if rewritten == inner:
            lines.append(line)
            continue
        rendered = f"{quote}{rewritten}{quote}{comment}" if quote else f"{rewritten}{comment}"
        lines.append(f"{match.group(1)}{match.group(2)}{match.group(3)}{rendered}{ending}")
        changed = True
    return "".join(lines) if changed else text


def _rewrite_json_profile(node) -> bool:
    changed = False
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key in PROFILE_URL_KEYS and isinstance(value, str):
                if value and not is_protected_platform_url(value):
                    rewritten = rewrite_model_base(value)
                    if rewritten != value:
                        node[key] = rewritten
                        changed = True
            elif isinstance(value, (dict, list)) and _rewrite_json_profile(value):
                changed = True
    elif isinstance(node, list):
        for item in node:
            if isinstance(item, (dict, list)) and _rewrite_json_profile(item):
                changed = True
    return changed


def rewrite_profile_bases() -> None:
    """Rewrite contest-profile baseURL fields only. Never walk arbitrary URL strings."""
    if os.environ.get("SOLVER_GATEWAY") != "1":
        return
    for root in _profile_dirs():
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if "node_modules" in path.parts or ".git" in path.parts:
                continue
            if path.suffix.lower() not in {".json", ".yml", ".yaml"}:
                continue
            try:
                if path.stat().st_size > 1_000_000:
                    continue
                original = path.read_text(encoding="utf-8")
            except OSError as exc:
                log(f"profile rewrite skipped {path}: {exc}")
                continue
            if path.suffix.lower() == ".json":
                try:
                    payload = json.loads(original)
                except json.JSONDecodeError:
                    log(f"profile rewrite skipped {path}: not JSON")
                    continue
                if not _rewrite_json_profile(payload):
                    continue
                path.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                log(f"rewrote profile baseURL in {path}")
                continue
            rewritten = _rewrite_yaml_profile(original)
            if rewritten == original:
                continue
            path.write_text(rewritten, encoding="utf-8")
            log(f"rewrote profile baseURL in {path}")


def apply_gateway_rewrites() -> None:
    """Rewrite model endpoints onto *.tsecbench.gw.

    BENCHMARK_* is restored verbatim. A platform-injected Challenges host that
    already ends in ``.tsecbench.gw`` stays that way and is still called.
    """
    if os.environ.get("SOLVER_GATEWAY") != "1":
        log("SOLVER_GATEWAY is off; model base URLs are unchanged")
        return
    saved = {name: os.environ.get(name) for name in PROTECTED_ENVS}
    for name in MODEL_URL_ENVS:
        if name in PROTECTED_ENVS:
            continue
        current = os.environ.get(name, "").strip()
        if not current or is_protected_platform_url(current):
            continue
        rewritten = rewrite_model_base(current)
        if rewritten != current:
            os.environ[name] = rewritten
            log(f"rewrote {name}: {current} → {rewritten}")
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    benchmark = os.environ.get("BENCHMARK_BASE_URL", "").strip()
    if benchmark:
        log(f"BENCHMARK_BASE_URL unchanged: {benchmark}")
    rewrite_profile_bases()


def require_platform_env() -> None:
    missing = [
        name
        for name in ("BENCHMARK_TOKEN", "BENCHMARK_BASE_URL")
        if not os.environ.get(name, "").strip()
    ]
    if missing:
        raise DriverError(
            "missing "
            + ", ".join(missing)
            + " (platform injects these at runtime; do not bake them into the image)"
        )


def vpn_preflight() -> None:
    flag = os.environ.get("CONTEST_VPN", "").strip().lower()
    enabled = flag in ("1", "true", "yes", "on")
    if not enabled:
        log(
            "VPN off (CONTEST_VPN unset). Integration docs say challenge addresses "
            "need a task VPN; the hosted upload page does not say the sandbox "
            "includes one. P0 does not block pre-seed on that ambiguity."
        )
        return
    config = os.environ.get("CONTEST_VPN_CONFIG", "").strip()
    if not config or not os.path.isfile(config):
        raise DriverError("CONTEST_VPN=1 but CONTEST_VPN_CONFIG is missing or not a file")
    command = os.environ.get("CONTEST_VPN_EXEC", "").strip()
    if not command:
        raise DriverError(
            "CONTEST_VPN=1 but CONTEST_VPN_EXEC is empty "
            "(this skeleton does not bundle an OpenVPN client)"
        )
    log(f"VPN toggle on; running CONTEST_VPN_EXEC (config {config})")
    subprocess.run(shlex.split(command), check=True)


def _request(method: str, url: str, token: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    attach_platform_headers(req, token, json_body=body is not None)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            payload = json.loads(raw) if raw.strip() else {}
            return resp.status, payload
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise DriverError(f"HTTP {exc.code} {method} {url} {detail}") from exc
    except urllib.error.URLError as exc:
        raise DriverError(f"request failed {method} {url}: {exc.reason}") from exc


def coerce_challenges(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("challenges", "data", "items", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise DriverError("list_challenges response has no challenge list")


def container_addrs(payload) -> list[str]:
    """Pull challenge addresses out of a list response or a start response."""
    if isinstance(payload, list):
        found: list[str] = []
        for item in payload:
            if isinstance(item, str) and item.strip():
                found.append(item.strip())
            elif isinstance(item, dict):
                found.extend(container_addrs(item))
        return found
    if not isinstance(payload, dict):
        return []
    for key in ("container_addr", "containerAddr", "addrs", "address", "addr"):
        if key not in payload:
            continue
        value = payload[key]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        if isinstance(value, (list, dict)):
            found = container_addrs(value)
            if found:
                return found
    for key in ("data", "challenge", "result"):
        value = payload.get(key)
        if isinstance(value, (dict, list)):
            found = container_addrs(value)
            if found:
                return found
    return []


def api_prefixes() -> list[str]:
    explicit = os.environ.get("BENCHMARK_API_PREFIX", "").strip()
    if explicit:
        if not explicit.startswith("/"):
            explicit = "/" + explicit
        return [explicit.rstrip("/")]
    # SDK docs use /api/v1; the local bench and tools/submit_flag.mjs use /openapi/v1.
    return ["/api/v1", "/openapi/v1"]


def list_challenges_live(base: str, token: str):
    errors = []
    for prefix in api_prefixes():
        try:
            url = challenge_url(base, prefix + "/challenges")
        except SupervisorError as exc:
            raise DriverError(str(exc)) from exc
        try:
            _status, payload = _request("GET", url, token)
        except DriverError as exc:
            errors.append(str(exc))
            continue
        return prefix, coerce_challenges(payload)
    raise DriverError("list_challenges failed: " + " | ".join(errors))


def start_challenge_live(base: str, prefix: str, token: str, code: str) -> list[str]:
    """POST ``{prefix}/challenges/start?unique_code=`` with body ``{}``.

    Hosted FastAPI requires ``unique_code`` as a query parameter. A JSON body
    alone is HTTP 422 (``loc`` is ``["query", "unique_code"]``). The path form
    ``/challenges/{code}/start`` is HTTP 404 on this platform and is not called.

    ``prefix`` is the one ``list_challenges_live`` already selected
    (``/openapi/v1`` on the hosted bench). An empty prefix retries
    ``api_prefixes()`` with the same query shape, including ``/api/v1``.
    """
    query = urllib.parse.urlencode({"unique_code": code})
    prefixes = [prefix] if prefix else api_prefixes()
    errors = []
    for item in prefixes:
        path = f"{item}/challenges/start?{query}"
        try:
            url = challenge_url(base, path)
        except SupervisorError as exc:
            raise DriverError(str(exc)) from exc
        try:
            _status, payload = _request("POST", url, token, {})
        except DriverError as exc:
            errors.append(str(exc))
            continue
        addrs = container_addrs(payload)
        if addrs:
            return addrs
        errors.append(f"{url} returned no container_addr")
    raise DriverError("start_challenge failed: " + " | ".join(errors))


def load_fixture(path: Path) -> list:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DriverError(f"CONTEST_FIXTURE unreadable: {exc}") from exc
    return coerce_challenges(payload)


def is_completed(challenge: dict) -> bool:
    if challenge.get("is_completed") is True or challenge.get("completed") is True:
        return True
    status = str(challenge.get("status") or "").lower()
    return status in ("completed", "solved", "passed")


def compose_brief(description: str, addrs: list[str]) -> str:
    addr_text = ", ".join(addrs)
    text = (description or "").strip()
    return (
        f"{text}\n"
        f"container_addr: {addr_text}\n"
        "只做本题。凭证在运行时环境里，不要写入镜像。"
    )


def bootstrap(cwd: Path, problem_id: str, brief: str, target: str) -> dict:
    if not BOOTSTRAP.is_file():
        raise DriverError(f"missing bootstrap writer: {BOOTSTRAP}")
    proc = subprocess.run(
        [
            "node",
            str(BOOTSTRAP),
            "--cwd",
            str(cwd),
            "--problem-id",
            problem_id,
            "--brief",
            brief,
            "--target",
            target,
            "--criterion",
            os.environ.get("FGS_CRITERION", DEFAULT_CRITERION),
            *(["--cold-start-step"] if cold_start_step_enabled() else []),
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.stderr.strip():
        log(proc.stderr.strip())
    if proc.returncode != 0:
        raise DriverError(proc.stderr.strip() or proc.stdout.strip() or "bootstrap failed")
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise DriverError(f"bootstrap returned non-JSON: {proc.stdout!r}") from exc


def assert_seeded(cwd: Path, problem_id: str) -> None:
    competition = cwd / ".fgs" / "competition.json"
    graph = cwd / ".fgs" / "projects" / problem_id / "graph.yaml"
    if not competition.is_file() or not graph.is_file():
        raise DriverError(f"seed missing under {cwd}")
    index = json.loads(competition.read_text(encoding="utf-8"))
    if index.get("activeProblemId") != problem_id:
        raise DriverError(
            f"activeProblemId={index.get('activeProblemId')!r} expected {problem_id}"
        )
    text = graph.read_text(encoding="utf-8")
    if "fact_origin" not in text or "goal_final" not in text:
        raise DriverError(f"graph missing fact_origin/goal_final: {graph}")


def launch_dsh(cwd: Path, problem_id: str, *, background: bool = False):
    """Start the solver in ``cwd``.

    Returns a ``Popen`` when ``background`` is set and a real command exists.
    The stub path writes ``.fgs/dsh-launch.json`` and returns None. The prompt
    stays a solve prompt: it does not mention reap, retire, or autosup.
    """
    prompt = cwd / "prompt.txt"
    prompt.write_text(
        "这道题的 FGS Project 已在磁盘种好（fact_origin 与 goal_final 已存在）。\n"
        "不要调用 fgs_project，也不要输入 /fgs new。直接用 fgs_open_step 推进。\n"
        "只做本题。取得有效 flag 并 submit，correct=true 才算完成。\n",
        encoding="utf-8",
    )
    loop_command = activity_loop_argv(cwd, problem_id)
    command = loop_command or solver_argv(prompt)
    record = {
        "problemId": problem_id,
        "cwd": str(cwd),
        "stub": command is None,
        "activityRuns": loop_command is not None,
        "command": command
        or [
            shutil.which(os.environ.get("CONTEST_DSH_BIN", "dsh")) or "dsh",
            "--profile",
            os.environ.get("CONTEST_DSH_PROFILE", "headless"),
            "--json",
            str(prompt),
        ],
        "provider": "openai-completions",
        "note": (
            "Harness is not launched unless CONTEST_DSH_LAUNCH=1 and dsh is on PATH "
            "(or CONTEST_WORKER_CMD is set). "
            "The contest profile must use openai-completions; responses streaming drops function_call. "
            "The graph is already seeded, so the model does not need /fgs new."
        ),
    }
    marker = cwd / ".fgs" / "dsh-launch.json"
    if command is None:
        marker.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"dsh launch stub for {problem_id} (set CONTEST_DSH_LAUNCH=1 when the harness is installed)")
        return None
    log(f"launch solver cwd={cwd} background={background}")
    if background:
        proc = subprocess.Popen(command, cwd=str(cwd), start_new_session=True)
        record["pid"] = proc.pid
        record["stub"] = False
        marker.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return proc
    marker.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    subprocess.run(command, cwd=str(cwd), check=False)
    return None


def visit(
    challenge: dict,
    *,
    base: str,
    prefix: str | None,
    token: str,
    workdir: Path,
    fixture: bool,
    background: bool = False,
) -> dict:
    raw_code = str(challenge.get("unique_code") or challenge.get("code") or "").strip()
    problem_id = normalize_problem_id(raw_code)
    if not problem_id or not re.fullmatch(r"[a-z0-9_-]{1,64}", problem_id):
        return {"ok": False, "problemId": raw_code, "code": raw_code, "error": f"bad problem id: {raw_code!r}"}
    started = False
    try:
        if fixture:
            addrs = container_addrs(challenge)
        else:
            addrs = start_challenge_live(base, prefix or "", token, raw_code)
            started = True
        if not addrs:
            raise DriverError("start returned empty container_addr; skip bootstrap and dsh")
        cwd = workdir / problem_id
        cwd.mkdir(parents=True, exist_ok=True)
        brief = compose_brief(str(challenge.get("description") or ""), addrs)
        target = ", ".join(addrs)
        seeded = bootstrap(cwd, problem_id, brief, target)
        assert_seeded(cwd, seeded.get("problemId") or problem_id)
        proc = launch_dsh(cwd, seeded.get("problemId") or problem_id, background=background)
        log(f"visit {problem_id} {seeded.get('status')}")
        result = {
            "ok": True,
            "problemId": problem_id,
            "code": raw_code,
            "status": seeded.get("status"),
            "cwd": str(cwd),
            "started": started,
        }
        if proc is not None:
            result["pid"] = proc.pid
            result["proc"] = proc
            result["launched"] = True
        return result
    except (DriverError, OSError, subprocess.CalledProcessError) as exc:
        log(f"visit {problem_id or raw_code} failed: {exc}")
        return {
            "ok": False,
            "problemId": problem_id or raw_code,
            "code": raw_code,
            "error": str(exc),
            "started": started,
            "close": started,
        }


def concurrency() -> int:
    source = "CONTEST_MAX_ACTIVE" if os.environ.get("CONTEST_MAX_ACTIVE", "").strip() else "CONTEST_MAX_CONCURRENCY"
    raw = os.environ.get(source, str(MAX_ACTIVE)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise DriverError(f"{source} is not an integer: {raw}") from exc
    if value > MAX_ACTIVE:
        log(f"{source}={value} capped at {MAX_ACTIVE} (platform max active)")
        value = MAX_ACTIVE
    return max(1, value)


def supervisor_enabled() -> bool:
    raw = os.environ.get("CONTEST_SUPERVISOR", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def solver_argv(prompt: Path) -> list[str] | None:
    custom = os.environ.get("CONTEST_WORKER_CMD", "").strip()
    if custom:
        return shlex.split(custom)
    dsh = shutil.which(os.environ.get("CONTEST_DSH_BIN", "dsh"))
    if os.environ.get("CONTEST_DSH_LAUNCH") == "1" and dsh:
        profile = os.environ.get("CONTEST_DSH_PROFILE", "headless")
        return [dsh, "--profile", profile, "--json", str(prompt)]
    return None


def activity_runs_enabled() -> bool:
    """v5：一题 = 一串一次性活动 run。

    启用条件是「真的能起 harness」：CONTEST_DSH_LAUNCH=1 且 dsh 在 PATH 上。
    CONTEST_ACTIVITY_RUNS=0/off 可以关掉（退回单进程长会话）；
    显式设置了 CONTEST_WORKER_CMD 时也不接管 —— 那是完整的 worker 替换，
    driver 不该在它外面再套一层活动编排（测试和自带 worker 的后端都依赖这一点）。
    """
    raw = os.environ.get("CONTEST_ACTIVITY_RUNS", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if os.environ.get("CONTEST_WORKER_CMD", "").strip():
        return False
    if os.environ.get("CONTEST_DSH_LAUNCH") != "1":
        return False
    return bool(shutil.which(os.environ.get("CONTEST_DSH_BIN", "dsh")))


def cold_start_step_enabled() -> bool:
    """竞赛默认开启冷启动直冲（Cairn bootstrap 快路径）；CONTEST_COLD_START_STEP=0 可关。"""
    return os.environ.get("CONTEST_COLD_START_STEP", "1").strip() != "0"


def env_number(name: str, default, cast=float):
    """读一个数值型环境变量；空/非法值回退默认，避免污染编排器参数。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError:
        log(f"{name}={raw!r} 不是数字，忽略")
        return default


def activity_loop_argv(cwd: Path, problem_id: str) -> list[str] | None:
    """活动编排器命令；harness 没安装/未启用时返回 None，让 driver 走原来的 stub 记录。"""
    if not activity_runs_enabled():
        return None
    dsh = shutil.which(os.environ.get("CONTEST_DSH_BIN", "dsh"))
    argv = [
        sys.executable,
        str(ROOT / "contest" / "activity_loop.py"),
        "--cwd", str(cwd),
        "--problem-id", problem_id,
        "--dsh-bin", dsh,
    ]
    # 活动参数按题难度可调（README 环境变量表）：不设置就用编排器默认值。
    timeout = env_number("CONTEST_ACTIVITY_TIMEOUT", None)
    if timeout is not None:
        argv += ["--activity-timeout-sec", str(timeout)]
        argv += ["--budget-sec", str(env_number("CONTEST_ACTIVITY_BUDGET", 1800))]
        argv += ["--max-activities", str(env_number("CONTEST_MAX_ACTIVITIES", 24, int))]
        argv += ["--conclude-timeout-sec", str(env_number("CONTEST_CONCLUDE_TIMEOUT", 120))]
    parallel = env_number("CONTEST_ACTIVITY_PARALLEL", None, int)
    if parallel is not None:
        argv += ["--parallel", str(max(1, parallel))]
    decide_every = env_number("CONTEST_DECIDE_EVERY", None, int)
    if decide_every is not None:
        argv += ["--decide-every", str(decide_every)]
    # v5.2：Decide 与 Execute 并发（默认关闭 = 仍是 v5.1 的活动序列）。
    if env_number("CONTEST_CONCURRENT_DECIDE", 0, int):
        argv += ["--concurrent-decide"]
    argv += ["--decide-timeout-sec", str(env_number("CONTEST_DECIDE_TIMEOUT", 300))]
    argv += ["--max-decides", str(env_number("CONTEST_MAX_DECIDES", 12, int))]
    rebase_mode = os.environ.get("CONTEST_REBASE_MODE", "full").strip()
    if rebase_mode in ("append", "full"):
        argv += ["--rebase-mode", rebase_mode]
    return argv


def run_root(workdir: Path) -> Path:
    raw = os.environ.get("RUN", "").strip()
    return Path(raw).expanduser().resolve() if raw else workdir


def load_challenge_snapshot(base: str, token: str, fixture_path: str):
    if fixture_path:
        challenges = load_fixture(Path(fixture_path))
        return None, challenges, f"fixture list: {len(challenges)} challenges from {fixture_path}"
    prefix, challenges = list_challenges_live(base, token)
    return prefix, challenges, f"list_challenges via {prefix}: {len(challenges)}"


def announce_schedule(challenges) -> tuple[list, int]:
    pending = [item for item in challenges if isinstance(item, dict) and not is_completed(item)]
    skipped = len(challenges) - len(pending)
    if skipped:
        log(f"skip completed: {skipped}")
    if not pending:
        log("no pending challenges")
        return [], 0
    workers = min(concurrency(), len(pending))
    log(f"schedule {len(pending)} visits, max concurrency {workers} (platform cap {MAX_ACTIVE})")
    return pending, workers


def run_once(workdir: Path, token: str, base: str, fixture_path: str) -> int:
    prefix, challenges, listed = load_challenge_snapshot(base, token, fixture_path)
    log(listed)
    pending, workers = announce_schedule(challenges)
    if not pending:
        return 0
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(
                visit,
                item,
                base=base,
                prefix=prefix,
                token=token,
                workdir=workdir,
                fixture=bool(fixture_path),
            )
            for item in pending
        ]
        for future in as_completed(futures):
            results.append(future.result())
    failed = [item for item in results if not item.get("ok")]
    log(f"done ok={len(results) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


def slot_view(slot: dict) -> dict:
    directory = Path(slot["dir"]) if slot.get("dir") else None
    meta = read_project_meta(directory) if directory and directory.is_dir() else {"_present": False}
    proc = slot.get("proc")
    if proc is not None:
        alive = proc.poll() is None
        pid = proc.pid
    else:
        alive = False
        pid = slot.get("pid")
    return {
        "code": slot.get("code"),
        "pid": pid,
        "alive": alive,
        "dir": slot.get("dir"),
        "launched": bool(slot.get("launched")),
        "meta_state": meta.get("state") if meta.get("_present") else None,
        "meta_at": (meta.get("deferredAt") or meta.get("updatedAt") or "") if meta.get("_present") else "",
        "meta_present": bool(meta.get("_present")),
        "session_id": slot.get("session_id") or "",
    }


def remember_slot(result: dict) -> dict | None:
    if not result.get("ok") or not result.get("cwd"):
        return None
    return {
        "code": result.get("code") or result.get("problemId"),
        "pid": result.get("pid"),
        "proc": result.get("proc"),
        "dir": result.get("cwd"),
        "launched": bool(result.get("launched")),
        "session_id": "",
    }


def close_slot(run: Path, code: str, already: set[str], fixture_path: str, base: str, token: str) -> bool:
    if not code or code in already:
        return False
    try:
        note = perform_close(
            run,
            code,
            base=base,
            token=token,
            fixture=fixture_path or None,
            already=already,
        )
    except SupervisorError as exc:
        log(f"close {code} failed: {exc}")
        append_log(run, f"close {code} failed: {exc}")
        return False
    if note is None:
        return False
    log(f"close {code}")
    return True


def supervisor_interval() -> float:
    raw = os.environ.get("CONTEST_SUPERVISOR_INTERVAL", "20").strip() or "20"
    try:
        return max(0.0, float(raw))
    except ValueError as exc:
        raise DriverError(f"CONTEST_SUPERVISOR_INTERVAL is not a number: {raw}") from exc


def pending_queue(challenges, attempted: set[str], inflight: set[str]) -> list:
    queue = []
    for item in challenges:
        if not isinstance(item, dict) or is_completed(item):
            continue
        code = str(item.get("unique_code") or item.get("code") or "").strip()
        if not code or code in attempted or code in inflight:
            continue
        queue.append(item)
    return queue


def run_supervised(workdir: Path, token: str, base: str, fixture_path: str) -> int:
    """One scheduler: reap, retire, then fill free slots from this driver's queue."""
    run = run_root(workdir)
    (run / "monitor").mkdir(parents=True, exist_ok=True)
    (run / "attempted").mkdir(parents=True, exist_ok=True)
    try:
        acquire_lock(run)
    except SupervisorError as exc:
        raise DriverError(str(exc)) from exc
    log("supervisor on (this driver owns dispatch)")
    try:
        return supervisor_loop(run, workdir, token, base, fixture_path)
    finally:
        release_lock(run)


def supervisor_loop(run: Path, workdir: Path, token: str, base: str, fixture_path: str) -> int:
    interval = supervisor_interval()
    grace, grace_solved = grace_settings()
    cap = concurrency()
    attempted: set[str] = set()
    slots: list[dict] = []
    visits: list[dict] = []
    closed = load_closed_set(run)
    prefix = None
    announced = False

    while True:
        prefix, challenges, listed = load_challenge_snapshot(base, token, fixture_path)
        if not announced:
            log(listed)
            pending, _workers = announce_schedule(challenges)
            announced = True
            if not pending:
                return 0

        views = [slot_view(slot) for slot in slots]
        for action in plan_reap(challenges, views, already_closed=closed, include_dead_launched=True):
            if action["op"] == "keep":
                append_log(run, f"keep {action['code']}")
                continue
            close_slot(run, action["code"], closed, fixture_path, base, token)
        slots = [slot for slot in slots if slot_view(slot)["alive"]]

        views = [slot_view(slot) for slot in slots]
        for action in plan_retire(views, challenges, now=utc_now(), grace=grace, grace_solved=grace_solved):
            if action["op"] == "hold":
                append_log(
                    run,
                    f"hold {action['code']} ({action['state']}, grace {action['remaining']}s)",
                    tag="retire",
                )
                log(f"hold {action['code']} ({action['state']})")
                continue
            terminate_pid(action.get("pid"))
            close_slot(run, action["code"], closed, fixture_path, base, token)
            if action.get("archive") and action.get("dir"):
                archive_worker(Path(action["dir"]))
            mark_retired(run, action["code"])
            attempted.add(action["code"])
            append_log(run, f"retire {action['code']} ({action['state']})", tag="retire")
            log(f"retire {action['code']}")
        slots = [slot for slot in slots if slot_view(slot)["alive"]]

        views = [slot_view(slot) for slot in slots]
        alive_ids = [view.get("session_id") or "" for view in views if view.get("alive")]
        for sampler in plan_gc_samplers(alive_ids, list_samplers()):
            terminate_pid(sampler.get("pid"), wait=0.2)
            append_log(run, f"gc sampler pid={sampler.get('pid')} (session={sampler.get('session_id')})")

        inflight = {slot.get("code") for slot in slots}
        queue = pending_queue(challenges, attempted, inflight)
        alive = sum(1 for slot in slots if slot_view(slot)["alive"])
        active = count_active(challenges)
        budget = dispatch_budget(alive, active, cap, len(queue))
        append_log(run, f"alive_workers={alive} active_containers={active} queue_left={len(queue)}")
        log(f"supervisor tick alive={alive} active={active} queue={len(queue)} budget={budget}")

        if budget > 0 and queue:
            batch = queue[:budget]
            for item in batch:
                code = str(item.get("unique_code") or item.get("code") or "").strip()
                if code:
                    attempted.add(code)
            with ThreadPoolExecutor(max_workers=max(1, min(len(batch), cap))) as pool:
                futures = [
                    pool.submit(
                        visit,
                        item,
                        base=base,
                        prefix=prefix,
                        token=token,
                        workdir=workdir,
                        fixture=bool(fixture_path),
                        background=True,
                    )
                    for item in batch
                ]
                for future in as_completed(futures):
                    result = future.result()
                    visits.append(result)
                    if not result.get("ok"):
                        if result.get("close") and result.get("code"):
                            close_slot(run, result["code"], closed, fixture_path, base, token)
                        continue
                    remembered = remember_slot(result)
                    if remembered is not None:
                        slots.append(remembered)
            # Let a just-started worker write meta.json before the next retire read.
            if any(slot.get("proc") is not None for slot in slots):
                time.sleep(0.2)
            continue

        if not queue and not any(slot_view(slot)["alive"] for slot in slots):
            break
        time.sleep(interval)

    failed = [item for item in visits if not item.get("ok")]
    log(f"done ok={len(visits) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    del argv  # reserved; the visit order is driven by env + the platform, not flags
    try:
        require_platform_env()
        # Capture the injected Challenges endpoint before any gateway rewrite.
        # apply_gateway_rewrites must not touch these; the snapshot is what list,
        # start, and close actually call.
        token = os.environ["BENCHMARK_TOKEN"].strip()
        base = os.environ["BENCHMARK_BASE_URL"].strip()
        apply_gateway_rewrites()
        os.environ["BENCHMARK_TOKEN"] = token
        os.environ["BENCHMARK_BASE_URL"] = base
        vpn_preflight()
        workdir = Path(os.environ.get("CONTEST_WORKDIR", str(ROOT / "contest-work"))).resolve()
        workdir.mkdir(parents=True, exist_ok=True)
        fixture_path = os.environ.get("CONTEST_FIXTURE", "").strip()
        if not supervisor_enabled():
            log("supervisor off")
            return run_once(workdir, token, base, fixture_path)
        return run_supervised(workdir, token, base, fixture_path)
    except (DriverError, SupervisorError) as exc:
        log(str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
