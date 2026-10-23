# v5 / v5.1 / v5.2：活动 run（Cairn 无身份 worker / Cairn_Y 活动化）

v4 的 FGS 是「**单会话 + 按图切换角色**」：同一个 agent 会话里先 Decide、再 Execute、再 Decide……
角色存在 `run.role` 里，上下文跨活动累积。v5 把它拆成
**kernel（图/工具/校验不变）+ 编排器（每轮起一个一次性 run）**，v5.1 再把
Cairn v1 Dispatcher 的六条机制补齐（并行、收束、触发、冷启动、写锁、预算）：

```
读图选活动 → 起一个干净进程（只带本活动的工具）→ 进程退出 → 再读图选活动 → …
```

- 落地记录与调参建议：[`V5_LANDING_2026-10-22.md`](V5_LANDING_2026-10-22.md)、[`V5_1_LANDING.md`](V5_1_LANDING.md)
- 竞赛运行入口：`contest/driver.py` → `contest/activity_loop.py` → `dsh --profile headless`

## 1. 为什么改（与两个原版的差异）

| 维度 | Cairn v1（源码） | Cairn_Y v2（文章） | v4 单会话 | **v5.1 活动 run** |
| --- | --- | --- | --- | --- |
| worker 身份 | 无身份，只有任务 | 无身份，Decide/Execute 是活动 | 会话内角色缓存 | **无身份：一个 run 只做一件事** |
| 上下文 | 每个任务新 CLI 进程 | 每次 run 干净上下文 | 跨活动累积 | **进程退出即销毁** |
| 工具面 | 同类 worker 同一套工具 | 按活动注入不同工具 | 全量注册 + guard 硬拒 | **注册期就不同（调不到）** |
| 记忆 | 黑板 | FGS 图 | 图 + 会话记忆 | **只有图** |
| 完成判定 | Dispatcher 看图 | 图变化触发 Decide | in-process 钩子 | **编排器看信号/台账** |
| 并行 | 同题 4 worker（`max_project_workers`） | 串行 | 无 | **同题 `--parallel N` 个 Execute；v5.2 起 Decide 也可与 Execute 并发（默认关）** |
| 超时收尾 | 两阶段 execute→conclude（同 session 续跑） | 未知 | 进程内 TTL → 未完成 Fact | **两阶段收束轮（`dsh --session-id` 续跑）** |
| Decide 触发 | reason 优先；facts/hints/open_intents 计数基线 | 图变触发 | 队列空才 Decide | **新 Finding / 每 K 次 Execute / 队列空** |
| 冷启动 | bootstrap 任务直冲 goal | 无描述 | 先 Decide | **预种 bootstrap step，第一轮直冲** |

v4 的两个真实缺陷都源自「角色是会话状态」：role 缓存导致的死锁（HANDOFF 的 D2）、
以及 Decide 被 Execute 上下文污染。v5 从结构上消掉这两类问题：没有跨活动的角色状态，
也没有跨活动的对话历史。

## 2. 组成

| 文件 | 职责 |
| --- | --- |
| `controller/activity.js` | **唯一判定规则**：读图 → 下一个活动（bootstrap/decide/execute/wait/defer/done/budget）；纯函数 |
| `tools/activity.mjs` | 判定规则的 CLI 入口（编排器只调它，不解析 graph.yaml） |
| `tools/claim_step.mjs` | **编排器预认领**（Cairn：dispatcher 先 heartbeat 再派 worker） |
| `tools/release_step.mjs` | 回收死 run 认领的 step（追加未完成 Fact，step 保持 open；幂等） |
| `hooks/activity_context.js` | 活动模式规则与运行时上下文（短；含收束轮与墙钟预算） |
| `controller/index.js` | `GraphStore.transact`：跨进程写锁事务（load→apply→validate→save） |
| `index.js` | 活动模式：注册期过滤 toolset、启动即认领、活动台账、收束后拒绝环境动作 |
| `contest/activity_loop.py` | 编排器：并行 slot、预认领、两阶段收束、预算、台账 |
| `contest/driver.py` | 拉起编排器；透传活动参数与冷启动开关 |

kernel 完全没动语义：`GraphStore` / `Controller` / `ops` / `validate_write` / `flag_verify` /
`ProjectRegistry` / 图 YAML 格式 / 既有 272 条测试的语义都保持原样（新增的只有事务 API 与
`releaseStep` 的幂等强化）。

