# v5.2 方案：Decide 与 Execute 并发（Cairn_Y「完整档」）

> 状态：**✅ 已实现**（2026-10-22，`@local/fgs-v5-dsh` **1.3.0** / generation **16**）。
> 落地记录、与本文的差异、已知限制见 [`V5_2_LANDING.md`](V5_2_LANDING.md)。
> 本文件保留为**设计与实现手册**（§12 仍是改代码时的第一参考）。
> 前置阅读：[`V5_ACTIVITY_RUNS.md`](V5_ACTIVITY_RUNS.md)（v5.1 运行时）、
> [`V5_1_LANDING.md`](V5_1_LANDING.md)（P1-4 的现状与代价）。
>
> **怎么读**：§1–§11 是设计与决策；**§12 是实现手册**（精确到文件/函数/骨架代码/测试断言/自检命令）。
> 时间紧或上下文被压缩过，直接跳到 **§12.0**，按 §12.7 的 checklist 做。

> 一句话：**让 Decide 不再等 Execute 清空**——图一变（新 Fact / 新 Finding）就能起一次
> Decide，Decide 之间仍然串行；Decide 基于旧快照做的规划，在落盘时按**最新图逐项 rebase**，
> 冲突项回报给模型而不是整批作废。

---

## 1. 目标与非目标

### 目标

1. **触发→执行的迟滞从「一个 activity_timeout」降到「一次 Decide 的时长」**。
   当前 `--parallel 2` + 600s 超时下，最坏要等 600s 才能重规划；目标 ≤ Decide 自身耗时（30–120s）。
2. **不破坏图的一致性**：并发写仍然只有一个写者序列（`GraphStore.transact` 文件锁）；
   Decide 的 `drop_step` / `change_step_priority` / `satisfy_goal` 不会误伤 Execute 刚完成的 step。
3. **冲突可见、可恢复**：被拒的操作要告诉模型「为什么」+「这期间图发生了什么」，模型能在同一
   run 内补一版，而不是整批重来。
4. **默认行为可回滚**：开关关闭时与 v5.1 字节级一致。

### 非目标

- 不做**多个 Decide 并行**（Cairn 的 reason 是项目级租约，Cairn_Y 也明确 Decide 串行）。
- 不做 Execute 之间的写冲突合并（Fact 是追加的，不需要）。
- 不改图 schema（`rev` 不落 `graph.yaml`，CONTRACT §2 的「顶层只有 facts/goals/steps」不变）。
- 不做跨进程 Decide 锁（driver 一次只 visit 一道题；M4 再评估）。

---

## 2. 背景：两个原版怎么处理「规划 vs 执行」的并发

### Cairn v1（源码）

| 事实 | 出处 |
|---|---|
| 派发顺序 bootstrap → **reason** → explore，每 tick 每项目只派一个任务就返回重来 | `dispatcher/scheduler/loop.py:286-338` |
| reason 的互斥是**项目级租约**（`claim_reason` + 心跳），只保证「同时一个 reason」 | `loop.py:381`、`routers/projects.py:191-216` |
| explore 是并行的（`max_project_workers=4`），**reason 不等 explore 清空**；reason 触发条件 = facts 增加 / hints 增加 / open intents 从 >0 变 0 | `loop.py:704-718` |
| reason 的输出只有 `complete` 或**新增 intent**，不删除、不修改已有 intent | `tasks/reason.py` |

**它能并发的根本原因**：reason 是**只追加**的。读到几分钟前的快照，最坏只是「多提一个方向」
或「没看到刚落的 fact」，server 端的 `from` 校验会兜住，不会写坏图。

### Cairn_Y v2（文章，无源码）

- 「Decide 在一个任务开始时，或者**图上信息有增加或者变化时**被触发」。
- Decide 的职责是「对 Step 进行评估，进行**添加、废弃或者优先级调整**」，以及提出/删除 Sub Goal。
- Decide 是**独立、串行**的运行过程（同一时刻一个 Decide），每次干净上下文；Execute 不保留跨会话记忆。

推断：**「串行」指 Decide 之间互斥，不是「Decide 必须等所有 Execute 空闲」**。但 Cairn_Y 的 Decide
比 v1 的 reason 权力大（drop / 改优先级 / 增删 Sub Goal），并发时需要处理「规划基于旧快照」的语义。

### 我们的现状（v5.1）

- 触发条件已经对齐（[`decideDue`](../controller/activity.js)：新 Finding 或每 K 次 Execute）。
- 但编排器只在 `if not slots:` 时才跑 Decide（[`run_loop`](../contest/activity_loop.py)），
  于是触发条件被「等 slot 清空」吞掉。代价写在 `V5_1_LANDING.md` P1-4：最坏 600s 迟滞。

### 三个可选档位

| 档 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 现状 | 串行 Decide + 敏感触发 | 简单、零语义风险 | 迟滞 = 一个 activity_timeout |
| B. 保守并发 | Decide 可与 Execute 并发，但只允许 **append-only** 操作（open_step / add_subgoal / 提优先级）；drop/satisfy 等 slot 清空 | 语义上等价于 Cairn v1 reason；风险极低 | Decide 的「废弃错误方向 / 判达成」仍被延迟 |
| **C. 完整档（本方案）** | Decide 全权限并发；落盘时 **rev 检测 + 逐 op rebase**；冲突项回报；附「快照差量」 | 最接近 Cairn_Y 语义；规划能力完整 | 需要新 API、冲突语义、更多测试 |

本文件写的是 **C**，并把 B 作为 M1 的中间态（先上 B 验证调度，再开 C 的 rebase）。

---

## 3. 设计总览

```
┌────────────────────────── 编排器（单进程，per problem） ──────────────────────────┐
│  slots[execute ×N]        decide_future（最多 1 个）                              │
│      │                        │                                                  │
│      │  pick() 每轮重新算      │  触发：新 Finding / 每 K 次 Execute / 队列空       │
│      ▼                        ▼                                                  │
│  claim_step → spawn      spawn（不认领 step；独立 --decide-timeout-sec）           │
│      │                        │                                                  │
│      └──────► 图（graph.lock 串行化读改写） ◄───────┘                             │
│                    ▲                                                             │
│         transact: load(rev) → apply → validate → save(rev')                      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **写者仍然只有一个序列**：所有写都走 `GraphStore.transact` 的排它锁；并发的是「思考」，
  不是「写」。
- Decide 进程启动时记下 `baseRev = rev(graph)` 与一份内存快照；commit 时在锁内拿到最新
  `rev`，若已变化 → 逐 op 重校验（rebase），冲突项剔除并回报。
- 图永不删除节点（drop 是标记），Fact 只追加 → 冲突面很小，绝大多数 op 在任何新图上仍然合法。

---

## 4. 详细设计

### 4.1 图版本 `rev`（不落 `graph.yaml`）

**决策**：`rev` 用**内容哈希**，不新增持久字段。

```js
// controller/index.js（GraphStore）
export function revisionOf(graph) {
  // 规范化 YAML 文本的 sha256；同一图在任何进程/任何时间算出来都一样。
  return createHash('sha256').update(dump(graphToDoc(graph))).digest('hex');
}

