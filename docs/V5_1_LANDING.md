# v5.1 落地记录：把 Cairn / Cairn_Y 的六处差距补上（2026-10-22）

> 上一轮（v5.0）对照 Cairn v1 与 Cairn_Y 的结论是：**结构对齐、六处机制缺失**。
> 本次按 Cairn 源码（`/mnt/d/XunLei/cairn/repo/cairn/src/cairn` @ `8e7e0ea`）
> 对应模块的思路，把六处全部落到 v5 上。设计文档见
> [`V5_ACTIVITY_RUNS.md`](V5_ACTIVITY_RUNS.md)（已按 v5.1 重写）。

## 1. 六条差距 → 六处实现

| # | 差距 | Cairn 出处 | v5.1 实现 | 测试 |
| --- | --- | --- | --- | --- |
| 1 | **单写者靠串行，不是结构保证** | `server/db.py`（单进程 SQLite）+ dispatcher 先 heartbeat 再派 worker（`scheduler/loop.py:446/504`） | `GraphStore.transact`（文件锁覆盖 load→apply→validate→save）+ 编排器预认领 `tools/claim_step.mjs` | `tests/write_lock.test.mjs`（4 条：8 进程并发 RMW 不丢 Fact、事务失败整体不落盘、claim 租约、claim 幂等） |
| 2 | **缺 bootstrap 冷启动快路径** | `tasks/bootstrap.py`（只给 origin/goal/hints；fact→complete；conclude 只写 fact） | `bootstrap_project.mjs --cold-start-step` 预种 `step_001(actor=bootstrap)`；选择器返回 `bootstrap` 活动；toolset = execute + `satisfy_goal` + `fgs_commit` | `tests/selection_v51.test.mjs`（冷启动/结束/CLI 幂等）+ `tests/plugin_v51.test.mjs`（Bootstrap 活动全流程）+ `tests/activity_loop_v51.test.mjs`（第一轮就是 bootstrap） |
| 3 | **Decide 被饿死**（队列非空永不重规划） | `_reason_trigger`（`loop.py:704-718`）：facts/hints 超基线、open intents>0→0；基线取 reason 跑之前的计数，避免自激 | `controller/activity.js#decideDue`：新 Finding（签名加 `:nN`）或每 K 次 Execute 触发 Decide；基线 = 上次 Decide **跑完之后**的计数 | `tests/selection_v51.test.mjs`（Finding 触发、K 次触发、K=0 关闭、签名含 Finding）+ loop 测试（execute,execute,decide） |
| 4 | **超时零抢救**（模板化中断 Fact） | 两阶段 `execute→conclude`（`tasks/explore.py:142-219`）：同 session 续跑，收束只写 fact；失败 release | 超时/没落盘 → 读插件台账 `sessionId` → `dsh --session-id` 跑收束轮（`FGS_CONCLUDE=1`，独立墙钟）→ 成功算 committed，失败 release | `tests/plugin_v51.test.mjs`（收束规则/上下文）+ `tests/activity_loop_v51.test.mjs`（收束成功/无 sessionId 回退/非零退出不救援） |
| 5 | **同题串行，吞吐差一档** | `runtime.max_project_workers`（默认 4）+ 预认领 + 本地 futures 去重 | 编排器 `--parallel N` 个 Execute slot；Decide 串行；认领在 spawn 前，slot 之间不会撞任务；写锁保证不丢 Fact | `tests/activity_loop_v51.test.mjs`（两个 slot 同时跑不同 step、owner=runId、台账两条） |
| 6 | **缺预告知 deadline override** | `bootstrap.md:19-20` / `explore.md:20`：开工时预告「收束指令会到、覆盖一切」；收束 prompt 在 resume 时注入 | `activityRules(..., {conclude, budgetMs})`：开工即告知墙钟预算与收束轮存在；收束轮规则段覆盖一切旧指令 | `tests/plugin_v51.test.mjs`（预算 10 分钟 + 收束覆盖文案）+ loop 测试（`FGS_BUDGET_MS` 透传） |

## 2. 顺带修掉的三个正确性问题

1. **`releaseStep` 幂等**：同一 step 反复超时重试不再重复追加未完成 Fact（旧行为会随
   `--parallel`/重试把黑板刷满 `kind=unfinished` 节点）。改成「一条 step 至多一条未完成 Fact」。
2. **编排器停止时丢台账**：预算到点退出时，原先只等 slot 结束、不写它们的台账/回收；
   并行时最后 1-2 个 slot 会从 `orchestrator.jsonl` 消失。现在 `stop_with` 会补收尾。
3. **`fgs_commit_step` 回报 Fact id**：Bootstrap 要用新 Fact 做 `satisfiedBy`，旧返回只有
   「→ 新 Fact」没有 id；现在返回 `新 Fact fact_NNN`。