## 3. 活动协议（环境变量）

编排器给每个 run 注入：

| 变量 | 值 | 含义 |
| --- | --- | --- |
| `FGS_ACTIVITY` | `decide` \| `execute` \| `bootstrap` | 本 run 只做这一个活动（缺省 = v4 legacy 模式，行为不变） |
| `FGS_STEP` | `step_003` | Execute/Bootstrap 要推进的 step。**编排器已在起进程前认领**，插件启动时只做校验 |
| `FGS_RUN_ID` | `p-01-execute` | 一次 run 的身份。认领的 owner 就是它；死 run 的认领可被精确回收 |
| `FGS_LEASE_MS` | `750000` | step 认领租约；编排器与插件共用同一个值 |
| `FGS_BUDGET_MS` | `600000` | 本轮墙钟预算，写进上下文（Cairn 只预告、不给时间；我们给个数量级） |
| `FGS_CONCLUDE` | `1` | 收束轮标记：规则段切换为「停止探索、只交付已确认内容」 |
| `FGS_SUPPRESS_SIGNAL_FLUSH` | `1` | 信号兜底**不写**模板化中断 Fact（留给收束轮；否则 step 被收成 done） |
| `FGS_REBASE` | `1` | v5.2：Decide 提交走 rebase（按最新图逐项校验，冲突项拒收、其余落盘）。**只由编排器给 Decide run 注入** |
| `FGS_REBASE_MODE` | `append` \| `full` | 保守档 `append`：并发时 drop/satisfy/reopen 等依赖旧图判断的 op 推迟；`full` = 逐项校验 |
| `FGS_DECIDE_TIMEOUT_MS` | `300000` | Decide 墙钟预算，只用于上下文与 `/fgs/state` 展示（真正杀进程的是编排器） |

`FGS_ACTIVITY` 未设置时插件**完全走 v4 行为**（单会话角色切换、全量工具），
所以 v5 是叠加，不是替换。

## 4. 活动内的 toolset

注册期过滤（越权工具在 schema 层就不存在，不是提示词自我约束）：

- **decide**：`fgs_status / fgs_preview / fgs_open_step / fgs_claim_step / fgs_drop_step /
  fgs_add_subgoal / fgs_drop_subgoal / fgs_change_step_priority / fgs_satisfy_goal / fgs_reopen / fgs_commit`
- **execute**：`fgs_status / fgs_preview / fgs_submit_fact / fgs_commit_step`
- **bootstrap**：execute 的 4 个 + `fgs_satisfy_goal / fgs_commit`（Cairn bootstrap 的「一份任务里
  既写事实又判完成」；satisfy_goal 进草稿、fgs_commit 落盘）

Decide 不给 `fgs_seed`（题由 driver 预种）；Execute 不给改图工具（规划是 Decide 的事）。
另有一条 guard：Execute/Bootstrap 收束后（`currentStepId` 清空）任何非 `fgs_*` 工具都会被拒，
避免模型在拿到结果后继续乱逛，把一轮干净活动拖成长会话。收束轮里 `fgs_satisfy_goal / fgs_commit`
仍放行（收束轮可能带着 bootstrap 未判完的 goal）。

## 5. 选择规则（`controller/activity.js`）

1. `goal_final` 已满足 → `done`；预算用尽 → `budget`
2. 冷启动（只有 `fact_origin` + 一条 `actor=bootstrap` 的 open step）→ `bootstrap`
3. 有可派发 step：
   - **新 Finding**（`facts[].findingType` 计数超过上次 Decide 后的基线）→ `decide`
   - **连续 K 次 Execute**（`decideEvery`，默认 3）→ `decide`
   - 否则 → `execute`（按优先级 + 创建时间取一条）
4. 有 open step 但全部被租约持有 → `wait`
5. 队列空且图没变 → `defer`（写 `meta.state=deferred`）；否则 → `decide`

基线取法与 Cairn `_reason_trigger` 一致：**上次 Decide 跑完之后**的计数，所以 Decide
自己新开的 step 不会触发下一次 Decide（避免 planner 自激）；只有别的工作（Execute 落的
Fact/Finding）才会越过基线。