loadWithRev() { return { graph: this.load(), rev: revisionOf(graph) }; }

/** 事务：fn(graph, { rev, baseRev })；返回 { graph, rev } */
transactWithRev(fn) { ... }        // transact 保留旧签名，内部委托给它
```

- 成本：图通常 < 100 KB，sha256 在微秒级；只在 `transactWithRev` 与 Decide 启动时算。
- 精确实现（含 `transactWithRev` / `applyBatch` 骨架）见 **§12.1(1)**。
- 为什么不用自增计数：自增要落盘（新文件或新顶层键），而内容哈希零 schema 变更、天然跨进程、
  重启也不会回绕。代价是「rev 不可比较先后」，但本方案只需要「是否变化」，不需要排序。
- 为什么不落 `graph.yaml`：CONTRACT §2 冻结了顶层键；`graph.json` 是从属镜像，不适合当真源。

`/fgs/state` 增加 `graphRev`（前 12 位展示），便于线上对账。

### 4.2 Decide 并发调度（编排器）

`contest/activity_loop.py` 的循环从「没 slot 才 Decide」改成「**Decide 是独立 slot**」：

```python
decide_future: Future | None = None
slots: dict[Future, dict] = {}          # execute / bootstrap

while True:
    reap_executes(); reap_decide()

    activity = pick()                    # kernel 判定，每轮可重算
    kind = activity["kind"]

    # 1) 需要 Decide：立即派发，不等 execute 清空；已有 decide 在跑就跳过
    if kind == "decide" and decide_future is None and not decide_blocked():
        dispatch_decide(activity)        # 不认领 step；独立 timeout
        continue

    # 2) 需要 Execute：decide 在跑时也能派发
    if kind in ("execute", "bootstrap"):
        dispatch_execute(activity)       # 预认领 + spawn
        continue

    # 3) 终态（done/defer/budget/wait）按 v5.1 语义处理
```

需要配套的两处改动：

1. **`nextActivity` 返回 `executeCandidate`**：当判定 `decide` 但队列里还有可派发 step 时，
   同时给出该 step 的 id。编排器在「decide 已在跑」时用 `executeCandidate` 继续填 slot，
   而不是空等。返回值向后兼容（新增字段，不改既有字段语义）。
2. **Decide 独立墙钟**：新增 `--decide-timeout-sec`（默认 300）。Decide 超时不写图、不认领，
   直接丢弃；`no_progress` / `defer` 逻辑兜底，避免无限重规划。

互斥：

- **进程内**：`decide_future is None` 即互斥；一个 Decide 在跑时不再派第二个。
- **跨进程**：v5.2 不处理（driver 一次只 visit 一道题；同一题的第二个编排器属于部署错误）。
  M4 如需支持，加 `.fgs/projects/<id>/decide.lease`（owner + expiresAt），与 step 租约同构。

基线（Cairn `_reason_trigger` 的语义，必须保持）：

| 时机 | 动作 |
|---|---|
| 派发 Decide 时 | 记录 `counts_at_dispatch`（findings / signature）；`executes_since_decide = 0` |
| Decide 结束 | `findings_at_last_decide = counts_at_dispatch.findings`（**不是**当前值） |
| Execute 结束 | `executes_since_decide += 1`（即使 Decide 在跑也照加） |

这样 Decide 运行期间 Execute 新落的 Finding **仍在基线之上**，Decide 一结束就会再次被触发
（Cairn 同语义）；而 Decide 自己写的 step 不会触发自己。

### 4.3 冲突语义：rebase 算法

Decide 的 commit（`fgs_commit`）在活动模式下改成 **best-effort + 冲突回报**；legacy 保持
「任一失败整批不落盘」。开关：`FGS_REBASE=1`（编排器给 decide run 注入）。

```js
// tools 层伪码（index.js 的 fgs_commit handler）
const out = run.controller.transactWithRev((graph, { rev }) => {
  const rebased = rev !== run.baseRev;      // 规划期间图变过
  const applied = [], rejected = [];
  let working = graph;
  for (const op of ops) {
    try { working = run.controller.apply(op, working); applied.push(op.type); }
    catch (e) {
      if (e instanceof WriteRejected) rejected.push({ op: op.type, detail: e.message });
      else throw e;
    }
  }
  return { graph: working, applied, rejected, rebased };
});
run.baseRev = out.rev;
```

- **逐 op 而不是整批**：`Controller.apply` 本来就会针对传入的图重新校验 `from` 存在、
  step 是 open、owner/租约、goal 存在、FLAG 门……所以 rebase 不需要新校验逻辑，只需要
  「不要因为一个 op 失败就回滚全部」。
- **依赖顺序**：按草稿顺序应用；前面的 op 失败会导致后面依赖它的 op 也失败（正常）；
  相互独立的 op 仍能生效。
- **哪些 op 在并发下最可能冲突**（预期表，用于测试与提示词）：

| op | 并发风险 | 冲突时行为 |
|---|---|---|
| `open_step` | 极低（from 是只追加的 Fact） | — |
| `add_subgoal` / `drop_subgoal` | 低（goal 也是只追加+标记） | — |
| `change_step_priority` | 中（step 可能刚被收束） | 拒：step 非 open |
| `drop_step` | **中高**（最常见：想废弃的 step 已经被 Execute 做完了） | 拒：step 非 open；**这是最需要回报给模型的信息** |
| `claim_step` | 低（租约检查） | 拒：被别人在租约内持有 |
| `satisfy_goal` | 中（Fact 只增，通常仍合法） | 只在 fact 被删时拒（不会发生）；语义过期靠 delta 提示 |
| `reopen` | 低 | — |

- **响应格式**（给模型看，同时写进台账）：

```
已提交 2 项: open_step, add_subgoal
⚠️ 图在你规划期间变化过（rev 3f2a→9c1e）。以下操作因冲突未生效，草稿已移除：
  - drop_step step_004：目标不是 open step（state=done）
  - change_step_priority step_005：step 不存在
