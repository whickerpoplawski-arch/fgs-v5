# v5.2 落地记录：Decide 与 Execute 并发

> 版本：`@local/fgs-v5-dsh` **1.3.0** / `PLUGIN_GENERATION` **16**
> 日期：2026-10-22
> 方案与实现手册：[`V5_2_PLAN_DECIDE_CONCURRENCY.md`](V5_2_PLAN_DECIDE_CONCURRENCY.md)（§12）
> 回滚点：`fgs-v5-1.2.0.zip`（v5.1 全绿基线，298 tests）

---

## 1. 一句话

v5.1 最后的结构性差距是「**Decide 必须等所有 Execute slot 清空才跑**」：图一变要等一个
`activity_timeout`（默认 600s）才重规划。v5.2 把 Decide 变成独立 slot（`--concurrent-decide`），
图一变就重规划；Decide 基于旧快照做的提交走 **rebase**（逐项校验、冲突项回报、其余落盘），
并发期间新落的 Fact/Finding 会**回灌**给模型。默认关闭，打开即用，关闭时逐行为等于 v5.1。

## 2. 改了哪些文件

| 文件 | 改动 |
|---|---|
| `controller/index.js` | `revisionOf(graph)`（sha256(dump(graphToDoc))，不落盘）、`GraphStore.loadWithRev/transactWithRev`、`transact` 委托、`Controller.applyBatch(ops,{rebase,baseRev})` |
| `controller/activity.js` | `decide` 分支返回 `executeCandidate: step.id`（编排器据此边规划边执行） |
| `index.js` | `DEFAULT_CONFIG.rebase/rebaseAllow/decideTimeoutMs`；env `FGS_REBASE/FGS_REBASE_MODE/FGS_DECIDE_TIMEOUT_MS`；run 字段 `baseRev/startGraph/lastRebase`；`startActivity` 记基线；`fgs_commit` 双模式（strict 原样保留 + rebase 分支 + `graphDelta` 文案）；台账 `revBefore/revAfter/applied/rejected`；`/fgs/state` 加 `graphRev`/`lastCommit.rejected` |
| `hooks/activity_context.js`、`prompts/decide.system.md` | Decide 规则加「图可能在你规划期间变化」段 |
| `contest/activity_loop.py` | `--concurrent-decide/--decide-timeout-sec/--max-decides/--rebase-mode`；`activity_env(budget_ms,rebase)`；`decide_slot/decide_future/decides`；`advance_concurrent` 状态机 + `dispatch_decide/finish_decide/reap_decide/wait_decide`；`stop_with` 先排空 slots 再收 Decide |
| `contest/driver.py` | 透传 4 个 `CONTEST_*` 旋钮 |
| `tests/fixtures/fake_worker.py` | dict 场景 `"decide"` 键、`findingType`、动作级 `record:false`、dump rebase 字段 |
| 测试 | 新增 `tests/rebase.test.mjs`(8)、`tests/plugin_v52.test.mjs`(7)、`tests/activity_loop_v52.test.mjs`(7)、`tests/contest_driver.test.mjs`(+1)、`controller/activity.js` 选择器单测(+1) |

## 3. 与方案的差异（实现时的选择）

1. **线程池多给 Decide 一个 worker**（`max_workers = parallel + 1`，仅并发模式）。
   §12.3 伪码把 Decide 也 submit 进同一个池；池只有 `parallel` 个 worker 时，slot 填满后
   Decide 会排在 Execute 后面，正好退化成串行。Execute 数量仍由 `slots` 容量卡死。
2. **`--max-decides` 用尽且无候选 → `deferred`**（不是字面 `defer`）。
   与 v5.1 的 `defer` 语义对齐：`mark_deferred` 写 `meta.state=deferred`，调度方据此退役；
   否则会留一个永远不再规划的空转 worker。方案 §12.3 已同步改。
3. **§12.5 loop 测试 1 用 `--parallel 3`**：`startedWhileExecutes=2` 需要派发瞬间有 2 个
   Execute 在跑，而触发 Decide 的计数/Finding 一定来自某个 Execute 完成（完成后先被 reap
   出 slot），`parallel=2` 时最多只有 1 个在跑。3 slot 场景：1 个快速 Execute 落 Finding
   触发 Decide + 2 个长 Execute 在跑 → 断言 `startedWhileExecutes=2`。
4. **`/fgs/state` 的活动 run 查找**：活动模式下 `run.sid` 是 runId 而不是宿主 session id，
   所以 `?sessionId=<宿主 session>` 找不到活动 run（v5.1 既有行为，未改）。验证 `graphRev`
   时用无参（按活动 Project）/`?problemId=`。GUI 面板不受影响（它看的是单会话 run）。

## 4. 行为不变量核对（方案 §12.4）