## 6. 结束与失败

- **正常结束**：模型调用本活动的结束信号（decide: `fgs_commit`；execute: `fgs_commit_step`；
  bootstrap: `fgs_commit_step` + 可选 `fgs_commit`）后结束回合；进程退出。
- **没落盘**：`agent/turn-stopping` 上仍然执行 `forceCloseStep` —— Execute/Bootstrap 必须有
  Observation Fact。
- **超时**：编排器到点 SIGTERM（若还有收束轮，插件只记台账、不写 Fact），宽限后 SIGKILL；
  然后**两阶段收束**：用插件台账里的 `sessionId` 起 `dsh --session-id <sid>` + 收束 prompt
  （`FGS_CONCLUDE=1`，独立墙钟 `--conclude-timeout-sec`）。收束成功 → 这一轮算 committed；
  收束失败 → 回收认领。
- **正常退出但没落盘**：按 Cairn 的 parse-failure 语义也走收束轮。
- **其它非零退出**：不救援（可能是网关/环境问题），直接回收。
- **认领失败**：step 被别的 run 在租约内持有 / 已不存在 → 本轮 `blocked`，上下文直接告诉模型
  「本轮不可执行，直接结束回合」，编排器下一轮换 step。
- **run 死了（SIGKILL / 非零退出 / 没落盘）**：`tools/release_step.mjs --owner <runId>` 回收：
  追加**一条**未完成 Fact（幂等：同一 step 只追加一次，重复重试不刷屏），owner 清回 null。
- **空转**：图签名未变（`fN:sN:oN:dN:gN:uN:nN`，`n`=Finding 数）→ `defer`。
- **预算**：`--max-activities` / `--budget-sec` 到点退出；退出前会等完在跑的 slot 并补台账。

## 7. 并行与单写者

- 同题最多 `--parallel`（默认 2）个 **Execute** 同时跑。
- **v5.2：Decide 是独立 slot**（`--concurrent-decide` / `CONTEST_CONCURRENT_DECIDE=1`）：
  图一变就派发 Decide，不再等 Execute 清空；同一时刻最多一个 Decide（Decide 之间串行）。
  默认关闭时仍是 v5.1 的「无 slot 才 Decide」。详见
  [`V5_2_PLAN_DECIDE_CONCURRENCY.md`](V5_2_PLAN_DECIDE_CONCURRENCY.md)。
- **写锁**：每个写图动作走 `GraphStore.transact`（`graph.lock` 覆盖 load→apply→validate→save），
  所以多个 Execute 并行追加 Fact 不会互相覆盖。跨进程测试见
  `tests/write_lock.test.mjs`（8 进程并发 RMW，一条 Fact 都不丢）。
- **预认领**：编排器在起进程**之前**调用 `tools/claim_step.mjs` 把 step 认领给该 runId，
  等价于 Cairn dispatcher 的 `POST .../heartbeat`。子进程启动时只校验「这条 step 是我的」，
  不参与抢任务 —— 撞车只可能发生在编排器自己的选择里，而它是单线程的。
- **冲突面**：并行 Execute 共享同一个 workspace。`prompts/execute.system.md` 已写明
  「同一时刻可能有别的 agent 在同一目录并行做别的 step：新建文件用能表明本 step 主题的名字」。

## 8. 两阶段收束（execute→conclude）

移植自 Cairn `dispatcher/tasks/explore.py:142-219` / `bootstrap.py:136-212`：

1. 主活动超时（或正常退出但没落盘）→ 先让进程结束（SIGTERM，插件只记台账）。
2. 从插件台账读 `sessionId`（`dsh` 的真实 Session id；活动模式的 `owner` 是 runId，不是它）。
3. `dsh --profile <p> --json --session-id <sid> "<收束 prompt>"`，环境变量带上同一个
   `FGS_RUN_ID / FGS_STEP / FGS_LEASE_MS` 和 `FGS_CONCLUDE=1`；规则段切换成「停止探索、
   只把已确认内容写成 Fact」。
4. 收束成功（台账 `outcome=committed`）→ 这一轮算完成；失败 → `release_step`（追加未完成 Fact）。

为什么必须有：Cairn 实测里「超时」是最常见的失败路径，而收束轮能把**已经花掉的墙钟**
变成一条可用的 Fact；模板化的「进程收到 SIGTERM」Fact 信息量接近 0。