建议：先 fgs_preview 看最新图，再补一版（本轮还能继续调用工具）。
```

- **草稿处理**：`applied` 与 `rejected` 都从 `decideDraft` 移除；`rejected` 只在响应里出现。
  理由：进程退出后草稿本来就不保留，留着会在下一次 commit 时重复失败。

### 4.4 快照差量（delta）回灌

rebase 之外，**让模型知道「这期间图发生了什么」**比只报冲突更有用。Decide run 启动时把
`run.startGraph = run.store.load()` 存在内存；commit 时与最新图做 id 级 diff：

```js
const delta = {
  newFacts: fresh.facts.filter((f) => !startIds.has(f.id))
      .map((f) => ({ id: f.id, title: f.title, findingType: f.findingType ?? null })),
  closedSteps: startOpen.filter((id) => fresh.steps.find((s) => s.id === id)?.state !== 'open'),
  goalChanged: fresh.goals.some((g) => g.satisfiedAt && !startGoal.has(g.id)),
};
```

- 只给 **id + title**（不塞正文），上限 20 条；这是给模型「是否需要重新规划」的信号，
  不是让它重读整张图（真要读它会自己调 `fgs_preview`）。
- 差量只在 `rebased === true` 时附带，避免每次 commit 都多一段噪音。

### 4.5 插件侧改动

| 位置 | 改动 |
|---|---|
| `createRun` / `startActivity` | Decide run 记录 `baseRev` 与 `startGraph`（仅活动模式 + `FGS_REBASE`） |
| `fgs_commit` | 双模式：`rebase`（best-effort + 冲突回报 + delta）/ `strict`（现状，整批原子） |
| `hooks/activity_context.js` | Decide 规则段加一句：「图可能在你规划期间变化；提交时会按最新图逐项校验，冲突项会回报并保留在本次结果里。」 |
| `/fgs/state` | 增加 `graphRev`、`lastCommit.rejected` 计数 |
| `activity.jsonl` | 记录增加 `revBefore / revAfter / applied / rejected`（编排器对账用） |
| `prompts/decide.system.md` | 增加「提交前如果已经过了一段时间，先 `fgs_preview` 复核」——这是零成本的 staleness 缓解 |

### 4.6 失败与降级

| 场景 | 行为 |
|---|---|
| Decide 超时（`--decide-timeout-sec`） | 不写图、不认领；丢弃本次，`no_progress` 计数；下次触发再试 |
| Decide 进程崩溃 / 非零退出 | 同上（commit 是原子的，不会写半张图） |
| rebase 冲突率过高（rejected > applied 或 rejected ≥ 3） | 响应明确建议「重新 preview 再规划」；本轮不再自动重试，交给下一次 Decide |
| `satisfy_goal` 在并发期间被 `reopen` | 前者被 FLAG/校验门正常拦下，按冲突回报（预期罕见） |
| 图文件锁竞争 | `transactWithRev` 等锁（5s 上限），超时抛错；编排器把该 run 记为失败并继续 |
| 开关关闭（`CONTEST_CONCURRENT_DECIDE=0`） | 完全回退 v5.1 串行路径（代码分支保留，不删除） |

### 4.7 编排器台账

`orchestrator.jsonl` 每条 Decide 记录补充：

```json
{"runId":"...","activity":"decide","startedWhileExecutes":2,"revBefore":"3f2a…","revAfter":"9c1e…",
 "applied":2,"rejected":1,"durationMs":41200,"concurrentWithExecutes":true}
