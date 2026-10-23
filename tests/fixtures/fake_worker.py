#!/usr/bin/env python3
"""测试夹具：假的「一个活动 run」。

两种场景格式：
- 数组：按 cwd/fake_calls.txt 的计数取第 N 个动作（串行路径）。
- 对象：{ "<stepId>": 动作, "decide": 动作, "conclude": 动作, "default": 动作 }，按
  FGS_ACTIVITY / FGS_STEP / FGS_CONCLUDE 选动作（并行与并发 Decide 测试用，避免计数竞争）。

支持：动作里的 sleep（秒，模拟超时）、findingType（submit_fact 落 Finding）、
record=false（本轮不写 activity.jsonl，模拟「超时前没来得及落台账」）、
FAKE_SLEEP（全局 sleep）、FAKE_EXIT（非零退出码）、
FAKE_RECORD=1（像真实插件一样往 activity.jsonl 落一条台账，含 sessionId）、
FAKE_DUMP（把本轮 env + 图上的 owner 落到文件，验证「先认领再起进程」与 Decide env）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
APPLY = Path(__file__).resolve().parent / "apply_op.mjs"


def graph_owner(cwd: Path) -> str | None:
    """读图里 FGS_STEP 的 owner（验证编排器在起进程前就认领了）。"""
    import re

    step_id = os.environ.get("FGS_STEP")
    if not step_id:
        return None
    path = cwd / os.environ.get("FGS_STATE_DIR", ".fgs") / "projects" / os.environ.get("FGS_PROBLEM_ID", "demo") / "graph.yaml"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8")
    block = re.search(
        rf'id: "?{re.escape(step_id)}"?\n(?:.*\n)*?\s*owner: ["\']?([^"\'\n]+)',
        text,
    )
    return block.group(1).strip() if block else None


def main() -> int:
    cwd = Path.cwd()
    counter = cwd / "fake_calls.txt"
    calls = int(counter.read_text().strip()) if counter.is_file() else 0
    counter.write_text(str(calls + 1))

    scenario = json.loads(os.environ.get("FAKE_SCENARIO", "[]"))
    if isinstance(scenario, dict):
        if os.environ.get("FGS_ACTIVITY") == "decide":
            action = scenario.get("decide") or scenario.get("default") or {"kind": "noop"}
        elif os.environ.get("FGS_CONCLUDE") == "1":
            action = scenario.get("conclude") or {"kind": "noop"}
        else:
            action = scenario.get(os.environ.get("FGS_STEP") or "") or scenario.get("default") or {"kind": "noop"}
    else:
        action = scenario[calls] if calls < len(scenario) else {"kind": "noop"}

    command = [
        "node", str(APPLY),
        "--cwd", str(cwd),
        "--problem-id", os.environ.get("FGS_PROBLEM_ID", "demo"),
        "--state-dir", os.environ.get("FGS_STATE_DIR", ".fgs"),
    ]
    kind = action.get("kind", "noop")
    if kind == "open_step":
        command += ["open_step", "--action", action.get("action", "侦察"),
                    "--from", action.get("from", "fact_origin")]
    elif kind == "submit_fact":
        command += ["submit_fact", "--step", action["step"],
                    "--title", action.get("title", "产出"), "--content", action.get("content", "c")]
        if action.get("findingType"):
            command += ["--finding-type", str(action["findingType"])]
    elif kind == "satisfy_goal":
        command += ["satisfy_goal", "--goal", "goal_final", "--reason", "夹具完成",
                    "--by", action["by"]]
    elif kind == "noop":
        pass
    else:
        print(f"fake_worker: 未知动作 {kind}", file=sys.stderr)
        return 2

    if kind != "noop":
        proc = subprocess.run(command, capture_output=True, text=True, cwd=str(ROOT))
        if proc.returncode != 0:
            print(f"fake_worker: apply_op 失败: {proc.stderr.strip()}", file=sys.stderr)
            return proc.returncode

    # 落台账：真实插件在回合收口/信号兜底时写 activity.jsonl。
    # record=false：模拟 Decide 超时被杀、还没来得及落台账（编排器应记 pluginOutcome=null）。
    if os.environ.get("FAKE_RECORD") == "1" and action.get("record", True):
        record = {
            "runId": os.environ.get("FGS_RUN_ID"),
            "activity": os.environ.get("FGS_ACTIVITY"),
            "stepId": os.environ.get("FGS_STEP"),
            "outcome": action.get("outcome", "no-commit"),
            "sessionId": action.get("sessionId") or os.environ.get("FAKE_SESSION_ID") or "fake-session",
            "conclude": os.environ.get("FGS_CONCLUDE") == "1",
        }
        ledger = cwd / os.environ.get("FGS_STATE_DIR", ".fgs") / "projects" / os.environ.get("FGS_PROBLEM_ID", "demo") / "activity.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    # 先改图再挂起：模拟「活干了、但进程卡住/被超时杀掉」的真实场景。
    sleep_for = float(action.get("sleep") or os.environ.get("FAKE_SLEEP", "0") or 0)
    if sleep_for > 0:
        import time
        time.sleep(sleep_for)

    if os.environ.get("FAKE_DUMP"):
        dump = {
            "activity": os.environ.get("FGS_ACTIVITY"),
            "step": os.environ.get("FGS_STEP"),
            "run": os.environ.get("FGS_RUN_ID"),
            "conclude": os.environ.get("FGS_CONCLUDE"),
            "suppress": os.environ.get("FGS_SUPPRESS_SIGNAL_FLUSH"),
            "budgetMs": os.environ.get("FGS_BUDGET_MS"),
            "rebase": os.environ.get("FGS_REBASE"),
            "rebaseMode": os.environ.get("FGS_REBASE_MODE"),
            "owner": graph_owner(cwd),
        }
        with (cwd / os.environ["FAKE_DUMP"]).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(dump, ensure_ascii=False) + "\n")

    prompt = sys.argv[-1] if len(sys.argv) > 1 else None
    print(json.dumps({"activity": os.environ.get("FGS_ACTIVITY"), "step": os.environ.get("FGS_STEP"),
                      "run": os.environ.get("FGS_RUN_ID"), "action": kind, "prompt": prompt},
                     ensure_ascii=False))
    return int(os.environ.get("FAKE_EXIT", "0") or 0)


if __name__ == "__main__":
    raise SystemExit(main())