## 9. 冷启动快路径（bootstrap）

- `tools/bootstrap_project.mjs --cold-start-step`（driver 默认开启，`CONTEST_COLD_START_STEP=0` 关闭）
  在种题的同一次写事务里预开 `step_001`（`from=[fact_origin]`、`actor=bootstrap`、`priority=high`）。
- 选择器看到「只有 origin + 这条 bootstrap step」→ 第一轮直接 `bootstrap` 活动，跳过 Decide。
- Bootstrap 活动 = 世界工具 + `fgs_submit_fact / fgs_commit_step / fgs_satisfy_goal / fgs_commit`：
  拿到见证就「写 Fact → 收束 step → satisfy_goal → commit」一次走完；拿不到也必须落观察 Fact。
- 失败后 `release_step` 会追加一条未完成 Fact，冷启动条件自然消失，之后进入正常 Decide。

## 10. 台账

两本只追加的账，用 `runId` 对齐：

- `<cwd>/.fgs/projects/<id>/activity.jsonl`（插件写）：
  `activity / stepId / outcome(committed|no-commit|blocked|interrupted) / signature / sessionId / conclude`；
  v5.2 的 Decide 另带 `revBefore / revAfter / applied / rejected`（两者相等 = 本轮规划没推进）
- `<cwd>/.fgs/orchestrator.jsonl`（编排器写）：
  `runId / activity / stepId / exitCode / timedOut / durationMs / signatureBefore / pluginOutcome / conclude / released`；
  v5.2 的 Decide 另带 `startedWhileExecutes / concurrentWithExecutes / revBefore / revAfter / applied / rejected`
- `<cwd>/.fgs/orchestrator-exit.json`：退出摘要（`done|deferred|budget|wait|error`）

`sessionId` 是收束轮的续跑凭证；`conclude` 字段让「这一轮是首轮还是收束轮」在账上可区分。

## 11. 运行方式

竞赛镜像（真实 harness）：

```sh
CONTEST_DSH_LAUNCH=1 CONTEST_DSH_PROFILE=headless \
BENCHMARK_TOKEN=… BENCHMARK_BASE_URL=… \
python3 contest/entrypoint.sh        # → driver.py → activity_loop.py → dsh --profile headless
```

单题手工调试：

```sh
python3 contest/activity_loop.py --cwd /path/ws --problem-id demo \
    --dsh-bin dsh --profile headless --parallel 2 \
    --max-activities 24 --budget-sec 1800 --activity-timeout-sec 600 \
    --conclude-timeout-sec 120 --decide-every 3
# 只看编排决定、不起进程：
python3 contest/activity_loop.py --cwd /path/ws --problem-id demo --dry-run
```

关掉 v5（退回单进程长会话）：`CONTEST_ACTIVITY_RUNS=0`。

## 12. 约束与下一步

- **同题并行的上限**：默认 2。再往上要先测容器的内存/网关并发；`--concurrent-decide`
  打开后 Decide 占独立 slot，所以实际并发进程数是 `parallel + 1`。
- **收束轮依赖 Session 持久化**：headless profile 必须挂 `session-persistence-jsonl`
  （`dsh-base` 默认有）。SIGKILL 后 session 里最后一次未落盘的回合可能缺失，收束轮只能
  总结已持久化的部分（Cairn 的 `claude -r` 同样如此）。
- **v5.2 并发 Decide 已实现，但默认关闭**：打开后图一变就能重规划，代价是 Decide 基于的
  快照可能过期——提交走 rebase（冲突项回报、delta 回灌），但规划质量仍取决于模型是否
  按回灌内容补一版。落地记录与已知限制见 [`V5_2_LANDING.md`](V5_2_LANDING.md)。
- **deferred 跨轮重试**：`defer` 仍是「本轮放弃、worker 退出」，靠 driver 的下一 visit；
  没有进程内 retry。
- **legacy 单会话路径继续保留**：GUI 里手动用 FGS、`/fgs new` + 聊天推进都不受影响。
- **真实模型 E2E**：离线用假 worker/假模型验证了编排与协议；带 key 的端到端冒烟仍是待办
  （见 `V5_1_LANDING.md` §5）。