```

`startedWhileExecutes` 与 `concurrentWithExecutes` 是验收指标（见 §7），也方便复盘
「这次 Decide 是不是基于旧快照」。

---

## 5. 兼容性

- **legacy（未设 `FGS_ACTIVITY`）**：`fgs_commit` 永远走 strict 原子路径，`rev` 不参与；
  GUI / `/fgs new` + 聊天行为与 v5.1 完全一致（现有 298 条测试是回归网）。
- **v5.1 活动模式 + 开关关闭**：决定与 v5.1 一致（编排器走旧分支）。
- **图格式**：不变。`rev` 只在内存/台账里，`graph.yaml` 一个字节都不多。
- **profile / 安装方式**：不变（插件仍是 4 个钩子 + 工具集，无新服务依赖）。

---

## 6. 测试计划

| 层 | 用例 | 断言 |
|---|---|---|
| kernel | `revisionOf` 稳定（同图两次/跨进程一致；写一次就变） | 哈希相等/不等；`transactWithRev` 返回新 rev |
| kernel | rebase：3 op 中间一个冲突 → 其余落盘 | 图里 2 个 op 生效、1 个被拒；返回 `applied/rejected` |
| kernel | rebase：依赖链（open A → drop A）中间失败 | 后续依赖 op 一并被拒，图仍合法（`store.validate` 通过） |
| kernel | strict 模式保持整批回滚 | 既有测试不改仍绿 |
| plugin | Decide 活动：start → 外部并发写图 → commit | 冲突项回报、成功项落盘、`/fgs/state.graphRev` 更新 |
| plugin | delta：并发期间新增 Fact / 完成 step | commit 响应包含「新增 2 条 Fact」「step_004 已完成」 |
| plugin | 开关关闭 | 行为与 v5.1 相同（同一测试双跑） |
| 编排器 | Decide 与 2 个 Execute 重叠 | 三条台账的 `startedAt/endedAt` 有交叠；Decide 的 `startedWhileExecutes=2` |
| 编排器 | Decide 在跑时来了新 Finding | 只派 1 个 Decide（互斥）；Decide 结束后因 Finding 仍在基线之上再触发一次 |
| 编排器 | Decide 超时不阻塞 Execute | 两个 execute 照常 committed；decide 记录 `timedOut=true` 且无图改动 |
| 编排器 | `CONTEST_CONCURRENT_DECIDE=0` | 退化到 v5.1 的串行序列（现有 loop 测试语义不变） |
| 压测 | 4 线程「Decide + 3 执行」各 20 轮随机 op | 无丢更新（图 facts 计数守恒）、无孤儿 Fact、`validate` 全过 |

新增测试文件：`tests/rebase.test.mjs`（kernel）、`tests/plugin_v52.test.mjs`（插件）、
`tests/activity_loop_v52.test.mjs`（编排器，复用 `fake_worker.py` 的按 step/decide/conclude 选动作）。
具体断言见 §12.5。

---

## 7. 验收标准与度量

**功能验收**

1. `CONTEST_CONCURRENT_DECIDE=1` 时，Decide 在 Execute 运行期间可被派发且只派一个。
2. 任意并发序列后：图 `store.validate()` 通过；Fact 数 = 成功 op 数（无丢更新、无孤儿 Fact）。
3. 冲突操作 100% 有可读回报（op 类型 + 原因），且被移出草稿。
4. 关闭开关时，全部既有测试（298）零改动通过。

**指标（离线夹具，同一题集 A/B）**

| 指标 | v5.1 | 目标 |
|---|---|---|
| Finding 落盘 → 下一次 Decide 开始 的墙钟 | ≤ 600s | ≤ 120s（P50）/ ≤ 180s（P95） |
| 每题 Decide 次数 | K 次 Execute 一次 | 同量级（允许 +30%，来自 Finding 触发） |
| 每题 token | 基线 | ≤ +15% |
| 冲突率（rejected/applied） | — | < 10%（超过说明 Decide 太慢或 K 太小） |

---

## 8. 实施阶段

| 阶段 | 内容 | 估时 | 产出 |
|---|---|---|---|
| **M1** 保守并发（档 B） | 编排器 `decide_future` + `executeCandidate` + 独立 timeout；Decide 与 Execute 并发但**只允许 append-only op**（`drop_step`/`satisfy_goal` 遇到并发时拒并提示） | 0.5–1 天 | 调度层先跑通，冲突面几乎为零 |
| **M2** 完整 rebase（档 C） | `transactWithRev` + `revisionOf` + commit 双模式 + 冲突回报；kernel/plugin 测试 | 1–1.5 天 | Decide 全权限并发 |
| **M3** delta 回灌 + 调参 | `startGraph` diff、commit 响应、提示词、台账字段、A/B 夹具 | 0.5–1 天 | 模型能自我纠偏；指标达标 |
| **M4**（可选） | 跨进程 decide 租约、按剩余预算自适应 K/parallel | 0.5 天 | 多 visit / 极端并发下的硬化 |

上线顺序：M1 后即可在比赛默认开（风险低）；M2/M3 先 `CONTEST_CONCURRENT_DECIDE=1` A/B，
确认「冲突率 < 10% 且 token 增幅 ≤ 15%」再转默认。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **语义过期**：Decide 基于旧 Fact 规划，做出「已无意义」的 step | 浪费一轮 Execute | delta 回灌 + 提示词「提交前 preview」；Decide 本身短（30–120s），窗口小 |
| **drop 冲突多**：想废弃的 step 刚被做完 | 规划失效、token 浪费 | 冲突回报 + 下一轮 Decide 立即重规划（Finding/失败都会触发）；冲突率纳入验收 |
| **Decide 抖动**（反复 reopen/drop） | token 爆炸 | 既有 `no_progress` + `defer` 机制；再加「单题 Decide 次数上限」（`--max-decides`，默认 12） |
| 两个 Decide 同时跑 | 图/审计混乱 | 编排器互斥（M1）+ M4 文件租约 |
| 哈希 rev 误判（未变化却判变化） | 多余 delta/冲突分支 | 内容哈希是确定性的；单测覆盖「同图同哈希」；`dump` 已按固定字段顺序 |
| 并发 skill/上下文成本 | token 上涨 | 指标门槛（≤ +15%）；不达标就退回档 B |

---

## 10. 不做的事

- 不做多个 Decide 并行（违背 Cairn 项目级 reason 租约 / Cairn_Y「Decide 串行」）。
- 不让 Decide 获得环境工具（CONTRACT §4 不动）。
- 不把 `rev` 写进 `graph.yaml`（schema 冻结）。
- 不做「自动合并两个 Decide 的规划」——冲突一律回报，由下一次 Decide 决定。
- 不为并发改 `Controller.apply` 的校验规则（rebase 依赖它现有的「按传入图重校验」）。

---

## 11. 回滚

```bash
# 行为回滚（保留新包）
CONTEST_CONCURRENT_DECIDE=0
# 或退回 v5.1 串行 Decide
CONTEST_ACTIVITY_RUNS=0     # 更彻底：回到单进程长会话
```

代码回滚点：`git`/快照 `fgs-v5-1.2.0.zip`（v5.1 全绿基线，298 tests）。

---

# 第三部分：实现手册（给「上下文被压缩后接手」的 agent）

> 如果你只读这一段：先跑 `node --test "tests/*.test.mjs"` 确认基线 **298/298**，
> 然后按 §12.7 的 checklist 从 M2 开始逐项做，每步用 §12.8 的命令自检。
> 本仓库没有 git，改坏了用 `fgs-v5-1.2.0.zip` 解压覆盖。

## 12. 当前基线（已核实，可直接 grep）

这些是写方案时**实际读过**的代码事实。行号会漂移，**用 grep 锚点**而不是行号。

| 事实 | 文件 | grep 锚点 |
|---|---|---|
| 图序列化：`graphToDoc(graph)` + `dump(doc)` | `controller/index.js` | `export function graphToDoc`、`import { dump, load as parseYaml }` |
| 现有写锁事务（v5.1） | `controller/index.js` | `transact(fn) {`（GraphStore 内）、`transact(fn) {`（Controller 内） |
| `GraphStore` 字段：`graphPath/jsonPath/lockPath` | `controller/index.js` | `constructor(root, options` |
| 选择规则 / Decide 触发 / 冷启动 | `controller/activity.js` | `export function nextActivity`、`function decideDue`、`export function isColdStart` |
| 选择 CLI | `tools/activity.mjs` | `export function pickActivity` |
| run 创建 / 活动启动 / 台账 | `index.js` | `function createRun`、`function startActivity`、`function recordActivity`、`function activityOutcome` |
| `fgs_commit` 工具（strict 整批原子） | `index.js` | `toolName: 'fgs_commit'`；错误文案 `整批不落盘` |
| 配置默认值 / env 归一化 | `index.js` | `const DEFAULT_CONFIG`、`const envActivity`、`FGS_CONCLUDE` |
| 编排器 | `contest/activity_loop.py` | `def pick_activity`、`def finish_slot`、`def run_loop`、`def dispatch`、`def wait_one`、`def stop_with`、`def activity_env` |
| driver 透传 | `contest/driver.py` | `def activity_loop_argv`、`def env_number` |
| 代次断言（4 处） | `tests/*.mjs` | `PLUGIN_GENERATION, 15`、`/^15\+/` |
| 基线测试数 | 全部 | `# tests 298` |

**当前行为（必须知道，否则会改错）：**

- `fgs_commit` 现在走 `run.controller.transact(...)`，逐项 `apply`，**任一失败抛错 → 整批不落盘**
  （错误文案：`第 N 项拒收，整批不落盘`）。
- 活动模式 Decide 的 `autoClaim` 恒为 false（`!run.activity`），所以 rebase 分支可以完全跳过
  autoClaim 逻辑，不用搬那段代码。
- `nextActivity` 的 `decide` 分支目前**不返回 stepId**；新增 `executeCandidate` 不会破坏任何现有断言
  （测试只断言 `.kind`/`.reason`/签名）。
- 编排器 `pick()` 每轮都会刷新 `last_signature`/`findings_at_last_decide` 基线；并发改造要改这里
  （见 §12.3），否则 Decide 自己会被自己触发的循环卡住。

## 12.1 改动清单（按文件，含骨架）

### (1) `controller/index.js`

```js
// 顶部 import 区
import { createHash } from 'node:crypto';

// graphToDoc 之后（同文件模块作用域）
/** 图的确定性内容哈希；不落盘、不进 graph.yaml（CONTRACT §2 冻结顶层键）。 */
export function revisionOf(graph) {
  return createHash('sha256').update(dump(graphToDoc(graph))).digest('hex');
}
```

```js
// GraphStore 内，transact 旁边
loadWithRev() {
  const graph = this.load();
  return { graph, rev: revisionOf(graph) };
}

/** 事务 + 版本：fn(graph, { rev }) 返回 { graph?, ...meta }；返回 { graph, rev, baseRev, ...meta }。 */
transactWithRev(fn) {
  this.ensureDir();
  return this.withLock(() => {
    const graph = this.load();
    const baseRev = revisionOf(graph);
    const out = fn(graph, { rev: baseRev }) ?? {};
    const next = out.graph ?? graph;
    const errs = this.validate(next);
    if (errs.length > 0) throw new WriteRejected(`transact 校验不过，拒写: ${errs.join('; ')}`);
    this.saveUnlocked(next);
    return { ...out, graph: next, baseRev, rev: revisionOf(next) };
  });
}

// 旧 API 语义保持：返回图
transact(fn) {
  return this.transactWithRev((graph) => ({ graph: fn(graph) ?? graph })).graph;
}
```

```js
// Controller 内，transact 旁边
/**
 * 批量应用（v5.2）。
 * rebase=false：与「逐项 apply + 一次 save」等价，任一失败整体抛 WriteRejected（v5.1 行为）。
 * rebase=true ：逐项降级，冲突项进 rejected，其余照常落盘；返回
 *               { graph, applied:[type], rejected:[{op,detail}], rebased, revBefore, rev, baseRev }
 */
applyBatch(ops, { rebase = false, baseRev = null } = {}) {
  return this.store.transactWithRev((graph, { rev }) => {
    const applied = [];
    const rejected = [];
    let working = graph;
    for (const op of ops) {
      try {
        working = this.apply(op, working);
        applied.push(op.type);
      } catch (error) {
        if (rebase && error instanceof WriteRejected) {
          rejected.push({ op: op.type, detail: error.message });
          continue;
        }
        throw error;
      }
    }
    return { graph: working, applied, rejected, rebased: baseRev !== null && rev !== baseRev, revBefore: rev };
  });
}
```

### (2) `controller/activity.js`

只在 `decide` 返回值里加一个字段（两个 return 分支都要加）：

```js
if (dispatchable.length > 0) {
  // ... 判断 decideDue ...
  if (due) {
    return { ...base, kind: 'decide', executeCandidate: step.id,
             reason: `图有变化，先重规划（${due}）—— 再执行 ${step.id}` };
  }
  // execute 分支不变
}
// 队列空 -> decide 时没有 candidate（不加字段或给 null）
```

`tools/activity.mjs` 不需要新 flag：`pickActivity` 用 `...result` 透传，CLI 输出自动多这个字段。
顺手把 HELP 的 `kind` 行改成 `kind = bootstrap | decide | execute | ...`（已含）。

### (3) `index.js`

**配置与 env**（`DEFAULT_CONFIG` 与 `normalizeConfig`）：

```js
// DEFAULT_CONFIG 内（v5.1 参数附近）
rebase: false,          // 由 FGS_REBASE=1 打开（编排器只给 decide run 注入）
rebaseAllow: 'full',    // 'append' = M1 保守档（只允许 append-only op）
decideTimeoutMs: 0,     // 仅用于 /fgs/state 展示（超时由编排器管）
```

```js
// normalizeConfig 内，FGS_CONCLUDE 附近
const envRebase = String(process.env.FGS_REBASE ?? '').trim();
if (envRebase === '1') cfg.rebase = true;
else if (envRebase === '0') cfg.rebase = false;
else cfg.rebase = cfg.rebase === true;
const envRebaseMode = String(process.env.FGS_REBASE_MODE ?? '').trim();
if (envRebaseMode === 'append' || envRebaseMode === 'full') cfg.rebaseAllow = envRebaseMode;
const envDecideMs = Number(process.env.FGS_DECIDE_TIMEOUT_MS ?? '');
if (Number.isFinite(envDecideMs) && envDecideMs > 0) cfg.decideTimeoutMs = envDecideMs;
```

**run 状态**（`createRun` 返回对象里加）：

```js
    baseRev: null,       // Decide：启动时读到的图 rev（commit 的基线）
    startGraph: null,    // Decide：启动时快照（delta 回灌用）
    lastRebase: null,    // { revBefore, revAfter, applied, rejected }
```

**活动启动**（`startActivity` 末尾，`if (activity !== 'execute' && activity !== 'bootstrap') return { ok: true };`
之前）：

```js
  if (activity === 'decide' && run.cfg?.rebase === true) {
    try {
      const { graph, rev } = run.store.loadWithRev();
      run.baseRev = rev;
      run.startGraph = graph;
    } catch { /* 图读不了：工具调用时会暴露 */ }
  }
```

**`fgs_commit` 双模式**：保留现有 strict 代码块不动，在它前面加 rebase 分支，然后共用尾部。
最小改法（推荐）：把现有 `const applied = []; let working; let openedNow = []; try { ... } catch { ... }`
整块替换成下面结构，strict 逻辑原样搬进 `else`：

```js
      const rebaseMode = run.cfg?.rebase === true && run.activity === 'decide';
      let working;
      let applied = [];
      let rejected = [];
      let rebased = false;
      let openedNow = [];
      if (rebaseMode) {
        let out;
        try {
          out = run.controller.applyBatch(ops, { rebase: true, baseRev: run.baseRev });
        } catch (error) {
          if (error instanceof WriteRejected) return fail(`提交失败（整批）: ${error.message}`);
          throw error;
        }
        working = out.graph;
        applied = out.applied;
        rejected = out.rejected;
        rebased = out.rebased;
        run.baseRev = out.rev;
        run.lastRebase = {
          revBefore: out.revBefore, revAfter: out.rev, applied, rejected,
        };
        const delta = graphDelta(run.startGraph, out.graph);
        run.startGraph = out.graph;
        // 尾部统一用 working/applied；delta 与 rejected 只影响返回文案
        run.lastCommit = { type: 'commit', count: applied.length, at: Date.now(),
                           rebased, rejected: rejected.length };
      } else {
        // ==== 原 v5.1 strict 整批原子代码原样放这里 ====
      }
```

尾部文案在现有 `tail` 之后追加（仅 rebaseMode 且 `rebased || rejected.length`）：

```js
      const rebaseNote = (() => {
        if (!rebaseMode || (!rebased && rejected.length === 0)) return '';
        const lines = [`⚠️ 图在你规划期间变化过（rev ${run.lastRebase.revBefore.slice(0, 8)}→${run.lastRebase.revAfter.slice(0, 8)}）。`];
        const newFacts = graphDelta(run.startGraph, working)?.newFacts ?? [];   // 注意先 diff 再覆盖 startGraph
        if (newFacts.length) lines.push(`新增 Fact: ${newFacts.slice(0, 8).map((f) => `${f.id}「${f.title}」`).join(', ')}`);
        if (rejected.length) {
          lines.push('以下操作冲突未生效（草稿已移除）：');
          for (const r of rejected.slice(0, 8)) lines.push(`  - ${r.op}: ${r.detail}`);
          lines.push('建议：先 fgs_preview 复核最新图，再决定是否补一版（本轮仍可继续调用工具）。');
        }
        return lines.join('\n');
      })();
```

> ⚠️ 实现时把 delta 在**覆盖 `run.startGraph` 之前**算好（上面骨架里 `graphDelta` 调了两次，实现时改成一次）。

**`graphDelta`（模块作用域新增）**：

```js
function graphDelta(start, fresh) {
  if (!start || !fresh) return null;
  const startFacts = new Set(start.facts.map((f) => f.id));
  const startSteps = new Map(start.steps.map((s) => [s.id, s.state]));
  return {
    newFacts: fresh.facts.filter((f) => !startFacts.has(f.id))
      .map((f) => ({ id: f.id, title: f.title, findingType: f.findingType ?? null })),
    closedSteps: fresh.steps.filter((s) => startSteps.get(s.id) === 'open' && s.state !== 'open')
      .map((s) => ({ id: s.id, state: s.state })),
    newlySatisfiedGoals: fresh.goals.filter((g) => g.satisfiedAt
      && !start.goals.find((x) => x.id === g.id)?.satisfiedAt).map((g) => g.id),
  };
}
```

**M1 保守档**（`rebaseAllow === 'append'`）：在 `applyBatch` 外层先过滤——
`DROP_STEP` / `SATISFY_GOAL` / `REOPEN` 三个 op 若 `rebased === true` 则直接进 `rejected`，
不进 `apply`。实现方式：rebase 分支里先把 ops 分成 `safe` / `deferred`，`rebased` 时把
`deferred` 直接塞 `rejected`（detail：`并发模式下该操作等 Execute 清空后再提交`），否则合并应用。

**台账**（`recordActivity` 里，`conclude:` 字段旁）：

```js
      revBefore: run.lastRebase?.revBefore ?? null,
      revAfter: run.lastRebase?.revAfter ?? null,
      applied: run.lastRebase?.applied?.length ?? null,
      rejected: run.lastRebase?.rejected?.length ?? null,
```

**`/fgs/state`**（返回对象里）：

```js
        graphRev: (() => { try { return revisionOf(run.store.load()).slice(0, 12); } catch { return null; } })(),
        lastCommit: { ...run.lastCommit, rejected: run.lastCommit?.rejected ?? 0 },
```

**提示词**：`hooks/activity_context.js` 的 decide 规则段加一行：

```
'图可能在你规划期间变化：提交时会按最新图逐项校验，冲突项会回报并把原因写给你；',
'如果已经过了一段时间，提交前先 fgs_preview 复核一次。',
```

**`prompts/decide.system.md`** 末尾加一句同样的意思（中文，短）。

### (4) `contest/activity_loop.py`

新增 CLI：`--decide-timeout-sec`（默认 300）、`--max-decides`（默认 12）、
`--concurrent-decide`（`CONTEST_CONCURRENT_DECIDE=1` 时由 driver 传）、`--rebase-mode`
（`append|full`，默认 full）。`activity_env` 增加参数 `budget_ms`、`rebase`：

```python
def activity_env(args, cwd, problem_id, kind, run_id, step_id, *,
                 conclude=False, budget_ms=None, rebase=False):
    ...
    env["FGS_BUDGET_MS"] = str(int(budget_ms if budget_ms else float(args.activity_timeout_sec) * 1000))
    if rebase:
        env["FGS_REBASE"] = "1"
        env["FGS_REBASE_MODE"] = args.rebase_mode
    else:
        env.pop("FGS_REBASE", None)
        env.pop("FGS_REBASE_MODE", None)
```

`run_loop` 增加状态（与 `slots` 并列）：

```python
decide_slot: dict | None = None     # {runId, signatureBefore, startedWhileExecutes, counts}
decide_future: Future | None = None
counters["decides"] = 0
counters["decides_at_dispatch_findings"] = None
```

调度状态机（§12.3 的完整伪码）替换现有 `if not slots:` 分支。`finish_decide`（新函数，
与 `finish_slot` 并列）：

```python
def finish_decide(args, cwd, problem_id, ledger, slot, code, timed_out, duration_ms, counters):
    run_id = slot["runId"]
    rec = plugin_ledger_for(cwd, problem_id, args.state_dir, run_id) or {}
    rev_before, rev_after = rec.get("revBefore"), rec.get("revAfter")
    counters["no_progress"] = counters["no_progress"] + 1 if (rev_before and rev_before == rev_after) else 0
    # Cairn 语义：基线取「派发时」的计数，这样 Decide 期间 Execute 新落的 Finding 仍会触发下一次 Decide
    counters["findings_at_last_decide"] = (slot.get("counts") or {}).get("findings", 0)
    append_jsonl(ledger, {
        "at": utc_now(), "runId": run_id, "activity": "decide", "stepId": None,
        "signatureBefore": slot.get("signatureBefore"),
        "exitCode": code, "timedOut": timed_out, "durationMs": duration_ms,
        "pluginOutcome": rec.get("outcome"),
        "startedWhileExecutes": slot.get("startedWhileExecutes", 0),
        "concurrentWithExecutes": slot.get("startedWhileExecutes", 0) > 0,
        "revBefore": rev_before, "revAfter": rev_after,
        "applied": rec.get("applied"), "rejected": rec.get("rejected"),
        "repo": "contest/activity_loop.py",
    })
```

`stop_with`：先 `slots` 排空（现有逻辑），再 `if decide_future: wait([decide_future], timeout=args.decide_timeout_sec + 15)`，
done 后 `finish_decide`，最后写 exit marker。

### (5) `contest/driver.py`

`activity_loop_argv` 增加透传（与现有 `CONTEST_ACTIVITY_TIMEOUT` 同风格）：

```python
    if cold_start_step_enabled():          # 已有
        ...
    if env_number("CONTEST_CONCURRENT_DECIDE", 0, int):
        argv += ["--concurrent-decide"]
    argv += ["--decide-timeout-sec", str(env_number("CONTEST_DECIDE_TIMEOUT", 300))]
    argv += ["--max-decides", str(env_number("CONTEST_MAX_DECIDES", 12, int))]
    mode = os.environ.get("CONTEST_REBASE_MODE", "full").strip()
    if mode in ("append", "full"):
        argv += ["--rebase-mode", mode]
```

`README.md` 环境变量表补这 4 个旋钮（格式照抄现有行）。

### (6) 测试夹具 `tests/fixtures/fake_worker.py`

按活动类型选动作（现在只按 FGS_STEP / conclude）：

```python
    if isinstance(scenario, dict):
        if os.environ.get("FGS_ACTIVITY") == "decide":
            action = scenario.get("decide") or scenario.get("default") or {"kind": "noop"}
        elif os.environ.get("FGS_CONCLUDE") == "1":
            action = scenario.get("conclude") or {"kind": "noop"}
        else:
            action = scenario.get(os.environ.get("FGS_STEP") or "") or scenario.get("default") or {"kind": "noop"}
```

并发测试需要 Decide 睡一会：`{"decide": {"kind": "noop", "sleep": 2, "outcome": "no-op"}}`；
台账/owner/预算断言继续用现有 `FAKE_RECORD=1` / `FAKE_DUMP`。

## 12.2 新增 env / flag 一览

| 位置 | 名称 | 默认 | 作用 |
|---|---|---|---|
| 编排器 CLI | `--concurrent-decide` | 关 | 打开并发 Decide |
| 编排器 CLI | `--decide-timeout-sec` | 300 | Decide 独立墙钟 |
| 编排器 CLI | `--max-decides` | 12 | 单题 Decide 次数上限（超限后只执行/收尾） |
| 编排器 CLI | `--rebase-mode` | `full` | `append` = M1 保守档 |
| 插件 env | `FGS_REBASE=1` | — | 打开 rebase commit（只由编排器给 decide run 注入） |
| 插件 env | `FGS_REBASE_MODE=append\|full` | `full` | 保守/完整 |
| 插件 env | `FGS_DECIDE_TIMEOUT_MS` | — | 仅展示（`/fgs/state`） |
| driver env | `CONTEST_CONCURRENT_DECIDE=1` | 0 | 透传 `--concurrent-decide` |
| driver env | `CONTEST_DECIDE_TIMEOUT` | 300 | 透传 |
| driver env | `CONTEST_MAX_DECIDES` | 12 | 透传 |
| driver env | `CONTEST_REBASE_MODE` | `full` | 透传 |

## 12.3 编排器状态机（可直接照着写）

```python
while True:
    # --- 预算：activities 含 Decide；全局墙钟不变 ---
    if activities >= args.max_activities: return stop_with("budget", "活动数用尽")
    if time.monotonic() >= deadline:       return stop_with("budget", "墙钟预算用尽")

    reap_executes()          # 现有 reap()，只处理 slots
    reap_decide()            # decide_future 完成 -> finish_decide

    activity = pick()        # 现有 pick()，每轮刷新 last_signature
    kind = activity.get("kind")

    # ① 并发 Decide：不等 slot；同一时刻最多一个；受 max_decides 限制
    if kind == "decide":
        if args.concurrent_decide and decide_future is None and counters["decides"] < args.max_decides:
            dispatch_decide(activity); continue
        if args.concurrent_decide and decide_future is None and counters["decides"] >= args.max_decides:
            # 预算耗尽：有候选就继续执行，否则收尾
            cand = activity.get("executeCandidate")
            if cand and len(slots) < args.parallel:
                dispatch_execute({"kind": "execute", "stepId": cand,
                                  "signature": activity.get("signature")}); continue
            if not slots: return stop_with("defer", "Decide 次数用尽（max-decides）")
            wait_one(); continue
        if decide_future is not None:
            # Decide 正在跑：用 executeCandidate 继续填 slot；没有就等它
            cand = activity.get("executeCandidate")
            if cand and len(slots) < args.parallel:
                dispatch_execute({"kind": "execute", "stepId": cand,
                                  "signature": activity.get("signature")}); continue
            wait_decide(); continue
        # 非并发模式（v5.1）：等 slot 清空再跑
        if slots: wait_one(); continue
        dispatch_decide(activity); continue

    # ② Execute / Bootstrap：decide 在跑也照常派发
    if kind in ("execute", "bootstrap"):
        dispatch_execute(activity); continue

    # ③ 终态（done/defer/budget/wait）：Decide 在跑就先等它（它可能在写图）
    if decide_future is not None:
        wait_decide(); continue
    if kind in ("done", "defer", "budget"):
        return handle_terminal(activity)     # 现有三个分支原样搬过来
    # wait
    state["wait_retries"] += 1
    if state["wait_retries"] > args.wait_retry: return stop_with("wait", activity.get("reason"))
    if slots: wait_one()
    else: time.sleep(args.wait_seconds)
```

`dispatch_decide`：

```python
def dispatch_decide(activity):
    run_id = next_run_id(problem_id, activities + 1, "decide")
    activities += 1; counters["decides"] += 1
    counters["executes_since_decide"] = 0          # 派发即清零
    prompt = write_prompt(cwd, "decide", None, run_id)
    env = activity_env(args, cwd, problem_id, "decide", run_id, None,
                       budget_ms=args.decide_timeout_sec * 1000, rebase=True)
    future = pool.submit(run_child, child_command(args, prompt), cwd=cwd, env=env,
                         timeout_sec=args.decide_timeout_sec)
    decide_future = future
    decide_slot = {"runId": run_id, "signatureBefore": activity.get("signature"),
                   "startedWhileExecutes": len(slots),
                   "counts": activity.get("counts") or {}}
```

`finish_decide` 见 §12.1(4)。`reap_decide` = `wait([decide_future], timeout=0)` → 完成则 finish。

**Decide 不认领 step、不释放 step**：`dispatch_decide` 不调 `claim_step`；`finish_decide` 不调
`release_claim`（它没认领）。若 Decide 超时/崩溃，图零改动（commit 是原子的）。

## 12.4 行为不变量（实现后必须全部成立）

1. legacy（未设 `FGS_ACTIVITY`）下 `rebase` 永不启用，`fgs_commit` 仍是整批原子。
2. `FGS_REBASE=1` 且 `run.activity === 'decide'` 才走 rebase 分支。
3. 任何一次写盘后 `store.validate()` 必须通过（`transactWithRev` 已强制）。
4. Decide 不认领 step、不写 Fact、不调 release。
5. 同一题同一时刻最多 1 个 Decide 进程。
6. Decide 超时/崩溃：图零改动，不产生半截 Fact/step。
7. `executes_since_decide` 在 **Decide 派发时**清零；Decide 期间完成的 Execute 照常 +1。
8. `findings_at_last_decide` 取 **派发时** 的 findings 计数（Cairn `_reason_trigger` 语义）。
9. `max_activities` 包含 Decide；`--budget-sec` 是全局墙钟；`--max-decides` 超限后只执行不收尾。
10. 开关关闭时，298 条既有测试**零改动**通过；开关打开时全绿且新测试覆盖冲突/并发。

## 12.5 测试清单（新增文件 + 断言）

**`tests/rebase.test.mjs`（kernel，约 8 条）**

1. `revisionOf` 同图两次相等；写一次就变；跨进程（spawn 两个 node）相等。
2. `transactWithRev` 返回 `{graph, rev, baseRev}`；`baseRev === rev`（无外部写时）。
3. `applyBatch(rebase=true)`：`[open_step, drop_step(已 done), open_step]` → applied 2 / rejected 1；
   图里两个新 step 都在。
4. `applyBatch(rebase=false)`：同上 → 抛错且图零改动（strict 保持）。
5. 依赖链：`[open A, drop A, open from fact_origin]`，中间失败 → 后续仍可成功（独立 op）。
6. `baseRev` 与当前 rev 不同 → `rebased === true`；相同 → false。
7. 并发 RMW：两个子进程各 `applyBatch(rebase=true)` 追加一个 step → 两个都在（复用
   `tests/fixtures/concurrent_release.mjs` 的模式，新夹具 `concurrent_decision.mjs` 可选）。
8. `revisionOf` 不受 graph.json 影响（只读 graph.yaml 内容）。

**`tests/plugin_v52.test.mjs`（假宿主，约 6 条）**

1. Decide 活动 + `rebase:true`：启动后外部用 `Controller` 改图（drop open step），再提交
   `[open_step, drop_step(该 step)]` → 成功 1 / 冲突 1，响应含「冲突未生效」与 rev。
2. 同一场景 + `rebase:false` → 整批拒写，图零改动。
3. delta：并发期间新增 Fact/完成 step → 响应含「新增 Fact: fact_00X」。
4. `/fgs/state` 含 `graphRev`，且 commit 后变化。
5. 台账 `activity.jsonl` 含 `revBefore/revAfter/applied/rejected`。
6. `rebaseAllow:'append'`：并发时 `drop_step` 直接 rejected（文案「等 Execute 清空」），
   `open_step` 生效。

**`tests/activity_loop_v52.test.mjs`（真子进程，约 6 条）**

1. 并发重叠：2 个 execute（各 sleep 1s）+ decide（sleep 2s）→ 台账里 decide 的
   `startedWhileExecutes=2`、`concurrentWithExecutes=true`；两个 execute 都 committed。
2. 互斥：场景里 decide sleep 2s，期间 pick 多次返回 decide → `counters["decides"]` 只 +1
   （台账里 decide 行只有 1 条）。
3. Decide 超时：`--decide-timeout-sec 1` + decide sleep 5 → 台账 `timedOut=true`、
   `pluginOutcome=null`；两个 execute 不受影响。
4. 基线语义：execute 在 decide 期间落一条 Finding → decide 结束后立刻再起一个 decide
   （台账连续两行 decide，间隔 < 1s 级别，不依赖 sleep）。
5. 开关关闭：`--concurrent-decide` 不传 → 活动序列与 v5.1 一致（现有 loop 测试的期望）。
6. `--max-decides 1`：第二次 Decide 被抑制，执行照常。

**回归**：`node --test "tests/*.test.mjs"` 从 298 变成 298+N，全部通过。

## 12.6 实施顺序（checklist，按此顺序提交）

```
M2（完整 rebase，先做，可独立验证）
[x] 1. controller/index.js: revisionOf + loadWithRev + transactWithRev + transact 委托
[x] 2. controller/index.js: Controller.applyBatch（rebase/strict 两模式）
[x] 3. tests/rebase.test.mjs 全绿（不动 index.js 业务代码）
[x] 4. index.js: DEFAULT_CONFIG + normalizeConfig（FGS_REBASE/FGS_REBASE_MODE）
[x] 5. index.js: createRun 字段 + startActivity 记录 baseRev/startGraph
[x] 6. index.js: fgs_commit 双模式 + graphDelta + 冲突/delta 文案 + 台账字段
[x] 7. hooks/activity_context.js + prompts/decide.system.md 的 staleness 提示
[x] 8. tests/plugin_v52.test.mjs 全绿 + 298 回归全绿
M1（调度层，可在 M2 前先做，用 append 档验证）
[x] 9. controller/activity.js: decide 返回 executeCandidate
[x] 10. contest/activity_loop.py: 新 CLI + 状态机 + dispatch_decide/finish_decide/reap_decide
[x] 11. tests/fixtures/fake_worker.py: decide 场景键
[x] 12. tests/activity_loop_v52.test.mjs 全绿（先只跑 --rebase-mode append）
M3（默认化与收尾）
[x] 13. driver.py 透传 + README 环境变量表
[x] 14. 版本 1.3.0 / generation 16 / BUILD_TAG；更新 4 处测试断言
[x] 15. docs：V5_ACTIVITY_RUNS.md 补「并发 Decide」、V5_2 状态改「已实现」、V5_3 landing
[x] 16. 重打 zip（fgs-v5-1.3.0.zip），解压后跑全量测试
```

## 12.7 自检命令

```bash
cd /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0
node --test "tests/*.test.mjs" 2>&1 | grep -E "^# (tests|pass|fail)"   # 基线 298/298
node --test tests/rebase.test.mjs
node --test tests/plugin_v52.test.mjs
node --test tests/activity_loop_v52.test.mjs

# Decide 是否真的并发了（看台账字段）：
python3 - <<'PY'
import json; rows=[json.loads(l) for l in open('.fgs/orchestrator.jsonl')]
print([(r['activity'], r.get('startedWhileExecutes'), r.get('concurrentWithExecutes')) for r in rows])
PY

# 图是否一致：
node -e "import('./controller/index.js').then(async({GraphStore})=>{const s=new GraphStore('.fgs/projects/demo');console.log(s.validate(s.load()))})"

# 打包
cd /home/ubuntu/ws && rm -rf /tmp/pkg && mkdir -p /tmp/pkg/fgs-v5-1.3.0 \
 && tar -C fgs-v4-5624fa3-1.0.0 --exclude=node_modules --exclude=__pycache__ --exclude='*.pyc' \
      --exclude=.fgs --exclude=contest-work --exclude='*.bak' -cf - . | tar -C /tmp/pkg/fgs-v5-1.3.0 -xf - \
 && (cd /tmp/pkg && rm -f /home/ubuntu/ws/fgs-v5-1.3.0.zip && zip -qr /home/ubuntu/ws/fgs-v5-1.3.0.zip fgs-v5-1.3.0)
```

## 12.8 常见坑（都是会真的踩的）

1. **不要给 `graph.yaml` 加 `rev`**：CONTRACT §2 冻结顶层键，`tests/graph*` 会红。
2. **不要改 `transact` 的返回类型**：几十处调用点拿它当 graph 用；用 `transactWithRev` 做新事。
3. **`transactWithRev` 内部不能再调 `transact`**：文件锁非重入，会自锁 5s 后抛「获取写锁超时」。
4. **rebase 的 rejected 必须从草稿移除**：否则下一次 `fgs_commit` 会重复失败（进程退出后草稿本就不保留，
   同 run 内会连败）。
5. **`revisionOf` 必须用 `dump(graphToDoc(graph))`**：换 `JSON.stringify` 会因字段顺序/空值不同
   导致同一张图算出两个哈希。
6. **delta 要在覆盖 `run.startGraph` 之前算**（骨架里那两行顺序别写反）。
7. **并发测试不要依赖全局计数**：`fake_worker` 的 `fake_calls.txt` 在并发下会竞争；用按
   step/decide 选动作的 dict 场景。
8. **不要让 Decide 认领 step**：`dispatch_decide` 不调 `claim_step`；否则 Decide 退出后 step 会
   被锁在租约里（v5.0 踩过的坑，见 `V5_ACTIVITY_RUNS.md`）。
9. **`--concurrent-decide` 关闭时必须走 v5.1 分支**：现有 7 条 loop 测试对活动序列有硬断言。
10. **代次断言在 4 个文件**：`schema_ux`、`verify_v3_adversarial`、`verify_v4_adversarial`、
    `verify_v4_final`；漏一个就红。
11. **不要 kill 用户正在用的 `dsh web`**（它承载当前会话）；插件重载由用户重启。
12. **`max-decides` 超限不要直接 defer**：题还在跑，只是不再规划——用 executeCandidate 继续执行，
    没有候选再 defer。
