#!/usr/bin/env python3
"""Worker-directory reap / retire / autosup.

Hosted contest runs do not start this process. ``contest/driver.py`` owns
that queue. This CLI is the multi-worker layout (``$RUN/workers/wN_<code>``).
``autosup`` and ``tick`` refuse to dispatch when another live scheduler holds
``$RUN/monitor/scheduler.lock``.
"""

from __future__ import annotations

import os
import shlex
import sys
import time
from pathlib import Path

import core

REQUIRED = ("RUN", "BENCHMARK_TOKEN", "BENCHMARK_BASE_URL")


def fail(message: str, code: int = 2) -> int:
    print(f"contest: {message}", file=sys.stderr)
    return code


def require_env() -> Path | None:
    missing = [name for name in REQUIRED if not os.environ.get(name, "").strip()]
    if missing:
        fail(
            "missing "
            + ", ".join(missing)
            + " (set RUN and the platform BENCHMARK_* vars; do not bake them into the image)"
        )
        return None
    return Path(os.environ["RUN"]).expanduser().resolve()


def load_platform():
    fixture = os.environ.get("CONTEST_FIXTURE", "").strip() or None
    token = os.environ["BENCHMARK_TOKEN"].strip()
    base = os.environ["BENCHMARK_BASE_URL"].strip()
    challenges, unknown = core.load_challenges(fixture, base, token)
    return challenges, unknown, fixture, token, base


def close_fn(run: Path, fixture, token, base, already: set[str]):
    def _close(code: str) -> str | None:
        return core.perform_close(
            run,
            code,
            base=base,
            token=token,
            fixture=fixture,
            already=already,
        )

    return _close


def apply_reap(run, challenges, workers, codes, fixture, token, base) -> list[str]:
    already = core.load_closed_set(run)
    actions = core.plan_reap(challenges, workers, codes=codes or None, already_closed=already)
    closer = close_fn(run, fixture, token, base, already)
    closed = []
    for action in actions:
        if action["op"] == "keep":
            print(f"keep  {action['code']} (worker still alive)")
            continue
        note = closer(action["code"])
        if note is None:
            continue
        print(f"close {action['code']} -> {note}")
        closed.append(action["code"])
    return closed


def apply_retire(run, challenges, workers, fixture, token, base) -> list[dict]:
    grace, grace_solved = core.grace_settings()
    actions = core.plan_retire(
        workers,
        challenges,
        now=core.utc_now(),
        grace=grace,
        grace_solved=grace_solved,
    )
    already = core.load_closed_set(run)
    closer = close_fn(run, fixture, token, base, already)
    done = []
    for action in actions:
        if action["op"] == "hold":
            core.append_log(
                run,
                f"hold {action['code']} ({action['state']}, grace {action['remaining']}s)",
                tag="retire",
            )
            print(f"hold {action['code']} ({action['state']}, {action['remaining']}s)")
            done.append(action)
            continue
        core.terminate_pid(action.get("pid"))
        note = closer(action["code"])
        if action.get("archive") and action.get("dir"):
            core.archive_worker(Path(action["dir"]))
        core.mark_retired(run, action["code"])
        core.append_log(run, f"retire {action['code']} ({action['state']}) close={note}", tag="retire")
        print(f"retire {action['code']} ({action['state']})")
        done.append(action)
    return done


def apply_gc(run, workers) -> list[dict]:
    alive_ids = [worker.get("session_id") or "" for worker in workers if worker.get("alive")]
    doomed = core.plan_gc_samplers(alive_ids, core.list_samplers())
    for item in doomed:
        core.terminate_pid(item.get("pid"), wait=0.2)
        core.append_log(run, f"gc sampler pid={item.get('pid')} (session={item.get('session_id')})")
        print(f"gc sampler pid={item.get('pid')}")
    return doomed


def worker_command() -> list[str] | None:
    raw = os.environ.get("CONTEST_WORKER_CMD", "").strip()
    if not raw:
        return None
    return shlex.split(raw)


def run_tick(run: Path) -> int:
    challenges, unknown, fixture, token, base = load_platform()
    workers = core.scan_workers(run)
    apply_gc(run, workers)
    workers = core.scan_workers(run)
    apply_retire(run, challenges, workers, fixture, token, base)
    workers = core.scan_workers(run)
    apply_reap(run, challenges, workers, None, fixture, token, base)
    workers = core.scan_workers(run)
    alive = sum(1 for worker in workers if worker.get("alive"))
    active = core.count_active(challenges, unknown=unknown)
    queue = run / "queue.txt"
    pending = core.queue_len(queue)
    budget = core.dispatch_budget(alive, active, core.max_active(), pending)
    core.append_log(run, f"alive_workers={alive} active_containers={active} queue_left={pending}")
    print(f"alive_workers={alive} active_containers={active} queue_left={pending} budget={budget}")
    command = worker_command()
    for _ in range(budget):
        item = core.pop_queue_line(queue)
        if item is None:
            print("queue empty")
            break
        code, brief = item
        launched = core.dispatch_worker(run, code, brief, command)
        core.append_log(run, f"dispatch {code}")
        print(f"dispatch {code} pid={launched.get('pid')}")
    return 0


def refuse_if_busy(run: Path) -> int | None:
    if not core.scheduler_busy(run):
        return None
    holder = core.read_lock_pid(run)
    return fail(f"scheduler lock held by pid={holder}; refusing a second dispatcher")


def cmd_reap(argv: list[str]) -> int:
    run = require_env()
    if run is None:
        return 2
    challenges, _unknown, fixture, token, base = load_platform()
    workers = core.scan_workers(run)
    apply_reap(run, challenges, workers, argv, fixture, token, base)
    return 0


def cmd_retire(_argv: list[str]) -> int:
    run = require_env()
    if run is None:
        return 2
    challenges, _unknown, fixture, token, base = load_platform()
    apply_retire(run, challenges, core.scan_workers(run), fixture, token, base)
    return 0


def cmd_tick(_argv: list[str]) -> int:
    run = require_env()
    if run is None:
        return 2
    refused = refuse_if_busy(run)
    if refused is not None:
        return refused
    try:
        core.acquire_lock(run)
    except core.SupervisorError as exc:
        return fail(str(exc))
    try:
        return run_tick(run)
    finally:
        core.release_lock(run)


def cmd_autosup(_argv: list[str]) -> int:
    run = require_env()
    if run is None:
        return 2
    refused = refuse_if_busy(run)
    if refused is not None:
        return refused
    try:
        core.acquire_lock(run)
    except core.SupervisorError as exc:
        return fail(str(exc))
    interval = float(os.environ.get("CONTEST_SUPERVISOR_INTERVAL", "20") or "20")
    once = os.environ.get("CONTEST_SUPERVISOR_ONCE", "").strip().lower() in ("1", "true", "yes", "on")
    try:
        while True:
            run_tick(run)
            if once:
                return 0
            time.sleep(interval)
    finally:
        core.release_lock(run)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(
            "usage: cli.py reap [unique_code...] | retire | tick | autosup\n"
            "Requires RUN, BENCHMARK_TOKEN, BENCHMARK_BASE_URL.",
            file=sys.stderr,
        )
        return 2 if not argv else 0
    command, rest = argv[0], argv[1:]
    try:
        if command == "reap":
            return cmd_reap(rest)
        if command == "retire":
            return cmd_retire(rest)
        if command == "tick":
            return cmd_tick(rest)
        if command == "autosup":
            return cmd_autosup(rest)
    except core.SupervisorError as exc:
        return fail(str(exc), 1)
    return fail(f"unknown command: {command}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