| # | 不变量 | 证据 |
|---|---|---|
| 1 | legacy 下 rebase 永不启用、`fgs_commit` 仍整批原子 | `plugin_v52`: 未开 rebase 整批拒写；legacy+rebase:true 仍整批 |
| 2 | `FGS_REBASE=1` 且 `activity==='decide'` 才走 rebase | 同上两条 + `index.js` 的 `rebaseMode` 判定 |
| 3 | 每次写盘后 `validate()` 通过 | `transactWithRev` 强制；rebase 分支复用 `apply()` 的逐项校验 |
| 4 | Decide 不认领 step、不写 Fact、不调 release | `activity_loop_v52`: claim/release 调用计数为 0（fake worker 记录） |
| 5 | 同题同一时刻最多 1 个 Decide | `activity_loop_v52` 互斥用例（pick 反复给 decide，台账只有 1 行） |
| 6 | Decide 超时/崩溃 → 图零改动 | `activity_loop_v52` 超时用例（`timedOut=true`，图签名不变） |
| 7 | `executes_since_decide` 在派发时清零 | `dispatch_decide`；`activity_loop_v52` 基线语义用例 |
| 8 | `findings_at_last_decide` 取派发时计数 | `finish_decide` 用 `slot["counts"]["findings"]`；基线语义用例（Decide 期间落的 Finding 结束后立刻再触发一次 Decide） |
| 9 | `max_activities` 含 Decide；`--budget-sec` 全局墙钟；`--max-decides` 超限后只执行不收尾 | `activity_loop_v52` max-decides 用例（5 个 step 全执行、decide 只 1 次） |
| 10 | 开关关闭时既有测试零改动通过 | 全量 **321/321**（见 §6） |

## 5. 怎么开（竞赛）

```sh
# 打开并发 Decide（默认仍关，关闭时逐行为等于 v5.1）
CONTEST_CONCURRENT_DECIDE=1
CONTEST_DECIDE_TIMEOUT=300      # Decide 独立墙钟（秒），不占 CONTEST_ACTIVITY_TIMEOUT
CONTEST_MAX_DECIDES=12          # 单题 Decide 次数上限
CONTEST_REBASE_MODE=full        # full = 逐项校验；append = 保守档（并发时不 drop/satisfy/reopen）
```

插件侧不需要额外配置：编排器给 Decide run 注入 `FGS_REBASE=1` + `FGS_REBASE_MODE`，
Execute/legacy 永远拿不到这两个变量（`activity_env` 会显式 pop）。

## 6. 验证记录（2026-10-22）

```bash
cd /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0
node --test tests/rebase.test.mjs            # 8/8
node --test tests/plugin_v52.test.mjs        # 7/7
node --test tests/activity_loop_v52.test.mjs # 7/7（连跑 4 次，无 flake）
node --test tests/contest_driver.test.mjs    # 8/8
node --test "tests/*.test.mjs"               # 321/321，fail 0
```

`activity_loop_v52` 覆盖的并发事实（不是模拟）：真子进程 + 真台账，
断言 `startedWhileExecutes=2`、`concurrentWithExecutes=true`、两个 Execute 都 committed、
Decide 超时 `timedOut=true` 且图零改动。

## 7. 已知限制 / 下一步

1. **真实模型 E2E 仍未跑**（同 v5.1）：`--session-id` 收束轮、Decide 面对回灌 delta 的实际
   行为，需要用带 key 的 headless 跑一次。离线只验证了协议与编排。
2. **竞赛镜像需重建**：当前镜像装的是 1.2.0；要用 1.3.0 + `CONTEST_CONCURRENT_DECIDE=1`
   重打镜像，并跑一道真题验证「图变 → 立即重规划」的墙钟收益。
3. **rebase 的语义边界**：`drop_step` 在并发下最危险（可能 drop 掉别人刚推进的任务）——
   已提供 `append` 保守档；`full` 档依赖模型读懂「冲突未生效」回灌，规划质量待实测。
4. **Decide 与 Execute 抢同一个 workspace**：并发下同一目录可能同时有多个进程在写文件，
   `prompts/execute.system.md` 已要求用带 step 主题的文件名；Decide 不执行环境工具，风险低。
5. **`max-decides` 是兜底不是调参旋钮**：默认 12 足够；调小会提前退役 worker（deferred）。

## 8. 回滚

```bash
rm -rf /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0 && mkdir -p /tmp/rollback \
  && unzip -q /home/ubuntu/ws/fgs-v5-1.2.0.zip -d /tmp/rollback \
  && mv /tmp/rollback/fgs-v5-1.2.0 /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0
```

或只关开关：`CONTEST_CONCURRENT_DECIDE=0`（v5.1 串行分支代码完整保留，未删除一行）。