## 3. 新增/修改文件

| 文件 | 变化 |
| --- | --- |
| `controller/index.js` | `GraphStore.transact` / `Controller.transact`；`releaseStep` 幂等 |
| `controller/activity.js` | `findingCount` / `isColdStart` / 签名加 `:n` / `decideDue` / `bootstrap` kind |
| `hooks/activity_context.js` | `activityRules(activity,{conclude,budgetMs})`（含收束轮与预算）/ `activityContextText` 支持 bootstrap 与收束 |
| `hooks/sync_context.js` | `roleLabel('bootstrap')` |
| `index.js` | `bootstrap` 活动（配置/工具/规则/guard）、`FGS_CONCLUDE/FGS_BUDGET_MS/FGS_SUPPRESS_SIGNAL_FLUSH`、台账 `sessionId`、`fgs_commit_step` 返回 fact id、写路径全部改 `transact`、代次 15 |
| `tools/claim_step.mjs` | **新增**：编排器预认领 CLI |
| `tools/activity.mjs` | 新参数 `--findings-at-last-decide / --executes-since-decide / --decide-every` |
| `tools/bootstrap_project.mjs` | `--cold-start-step`（同一事务里种 origin + bootstrap step） |
| `tools/release_step.mjs` | 写路径改 `transact` |
| `contest/activity_loop.py` | 重写：并行 slot / 预认领 / 两阶段收束 / 预算 / 收尾补台账 |
| `contest/driver.py` | 冷启动开关 + `CONTEST_ACTIVITY_*` / `CONTEST_CONCLUDE_TIMEOUT` / `CONTEST_ACTIVITY_PARALLEL` / `CONTEST_DECIDE_EVERY` 透传 |
| `tests/fixtures/fake_worker.py` | 支持按 step/conclude 选动作、`FAKE_RECORD`（写台账含 sessionId）、`FAKE_DUMP`（验证预认领/预算） |
| `tests/fixtures/concurrent_release.mjs` | **新增**：并发 RMW 夹具 |
| `docs/V5_ACTIVITY_RUNS.md` | 按 v5.1 重写 |
| `CONTRACT.md` | 新增 §14 活动 run 协议 |
| `README.md` | 环境变量表补 7 个竞赛旋钮 |

## 4. 验证

```bash
node --test "tests/*.test.mjs"     # 298 tests / 298 pass
```

- 272 条既有测试语义不变（kernel / legacy 单会话 / driver / 图校验）。
- 新增 26 条：`selection_v51`（10）、`write_lock`（4）、`plugin_v51`（6）、
  `activity_loop_v51`（6）。
- 编排器测试全程离线：假 worker 起真子进程、真写图、真超时、真收束，不需要模型 key。
- **未做**：真实模型 E2E（下同 v5.0 的待办）。收束轮在真实 `dsh` 上只验证了
  命令形状与 env 协议；`--session-id` 续跑需要一次带 key 的冒烟确认（见 §6）。

## 5. 行为变化 / 兼容性

- **默认行为变了**（仅竞赛路径）：一题内可能同时跑 2 个 Execute；超时后会多花一次
  收束轮（默认 120s 上限）再放弃。
- **legacy 路径不变**：GUI / `/fgs new` + 聊天 / 单会话角色切换完全没动；
  `CONTEST_ACTIVITY_RUNS=0` 仍可整体退回 v4 行为。
- **图格式不变**：bootstrap step 只是普通的 open step + `actor: "bootstrap"`；
  收束轮写的也是普通 Fact。没有新顶层键。
- **版本**：`@local/fgs-v5-dsh` 1.1.0 → **1.2.0**；`PLUGIN_GENERATION` 14 → **15**；
  `BUILD_TAG = 15+parallel+conclude+decide-trigger`。`/fgs/state` 可自证。

## 6. 调参与已知限制

| 旋钮 | 默认 | 建议 |
| --- | --- | --- |
| `CONTEST_ACTIVITY_PARALLEL` | 2 | 简单题多时可 3；先确认容器内存与网关并发 |
| `CONTEST_DECIDE_EVERY` | 3 | 方向变化快的题调 2；稳定的题调 4-5 省 token |
| `CONTEST_CONCLUDE_TIMEOUT` | 120 | 长上下文题 180-240；模型慢时别低于 90 |
| `CONTEST_ACTIVITY_TIMEOUT` | 600 | 单活动墙钟；与题难度和模型速度相关 |
| `CONTEST_COLD_START_STEP` | 开 | 简单题收益最大；纯多阶段题可关 |

已知限制：

