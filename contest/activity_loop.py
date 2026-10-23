#!/usr/bin/env python3
"""FGS 活动编排器（v5.2：并发 Decide + 并行执行 + 两阶段收束 + 预算透传）。

一轮活动 = 一个一次性 `dsh` 进程，只做 Decide 或 Execute（或冷启动 Bootstrap），
进程退出即上下文销毁；唯一共享记忆是磁盘上的 FGS 图。这个脚本是 Cairn v1
Dispatcher 的移植：**它自己不做判定**，只调 `tools/activity.mjs`（kernel 规则）
并管理进程生命周期。

移植自 Cairn 的六条机制（对应 `cairn/src/cairn/dispatcher`）：

1. **单写者**：编排器在起进程前自己 claim（`tools/claim_step.mjs`），等价于
   dispatcher 的 `POST heartbeat`；插件写图时走文件锁事务（`GraphStore.transact`）。
2. **冷启动快路径**：图里只有 origin + 预种 bootstrap step 时，第一轮直接
   Bootstrap 直冲 goal（kind=bootstrap），不花一轮 Decide。
3. **Decide 优先级 / 触发**：新 Finding 或连续 K 次 Execute 后插一次 Decide
   （Cairn 的 `_reason_trigger` 计数基线；基线取「上次 Decide 跑完之后」，
   避免 Decide 自己新开的 step 触发自己）。
4. **两阶段 execute→conclude**：超时（或正常退出但没落盘）后，用同一宿主
   session（`dsh --session-id`）跑一次**收束轮**，只总结已确认内容、写 Fact 收束；
   收束失败才 release。
5. **同题并行**：最多 `--parallel` 个 Execute 同时跑；`--concurrent-decide`
   打开后 Decide 是独立 slot，不等 Execute 清空（v5.1 默认仍是串行 Decide）。
6. **预告知的 deadline override**：把 `FGS_BUDGET_MS` 透传给插件写进上下文；
   收束轮由进程边界强制执行。

用法::

    python3 contest/activity_loop.py --cwd /path/ws --problem-id demo \
        [--dsh-bin dsh] [--profile headless] [--parallel 2] \
        [--max-activities 24] [--budget-sec 1800] [--activity-timeout-sec 600] \
        [--conclude-timeout-sec 120] [--decide-every 3] \
        [--concurrent-decide] [--decide-timeout-sec 300] [--max-decides 12] \
        [--rebase-mode append|full] [--worker-cmd "<cmd>"] [--dry-run]

退出摘要写到 `<cwd>/<state-dir>/orchestrator-exit.json`，逐轮台账写到
`<cwd>/<state-dir>/orchestrator.jsonl`（两本账都用 runId 对齐）。
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ACTIVITY_CLI = ROOT / "tools" / "activity.mjs"
CLAIM_CLI = ROOT / "tools" / "claim_step.mjs"
RELEASE_CLI = ROOT / "tools" / "release_step.mjs"

DEFAULT_MAX_ACTIVITIES = 24
DEFAULT_BUDGET_SEC = 1800
DEFAULT_ACTIVITY_TIMEOUT_SEC = 600
DEFAULT_CONCLUDE_TIMEOUT_SEC = 120
DEFAULT_DECIDE_TIMEOUT_SEC = 300
DEFAULT_MAX_DECIDES = 12
DEFAULT_DECIDE_EVERY = 3
DEFAULT_PARALLEL = 2
DEFAULT_WAIT_RETRY = 3
TERMINATE_GRACE_SEC = 15

ACTIVITY_PROMPT = {
    "decide": (
        "执行本轮 Decide：只做规划/改图（FGS 图工具），不要做环境动作。\n"
        "按系统提示里的活动规则执行：fgs_commit 成功落盘后本轮即结束，直接结束回合。\n"
        "没有要改的就直接结束回合，不要为了调用工具而调用。\n"
    ),
    "execute": (
        "执行本轮 Execute：只推进指定的那一个 step。\n"
        "流程：fgs_submit_fact 写本轮新 Fact（无产出也要写显式失败/观察 Fact）→ fgs_commit_step 收束。\n"
        "commit_step 成功后本轮即结束，直接结束回合。\n"
    ),
    "bootstrap": (
        "执行本轮 Bootstrap：冷启动直冲 goal_final，不做规划。\n"
        "流程：fgs_submit_fact 写本轮 Fact → fgs_commit_step 收束；\n"
        "若这条 Fact 就是 goal 的见证（flag / 利用成功证据），收束后立刻 fgs_satisfy_goal。\n"
        "拿不到见证也必须落一条显式观察 Fact，不要空手退出。\n"
    ),
    "conclude": (
        "收束轮（conclude）：上一轮活动超时了。\n"
        "立即停止探索：不跑新命令、不开新方向、不做新的利用尝试。\n"
        "只把已经确认的观察与结论写成这一条 Fact，然后 fgs_commit_step 收束。\n"
        "本轮覆盖之前的一切指令，直接交付已有结论。\n"
    ),
}


class LoopError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"activity: {message}", file=sys.stderr)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def run_cli(command: list[str]) -> dict:
    """跑一个 kernel CLI（activity / claim / release），返回它最后一行的 JSON。"""
    proc = subprocess.run(command, capture_output=True, text=True, cwd=str(ROOT), check=False)
    stdout = (proc.stdout or "").strip()
    if proc.returncode != 0 or not stdout:
        detail = (proc.stderr or stdout or "无输出").strip()
        raise LoopError(f"{Path(command[1]).name} 失败: {detail}")
    try:
        return json.loads(stdout.splitlines()[-1])
    except json.JSONDecodeError as exc:
        raise LoopError(f"{Path(command[1]).name} 输出不是 JSON: {stdout!r}") from exc


def pick_activity(
    cwd: Path,
    problem_id: str,
    *,
    state_dir: str,
    last_signature: str | None,
    no_progress: int,
    lease_ms: int,
    activities_left: int,
    allow_decide_repeat: bool,
    findings_at_last_decide: int | None = None,
    executes_since_decide: int = 0,
    decide_every: int = DEFAULT_DECIDE_EVERY,
    node_bin: str = "node",
) -> dict:
    """调用 kernel 的 CLI 选活动；这是编排器唯一的判定入口。"""
    command = [
        node_bin, str(ACTIVITY_CLI),
        "--cwd", str(cwd),
        "--problem-id", problem_id,
        "--state-dir", state_dir,
        "--no-progress", str(no_progress),
        "--activities-left", str(activities_left),
        "--lease-ms", str(lease_ms),
        "--executes-since-decide", str(executes_since_decide),
        "--decide-every", str(decide_every),
    ]
    if last_signature:
        command.extend(["--last-signature", last_signature])
    if findings_at_last_decide is not None:
        command.extend(["--findings-at-last-decide", str(findings_at_last_decide)])
    if allow_decide_repeat:
        command.append("--allow-decide-repeat")
    payload = run_cli(command)
    if not payload.get("ok"):
        raise LoopError(f"选活动失败: {payload.get('error')}")
    return payload


def write_prompt(cwd: Path, activity: str, step_id: str | None, run_id: str) -> Path:
    prompt = cwd / ("prompt-conclude.txt" if activity == "conclude" else "prompt.txt")
    text = ACTIVITY_PROMPT.get(activity, ACTIVITY_PROMPT["decide"])
    if step_id:
        text += f"\n（本轮 step: {step_id}；step 已在启动时认领，直接执行。）\n"
    text += f"\nrun: {run_id}\n"
    prompt.write_text(text, encoding="utf-8")
    return prompt


def child_command(args, prompt: Path, *, session_id: str | None = None) -> list[str]:
    if args.worker_cmd:
        return [*shlex.split(args.worker_cmd), str(prompt)]
    command = [args.dsh_bin, "--profile", args.profile, "--json"]
    if session_id:
        # dsh headless 的 `--session-id` 是「接管已存在的 Session」：收束轮靠它续跑同一会话。
        command.extend(["--session-id", session_id])
    command.append(str(prompt))
    return command


def run_child(command: list[str], *, cwd: Path, env: dict, timeout_sec: float) -> tuple[int, bool, float]:
    """跑一个活动进程；超时先 SIGTERM（插件会落台账/兜底），宽限后强杀。"""
    started = time.monotonic()
    proc = subprocess.Popen(command, cwd=str(cwd), env=env)
    timed_out = False
    try:
        code = proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.terminate()
        try:
            code = proc.wait(timeout=TERMINATE_GRACE_SEC)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = proc.wait()
    return code, timed_out, round((time.monotonic() - started) * 1000)


def plugin_ledger_for(cwd: Path, problem_id: str, state_dir: str, run_id: str) -> dict | None:
    """读某个 runId 的插件台账（并行时不能用「最后一行」，那可能是别的 slot）。"""
    path = cwd / state_dir / "projects" / problem_id / "activity.jsonl"
    if not path.is_file():
        return None
    try:
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except OSError:
        return None
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("runId") == run_id:
            return record
    return None


def claim_step(
    cwd: Path, problem_id: str, state_dir: str, step_id: str, owner: str,
    node_bin: str, lease_ms: int,
) -> dict:
    """编排器预认领（Cairn：dispatcher 先 heartbeat 认领，再派 worker）。"""
    command = [
        node_bin, str(CLAIM_CLI),
        "--cwd", str(cwd),
        "--problem-id", problem_id,
        "--state-dir", state_dir,
        "--step", step_id,
        "--owner", owner,
        "--lease-ms", str(lease_ms),
    ]
    try:
        payload = run_cli(command)
    except LoopError as exc:
        log(f"claim_step 失败: {exc}")
        return {"ok": False, "error": str(exc)}
    if payload.get("claimed"):
        log(f"已预认领 {step_id}（owner={owner}）")
    elif payload.get("skipped"):
        log(f"跳过 {step_id}（{payload.get('skipped')}）")
    return payload


def release_claim(
    cwd: Path, problem_id: str, state_dir: str, step_id: str, owner: str,
    node_bin: str, reason: str,
) -> dict:
    """回收一个死 run 认领的 step（幂等；step 已 done/owner 已变则 no-op）。"""
    command = [
        node_bin, str(RELEASE_CLI),
        "--cwd", str(cwd),
        "--problem-id", problem_id,
        "--state-dir", state_dir,
        "--step", step_id,
        "--owner", owner,
        "--reason", reason,
    ]
    try:
        payload = run_cli(command)
    except LoopError as exc:
        log(f"release_claim 失败: {exc}")
        return {"ok": False, "error": str(exc)}
    if payload.get("released"):
        log(f"已回收 {step_id}（owner={owner}）→ fact={payload.get('factId')}")
    return payload


def mark_deferred(cwd: Path, problem_id: str, state_dir: str, reason: str) -> None:
    """让 supervisor 的 plan_retire 看到 deferred（它只读 meta.json 的 state）。"""
    path = cwd / state_dir / "projects" / problem_id / "meta.json"
    meta: dict = {}
    if path.is_file():
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
    if not isinstance(meta, dict):
        meta = {}
    meta.update({
        "id": problem_id,
        "title": meta.get("title") or problem_id,
        "state": "deferred",
        "deferredAt": utc_now(),
        "deferredReason": reason,
        "updatedAt": utc_now(),
    })
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def stop(cwd: Path, problem_id: str, state_dir: str, payload: dict) -> dict:
    marker = cwd / state_dir / "orchestrator-exit.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    merged = {"at": utc_now(), "problemId": problem_id, **payload}
    marker.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return merged


def activity_env(args, cwd: Path, problem_id: str, kind: str, run_id: str,
                 step_id: str | None, *, conclude: bool = False,
                 budget_ms: float | None = None, rebase: bool = False) -> dict:
    env = dict(os.environ)
    env.update({
        "FGS_ACTIVITY": kind,
        "FGS_RUN_ID": run_id,
        "FGS_WORKSPACE": str(cwd),
        "FGS_PROBLEM_ID": problem_id,
        "FGS_STATE_DIR": args.state_dir,
        # 选择器与插件必须用同一个租约值，否则会出现「选择器说可接手、插件说被持有」。
        "FGS_LEASE_MS": str(args.lease_ms),
        # 预告知的 deadline override：插件把预算写进上下文（Cairn 只预告、不给时间）。
        # Decide 用独立墙钟（--decide-timeout-sec），不与 Execute 的 activity_timeout 混用。
        "FGS_BUDGET_MS": str(int(budget_ms if budget_ms else float(args.activity_timeout_sec) * 1000)),
    })
    # v5.2：rebase 只给 Decide run 注入；其它活动必须显式清掉（避免从父进程继承）。
    if rebase:
        env["FGS_REBASE"] = "1"
        env["FGS_REBASE_MODE"] = args.rebase_mode
    else:
        env.pop("FGS_REBASE", None)
        env.pop("FGS_REBASE_MODE", None)
    if step_id:
        env["FGS_STEP"] = step_id
    else:
        env.pop("FGS_STEP", None)
    if conclude:
        env["FGS_CONCLUDE"] = "1"
        # 收束轮如果再超时，走 release（追加未完成 Fact）；不要在信号兜底里抢先写模板 Fact。
        env["FGS_SUPPRESS_SIGNAL_FLUSH"] = "1"
    else:
        env.pop("FGS_CONCLUDE", None)
        # 首轮超时由编排器起收束轮；信号兜底只能写台账，不能把 step 收成 done。
        if args.conclude_timeout_sec > 0:
            env["FGS_SUPPRESS_SIGNAL_FLUSH"] = "1"
        else:
            env.pop("FGS_SUPPRESS_SIGNAL_FLUSH", None)
    return env


def run_conclude(args, cwd: Path, problem_id: str, slot: dict, session_id: str) -> dict:
    """两阶段收束：同 session 续跑一次，只交付已确认内容。

    Cairn 在 explore/bootstrap 超时（或正常退出但 JSON 不合法）后这样做：
    先杀主进程，再用同一 CLI session 发一条独立的 conclude prompt。
    """
    run_id = slot["runId"]
    prompt = write_prompt(cwd, "conclude", slot.get("stepId"), run_id)
    command = child_command(args, prompt, session_id=session_id)
    if args.dry_run:
        return {"ok": True, "dryRun": True}
    log(f"{run_id}: 起收束轮（session={session_id}）")
    code, timed_out, duration_ms = run_child(
        command, cwd=cwd,
        env=activity_env(args, cwd, problem_id, slot["kind"], run_id, slot.get("stepId"), conclude=True),
        timeout_sec=args.conclude_timeout_sec,
    )
    ledger = plugin_ledger_for(cwd, problem_id, args.state_dir, run_id)
    outcome = (ledger or {}).get("outcome")
    return {
        "ok": outcome == "committed",
        "exitCode": code,
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "pluginOutcome": outcome,
    }


def next_run_id(problem_id: str, activities: int, kind: str) -> str:
    return f"{problem_id}-{activities:02d}-{kind}"


def finish_slot(args, cwd: Path, problem_id: str, ledger: Path, slot: dict, *,
                activities: int, elapsed: float, counters: dict) -> dict:
    """收尾一个已结束的 slot：判定 →（必要时）收束轮 → 回收 → 台账 → 计数。"""
    code, timed_out, duration_ms = slot["result"]
    run_id = slot["runId"]
    step_id = slot.get("stepId")
    ledger_record = plugin_ledger_for(cwd, problem_id, args.state_dir, run_id)
    outcome = (ledger_record or {}).get("outcome")
    session_id = (ledger_record or {}).get("sessionId")
    conclude: dict | None = None
    recovered = None

    # Cairn 的 fallback 触发条件：超时，或正常退出但没有产出（解析/契约失败）。
    # 其它非零退出不救援（可能是环境/网关问题，直接回收）。
    if step_id and args.conclude_timeout_sec > 0 and (timed_out or (code == 0 and outcome != "committed")):
        if session_id:
            conclude = run_conclude(args, cwd, problem_id, slot, session_id)
        else:
            log(f"{run_id}: 无 sessionId，跳过收束轮（插件台账没有登记宿主 session）")

    effective_outcome = (conclude or {}).get("pluginOutcome") or outcome
    if step_id and effective_outcome != "committed":
        recovered = release_claim(
            cwd, problem_id, args.state_dir, step_id, run_id,
            args.node_bin, "活动超时" if timed_out else f"exit={code}",
        )

    record = {
        "at": utc_now(),
        "runId": run_id,
        "activity": slot["kind"],
        "stepId": step_id,
        "signatureBefore": slot.get("signatureBefore"),
        "exitCode": code,
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "pluginOutcome": outcome,
        "conclude": conclude,
        "released": recovered,
        "repo": "contest/activity_loop.py",
    }
    append_jsonl(ledger, record)

    if slot["kind"] == "decide":
        # Cairn 的 checkpoint 只在 reason 成功时更新；这里「成功」的判据是图签名真的变了。
        after = (ledger_record or {}).get("signature")
        if after and after == slot.get("signatureBefore"):
            counters["no_progress"] += 1
        else:
            counters["no_progress"] = 0
        counters["executes_since_decide"] = 0
        counters["findings_at_last_decide"] = None  # 用下一次 pick 的实际读数补齐
    else:
        counters["executes_since_decide"] += 1

    if timed_out:
        log(f"{run_id}: 活动超时（{args.activity_timeout_sec}s）")
    if code != 0 and not timed_out:
        log(f"{run_id}: 子进程 exit={code}（继续下一轮，单轮失败不终止整题）")
    if conclude:
        log(f"{run_id}: 收束轮 {'成功' if conclude.get('ok') else '失败'}")
    return record


def finish_decide(args, cwd: Path, problem_id: str, ledger: Path, slot: dict, *,
                  counters: dict) -> dict:
    """收尾一个并发 Decide slot（v5.2）。

    Decide 不认领 step、不写 Fact，失败/超时图零改动；这里只补台账与计数基线。
    Cairn 语义：`findings_at_last_decide` 取**派发时**的计数，这样 Decide 期间
    Execute 新落的 Finding 仍在基线之上，Decide 一结束就会再次被触发；而 Decide
    自己开的 step 不会触发自己。
    """
    code, timed_out, duration_ms = slot["result"]
    run_id = slot["runId"]
    record = plugin_ledger_for(cwd, problem_id, args.state_dir, run_id) or {}
    rev_before, rev_after = record.get("revBefore"), record.get("revAfter")
    if rev_before and rev_before == rev_after:
        counters["no_progress"] += 1
    else:
        counters["no_progress"] = 0
    counters["findings_at_last_decide"] = int((slot.get("counts") or {}).get("findings") or 0)
    row = {
        "at": utc_now(),
        "runId": run_id,
        "activity": "decide",
        "stepId": None,
        "signatureBefore": slot.get("signatureBefore"),
        "exitCode": code,
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "pluginOutcome": record.get("outcome"),
        "startedWhileExecutes": slot.get("startedWhileExecutes", 0),
        "concurrentWithExecutes": slot.get("startedWhileExecutes", 0) > 0,
        "revBefore": rev_before,
        "revAfter": rev_after,
        "applied": record.get("applied"),
        "rejected": record.get("rejected"),
        "repo": "contest/activity_loop.py",
    }
    append_jsonl(ledger, row)
    if timed_out:
        log(f"{run_id}: Decide 超时（{args.decide_timeout_sec}s）")
    elif code != 0:
        log(f"{run_id}: Decide exit={code}（图零改动，继续下一轮）")
    return row


def run_loop(args) -> dict:
    cwd = Path(args.cwd).resolve()
    problem_id = args.problem_id
    ledger = cwd / args.state_dir / "orchestrator.jsonl"
    deadline = time.monotonic() + args.budget_sec
    counters = {
        "executes_since_decide": 0,
        "findings_at_last_decide": None,
        "no_progress": 0,
        "last_signature": None,
        "decides": 0,
    }
    state: dict = {"activities": 0, "wait_retries": 0}
    slots: dict[Future, dict] = {}
    # v5.2：Decide 是独立 slot（与 Execute 并发）；同一时刻最多一个。
    decide_slot: dict | None = None
    decide_future: Future | None = None
    # 池子多留一个 worker 给 Decide：否则 slot 填满时 Decide 会在队列里排到 Execute 结束，
    # 并发就退化成了串行（Execute 数量仍由 slots 的容量控制）。
    workers = max(1, args.parallel) + (1 if args.concurrent_decide else 0)
    pool = ThreadPoolExecutor(max_workers=workers)

    def elapsed() -> float:
        return args.budget_sec - max(0.0, deadline - time.monotonic())

    def stop_with(outcome: str, reason: str, **extra) -> dict:
        # 还在跑的 slot 先等它们结束：既要避免半截进程继续写图，也要把它们的
        # 台账/回收补齐（否则并行时最后一两个 slot 会从 orchestrator.jsonl 里消失）。
        if slots:
            log(f"停止前等待 {len(slots)} 个进行中的活动结束")
            wait(list(slots), timeout=args.activity_timeout_sec + TERMINATE_GRACE_SEC)
            for fut in list(slots):
                slot = slots.pop(fut)
                try:
                    slot["result"] = fut.result() if fut.done() else (-1, True, 0)
                except Exception as exc:  # noqa: BLE001
                    slot["result"] = (-1, False, 0)
                    log(f"{slot['runId']}: 子进程异常 {exc}")
                finish_slot(
                    args, cwd, problem_id, ledger, slot,
                    activities=state["activities"], elapsed=elapsed(), counters=counters,
                )
        # Decide 最后收：它可能在写图，先让 Execute 落完盘再等它。
        if decide_future is not None:
            log("停止前等待进行中的 Decide 结束")
            wait([decide_future], timeout=args.decide_timeout_sec + TERMINATE_GRACE_SEC)
            finish_decide_future()
        payload = {
            "outcome": outcome, "reason": reason, "activities": state["activities"],
            "elapsedSec": round(elapsed()), **extra,
        }
        return stop(cwd, problem_id, args.state_dir, payload)

    def reap() -> None:
        if not slots:
            return
        done, _ = wait(list(slots), timeout=0, return_when=FIRST_COMPLETED)
        for fut in done:
            slot = slots.pop(fut)
            try:
                slot["result"] = fut.result()
            except Exception as exc:  # noqa: BLE001 - 子进程异常不应终止整题
                slot["result"] = (-1, False, 0)
                log(f"{slot['runId']}: 子进程异常 {exc}")
            finish_slot(
                args, cwd, problem_id, ledger, slot,
                activities=state["activities"], elapsed=elapsed(), counters=counters,
            )

    def pick() -> dict:
        activity = pick_activity(
            cwd, problem_id,
            state_dir=args.state_dir,
            last_signature=counters["last_signature"],
            no_progress=counters["no_progress"],
            lease_ms=args.lease_ms,
            activities_left=args.max_activities - state["activities"],
            allow_decide_repeat=args.decide_repeat,
            findings_at_last_decide=counters["findings_at_last_decide"],
            executes_since_decide=counters["executes_since_decide"],
            decide_every=args.decide_every,
            node_bin=args.node_bin,
        )
        counters["last_signature"] = activity.get("signature") or counters["last_signature"]
        counts = activity.get("counts") or {}
        if counters["findings_at_last_decide"] is None:
            counters["findings_at_last_decide"] = int(counts.get("findings") or 0)
        return activity

    def dispatch(activity: dict) -> bool:
        kind = activity.get("kind")
        step_id = activity.get("stepId")
        run_id = next_run_id(problem_id, state["activities"] + 1, kind)
        prompt = write_prompt(cwd, kind, step_id, run_id)
        command = child_command(args, prompt)
        if args.dry_run:
            # 只读演练：不认领、不写图、不写台账（否则下一次决策会被自己的假认领挡住）。
            state["activities"] += 1
            print(json.dumps({"dryRun": True, "activity": kind, "stepId": step_id,
                              "runId": run_id, "command": command}, ensure_ascii=False), file=sys.stderr)
            return True
        # Cairn：dispatcher 先认领，再派 worker。
        if step_id:
            claim = claim_step(cwd, problem_id, args.state_dir, step_id, run_id,
                               args.node_bin, args.lease_ms)
            if not claim.get("claimed"):
                return False
        state["activities"] += 1
        log(f"{state['activities']}: {kind}{f' {step_id}' if step_id else ''} run={run_id}")
        future = pool.submit(
            run_child, command, cwd=cwd,
            env=activity_env(args, cwd, problem_id, kind, run_id, step_id),
            timeout_sec=args.activity_timeout_sec,
        )
        slots[future] = {
            "runId": run_id, "kind": kind, "stepId": step_id,
            "signatureBefore": activity.get("signature"),
        }
        return True

    def wait_one() -> None:
        if not slots:
            return
        done, _ = wait(list(slots), timeout=1.0, return_when=FIRST_COMPLETED)
        for fut in done:
            slot = slots.pop(fut)
            try:
                slot["result"] = fut.result()
            except Exception as exc:  # noqa: BLE001
                slot["result"] = (-1, False, 0)
                log(f"{slot['runId']}: 子进程异常 {exc}")
            finish_slot(
                args, cwd, problem_id, ledger, slot,
                activities=state["activities"], elapsed=elapsed(), counters=counters,
            )

    # ---- v5.2 并发 Decide（--concurrent-decide）----
    def finish_decide_future() -> None:
        """收尾已到期的 decide_future（台账 + 计数基线），并清空 Decide slot。"""
        nonlocal decide_future, decide_slot
        future, slot = decide_future, decide_slot
        if future is None:
            return
        try:
            result = future.result() if future.done() else (-1, True, 0)
        except Exception as exc:  # noqa: BLE001 - Decide 崩溃不应终止整题
            result = (-1, False, 0)
            log(f"{slot['runId'] if slot else 'decide'}: 子进程异常 {exc}")
        decide_future = None
        decide_slot = None
        if slot is not None:
            finish_decide(args, cwd, problem_id, ledger, {**slot, "result": result},
                          counters=counters)

    def reap_decide() -> None:
        if decide_future is not None and wait([decide_future], timeout=0)[0]:
            finish_decide_future()

    def wait_decide() -> None:
        # 最多阻塞 1s：期间 Execute 完蛋也要能尽快被 reap（下一轮循环开头）。
        if decide_future is not None and wait([decide_future], timeout=1.0)[0]:
            finish_decide_future()

    def dispatch_decide(activity: dict) -> bool:
        """派发一个 Decide run：不认领 step、不写图，独立墙钟（--decide-timeout-sec）。"""
        nonlocal decide_future, decide_slot
        run_id = next_run_id(problem_id, state["activities"] + 1, "decide")
        prompt = write_prompt(cwd, "decide", None, run_id)
        command = child_command(args, prompt)
        state["activities"] += 1
        counters["decides"] += 1
        counters["executes_since_decide"] = 0  # 派发即清零（Decide 已排上队）
        if args.dry_run:
            print(json.dumps({"dryRun": True, "activity": "decide", "stepId": None,
                              "runId": run_id, "command": command}, ensure_ascii=False),
                  file=sys.stderr)
            return True
        log(f"{state['activities']}: decide run={run_id}（并发，slots={len(slots)}）")
        decide_future = pool.submit(
            run_child, command, cwd=cwd,
            env=activity_env(args, cwd, problem_id, "decide", run_id, None,
                             budget_ms=float(args.decide_timeout_sec) * 1000, rebase=True),
            timeout_sec=args.decide_timeout_sec,
        )
        decide_slot = {
            "runId": run_id, "kind": "decide", "stepId": None,
            "signatureBefore": activity.get("signature"),
            "startedWhileExecutes": len(slots),
            "counts": activity.get("counts") or {},
        }
        return True

    def dispatch_candidate(activity: dict) -> bool:
        """Decide 在跑时用 executeCandidate 继续填 slot（候选 step 来自同一次 pick）。"""
        candidate = activity.get("executeCandidate")
        if not candidate:
            return False
        return dispatch({"kind": "execute", "stepId": candidate,
                         "signature": activity.get("signature")})

    def handle_terminal(activity: dict) -> dict | None:
        kind = activity.get("kind")
        if kind == "done":
            return stop_with("done", str(activity.get("reason")), signature=activity.get("signature"))
        if kind == "defer":
            mark_deferred(cwd, problem_id, args.state_dir,
                          str(activity.get("reason") or "no-progress"))
            return stop_with("deferred", str(activity.get("reason")),
                             signature=activity.get("signature"))
        if kind == "budget":
            return stop_with("budget", str(activity.get("reason")),
                             signature=activity.get("signature"))
        return None

    def advance_concurrent() -> dict | None:
        """v5.2 状态机：Decide 是独立 slot，不再等 Execute 清空。"""
        parallel = max(1, args.parallel)
        activity = pick()
        kind = activity.get("kind")

        # ① Decide：立即派发，不等 slot 清空；同一时刻最多一个。
        if kind == "decide":
            if decide_future is None:
                if counters["decides"] < args.max_decides:
                    dispatch_decide(activity)
                    state["wait_retries"] = 0
                    return None
                # max-decides 用尽：题还在跑，只是不再规划 —— 有候选就继续执行。
                if len(slots) < parallel and dispatch_candidate(activity):
                    state["wait_retries"] = 0
                    return None
                if not slots:
                    # 与 v5.1 的 defer 语义对齐：规划预算耗尽且无候选 = 本轮无法再推进，
                    # 标记 deferred 让调度方退役本 worker（而不是留一个永远不再规划的空转体）。
                    mark_deferred(cwd, problem_id, args.state_dir,
                                  "Decide 次数用尽（max-decides）")
                    return stop_with("deferred", "Decide 次数用尽（max-decides）",
                                     signature=activity.get("signature"))
                wait_one()
                return None
            # Decide 正在跑：用 executeCandidate 继续填 slot；没有就等它。
            if len(slots) < parallel and dispatch_candidate(activity):
                state["wait_retries"] = 0
                return None
            wait_decide()
            return None

        # ② Execute / Bootstrap：Decide 在跑也照常派发。
        if kind in ("execute", "bootstrap"):
            if len(slots) < parallel:
                if dispatch(activity):
                    state["wait_retries"] = 0
                    return None
                # 认领失败（被抢/写图失败）：歇一下再重选。
                if slots:
                    wait_one()
                else:
                    time.sleep(0.2)
                return None
            wait_one()
            return None

        # ③ 终态：Decide 在跑就先等它（它可能在写图）。
        if decide_future is not None:
            wait_decide()
            return None
        terminal = handle_terminal(activity)
        if terminal is not None:
            return terminal

        # wait：没有可派发 step（都在租约内）
        if slots:
            wait_one()
            return None
        state["wait_retries"] += 1
        if state["wait_retries"] > args.wait_retry:
            return stop_with("wait", str(activity.get("reason")),
                             signature=activity.get("signature"))
        log(f"wait: {activity.get('reason')}")
        time.sleep(args.wait_seconds)
        return None

    try:
        while True:
            # ---- 预算 ----
            if args.max_activities - state["activities"] <= 0:
                return stop_with("budget", "活动数用尽")
            if time.monotonic() >= deadline:
                return stop_with("budget", "墙钟预算用尽")

            reap()
            reap_decide()

            if args.concurrent_decide:
                terminal = advance_concurrent()
                if terminal is not None:
                    return terminal
                continue

            # ---- Decide 只能在「没有 Execute 在跑」时进行（Cairn：reason 串行）----
            if not slots:
                activity = pick()
                kind = activity.get("kind")
                if kind == "done":
                    return stop_with("done", str(activity.get("reason")), signature=activity.get("signature"))
                if kind == "defer":
                    mark_deferred(cwd, problem_id, args.state_dir,
                                  str(activity.get("reason") or "no-progress"))
                    return stop_with("deferred", str(activity.get("reason")),
                                     signature=activity.get("signature"))
                if kind == "budget":
                    return stop_with("budget", str(activity.get("reason")),
                                     signature=activity.get("signature"))
                if kind == "decide":
                    state["wait_retries"] = 0
                    if not dispatch(activity):
                        raise LoopError("Decide 派发失败")
                    wait_one()
                    continue

            # ---- 并行 Execute：填满 slot ----
            dispatched = False
            while len(slots) < max(1, args.parallel):
                activity = pick()
                kind = activity.get("kind")
                if kind in ("execute", "bootstrap", "decide", "wait"):
                    if kind == "decide":
                        break  # 等 slot 清空后再 Decide
                    if kind == "wait":
                        break
                    if not dispatch(activity):
                        break
                    dispatched = True
                    continue
                # 终态：等 slot 清空后由上面的分支处理
                break

            if slots:
                wait_one()
                continue

            if dispatched:
                continue

            # 没有 slot、也派不出去：只剩 wait / 终态，按 wait 退避处理。
            activity = pick()
            kind = activity.get("kind")
            if kind in ("done", "defer", "budget"):
                if kind == "done":
                    return stop_with("done", str(activity.get("reason")),
                                     signature=activity.get("signature"))
                if kind == "defer":
                    mark_deferred(cwd, problem_id, args.state_dir,
                                  str(activity.get("reason") or "no-progress"))
                    return stop_with("deferred", str(activity.get("reason")),
                                     signature=activity.get("signature"))
                return stop_with("budget", str(activity.get("reason")),
                                 signature=activity.get("signature"))
            state["wait_retries"] += 1
            if state["wait_retries"] > args.wait_retry:
                return stop_with("wait", str(activity.get("reason")),
                                 signature=activity.get("signature"))
            log(f"wait: {activity.get('reason')}")
            time.sleep(args.wait_seconds)
    finally:
        pool.shutdown(wait=False)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FGS activity-run orchestrator")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--problem-id", required=True)
    parser.add_argument("--state-dir", default=".fgs")
    parser.add_argument("--profile", default=os.environ.get("CONTEST_DSH_PROFILE", "headless"))
    parser.add_argument("--dsh-bin", default=os.environ.get("CONTEST_DSH_BIN", "dsh"))
    parser.add_argument("--node-bin", default=os.environ.get("FGS_NODE_BIN", "node"))
    parser.add_argument("--worker-cmd", default=os.environ.get("CONTEST_WORKER_CMD", ""))
    parser.add_argument("--max-activities", type=int, default=DEFAULT_MAX_ACTIVITIES)
    parser.add_argument("--budget-sec", type=float, default=DEFAULT_BUDGET_SEC)
    parser.add_argument("--activity-timeout-sec", type=float, default=DEFAULT_ACTIVITY_TIMEOUT_SEC)
    parser.add_argument("--conclude-timeout-sec", type=float, default=DEFAULT_CONCLUDE_TIMEOUT_SEC,
                        help="两阶段收束轮的墙钟（<=0 关闭收束轮，退回「超时即 release」）")
    parser.add_argument("--decide-every", type=int, default=DEFAULT_DECIDE_EVERY,
                        help="每 K 次 Execute 后插一次 Decide（0 = 只在任务池空/新 Finding 时 Decide）")
    parser.add_argument("--parallel", type=int, default=DEFAULT_PARALLEL,
                        help="同一题并行 Execute 的上限（并发 Decide 需 --concurrent-decide）")
    parser.add_argument("--concurrent-decide", action="store_true",
                        help="Decide 与 Execute 并发（v5.2；默认关 = v5.1 串行 Decide）")
    parser.add_argument("--decide-timeout-sec", type=float, default=DEFAULT_DECIDE_TIMEOUT_SEC,
                        help="Decide 的独立墙钟（不占 --activity-timeout-sec）")
    parser.add_argument("--max-decides", type=int, default=DEFAULT_MAX_DECIDES,
                        help="单题 Decide 次数上限；超限后只执行/收尾，不再规划")
    parser.add_argument("--rebase-mode", choices=("append", "full"), default="full",
                        help="Decide commit 的 rebase 档位：append = 只允许 append-only op")
    parser.add_argument("--lease-ms", type=int, default=None,
                        help="step 认领租约（默认 = 活动超时 + 120s；选择器与插件共用）")
    parser.add_argument("--wait-retry", type=int, default=DEFAULT_WAIT_RETRY)
    parser.add_argument("--wait-seconds", type=float, default=15.0)
    parser.add_argument("--decide-repeat", action="store_true",
                        help="允许图没变时重复 Decide（默认不空转，直接 defer）")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.lease_ms is None:
        # 租约只需覆盖「一个活动最长能活多久」，再留 2 分钟让信号兜底/收束轮跑完。
        activity_span = max(float(args.activity_timeout_sec), float(args.conclude_timeout_sec))
        args.lease_ms = int(max(300.0, activity_span + 120.0) * 1000)
    args.parallel = max(1, int(args.parallel))
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        result = run_loop(args)
    except LoopError as exc:
        log(str(exc))
        cwd = Path(args.cwd).resolve()
        stop(cwd, args.problem_id, args.state_dir, {"outcome": "error", "reason": str(exc)})
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