1. **Decide 仍非「每次图变」触发**：并行 slot 在跑时不重规划，粒度是「每 K 次 Execute」。
   这是串行 Decide 的代价；再细需要 Decide 与 Execute 并发（要处理读旧图规划的问题）。
2. **收束轮依赖 Session 持久化**：`dsh-base` 自带 `session-persistence-jsonl`；若竞赛
   profile 裁掉它，收束轮会因 `--session-id` 找不到 session 而跳过（日志会说明）。
3. **SIGKILL 后无 sessionId**：插件没来得及写台账 → 不收束、直接 release（Cairn 同）。
4. **workspace 共享**：并行 Execute 同目录，靠提示词约定文件名；没有文件级锁。
5. **真实模型 E2E 未跑**：需要一次 `CONTEST_DSH_LAUNCH=1` + 真 key 的完整链路。

## 7. 下一步建议（按优先级）

### P0 — 比赛前必须做

1. **真实模型 E2E 冒烟**：一题、`--parallel 2`、`--activity-timeout-sec 600`，确认
   （a）收束轮真的能 `--session-id` 续跑出 committed；（b）并行两个 Execute 不互相踩
   workspace；（c）`/fgs/state` 显示 gen 15。
2. **镜像重建**：装 1.2.0、带 headless profile、`CONTEST_DSH_LAUNCH=1`；跑一次
   `entrypoint.sh` 全链路（driver → loop → dsh），确认默认 env 生效。
3. **成本基线**：用 2-3 道题对比 v5.0（串行、无收束）与 v5.1 的活动数/token/墙钟，
   决定 `PARALLEL` 与 `DECIDE_EVERY` 的赛时取值。

### P1 — 质量

4. **Decide 与 Execute 并发**（当前唯一的结构性妥协）。现状：Decide 必须等所有 Execute slot
   清空才跑，所以并行 slot 满载时「图变」要等到 batch 边界才被看到，最长迟滞 ≈ 一个
   `activity_timeout`（默认 600s）。
   - **Cairn v1 为什么能并发**：reason 与 explore 只靠「项目级 reason 租约」互斥（只保证同时
     一个 reason），并不等 explore 清空；前提是 reason 的写操作**只追加**（创建 intent /
     complete），不删除、不修改已有 intent，所以旧快照最多导致「多提一个方向」，server 端
     的 from 校验和 worker 心跳会兜住。
   - **我们为什么先串行**：v5.1 的 Decide 有 Cairn_Y 的完整权力（drop_step / 改优先级 /
     sub goal），且模型要思考几分钟才 commit；与 Execute 并发会出现语义过期（drop 一条刚
     完成的 step、基于旧 Fact 判 satisfy）。
   - **代价**：`--parallel 2` + 600s 超时下，最坏 600s 才纠偏一次；1800s 预算里少掉 1/3 的
     重规划机会。
   - **路线**（完整方案已单独成文：[`V5_2_PLAN_DECIDE_CONCURRENCY.md`](V5_2_PLAN_DECIDE_CONCURRENCY.md)）：
     给图加内容哈希 `rev`（不落 graph.yaml）；Decide run 记录读图时的 `baseRev`，
     commit 时若 `rev` 已变，就基于**新图**逐 op 重校验（`Controller.apply` 本来就会重校验
     from/state/引用），冲突 op 剔除并在工具结果里告知模型，不冲突的照常落盘。
     更保守的中间态：并发 Decide 只允许 append-only op（`open_step` / `add_subgoal` /
     提升优先级），`drop_step` / `satisfy_goal` 仍等 slot 清空 —— 这最接近 Cairn v1 的
     reason（只追加），可以先上这一档。
5. **收束轮的 `structured_output` 化**：现在收束仍走「模型调 fgs_submit_fact」；可以给
   收束轮一个强制 JSON 契约（复用 `io-specs/`），减少空收束。
6. **活动级评测台**：固定题集 + 假模型/录制 provider，统计每题活动数、收束成功率、
   Finding 数，作为调 `DECIDE_EVERY` 的依据。
7. **并行度自适应**：按剩余墙钟/Queue 深度动态调 `--parallel`（Cairn 作者复盘里
   「前期并发不足」的教训）。

### P2 — 维护

8. **`prompts/execute.system.md` 的并行安全段**：明确「不要 kill 别人起的进程/监听」。
9. **黑板上显示 activity/slot**：`/fgs/state` 已有 `activity/activityRunId/activityBlocked`，
   client 黑板条可以显示「并行 slot 数 + 最近收束结果」。
10. **`release_step` 的未完成 Fact 去重**已做；可再给 `meta.json` 加 `attempts`，
    连续 N 次失败才 deferred（现在是 driver 下一 visit 重试）。
