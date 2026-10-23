# CONTRACT.md — FGS 黑板 · DeepSeek Harness 插件（冻结契约）

> **冻结方**：群聊「FGS黑板·DeepSeek插件」— learn sth new + Halo + 用户补充  
> **日期**：2026-10-11（AST）  
> **真源**：250 会话实测 FGS；文章叙事仅作背景，不驱动实现。  
> **用途**：vibecode 先过本文件；与 `DeepSeek_FGS_harness_plugin_design.md` 冲突时以本契约为准。

---

## 1. MVP 范围（冻结）

> **2026-10-13 v2 修订**：本节与 §2/§5 已按 **Cairn_Y（最新版）** 的核心思想修订。
> 依据：《AI 自动化渗透架构 Cairn 满分登顶 TsecBench Cybench》（提炼见 `CORE_IDEAS_v2.md`）。
> 原文：「Goal 描述项目的完成条件，即搜索的终止条件。**也存在可以动态增删的 Sub Goal**。」
> 「Finding 是 Cairn_Y 引入的一个很重要的概念……**Finding 也是可以动态定义的**。」
> 变更明细与理由见文末 **§12**。

**做**：单 `goal_final` + **可动态增删的 Sub Goal（`kind: sub`）** + FGS 图（`facts` / `goals` / `steps`）
+ **Finding（= 带 `findingType` 的 Fact，类型可动态定义）** + Decide/Execute 双 toolset（**按 v2 语义重划，见 §5**）
+ `satisfy_goal` 硬门 + `reopen` + Fact 蒸馏拒写 + **Step 派发绑定（`owner`/`claimedAt`）与显式 `claim_step`**。

**不做**：独立 `findings[]` 顶层节点（图的名字就是 Fact-Goal-Step Graph，Finding 用 Fact 的 `findingType` 表达）；
Fact–Intent 旧命名；Hint 一等公民；**以具体任务角色为主的多 Agent / 多类专业 Subagent**（v2 明确反对）。

---

## 2. 图序列化（唯一真源）

- 磁盘主真相：YAML，顶层键**仅** `facts` → `goals` → `steps`。
- ID 规则：`fact_origin` | `fact_NNN`；`goal_final` | **`goal_sub_NNN`**；`step_NNN`。
- **禁止**键：`Intent` / `Hint` / `findings`（及同义一等公民节点）。
  → **Finding 不是第四种节点**，而是 Fact 上的可选 `findingType` 标签（v2 §12）。
- 因果：`Fact(s) --from--> Step --to/producedBy--> 新 Fact`；Goal 不连边，靠 `satisfy_goal` 引用 fact id。
- **只追加（v2）**：任何「删除」都是**标记**（`step.state='dropped'` / `goal.state='dropped'` + reason），
  节点永不从数组里移除；`Fact` 一旦写入即不可变。

---

## 3. 单写者 Controller

- **只有 Controller** 改图；Decide/Execute 模型只调 tool。
- Tool 返回经**校验**后才 commit；校验失败拒写，不落盘。
- 写图路径强制过 **hooks**（见 §8）；不得靠 prompt 自觉。

---

## 4. Decide 工具白名单

| 工具 | 约束 |
|---|---|
| `open_step` | `from` 非空；预分配 `stepId` 可选（batch commit） |
| `drop_step` | **必须** `reason` |
| `change_step_priority` | `reason` 可选 |
| `preview` | 只读投影（fact 仅 id+title） |
| `commit` | 一次性提交草稿，或 `operations[]` 批量 |
| `satisfy_goal` | **必填** `{goalId, reason, satisfiedBy[]}`；缺任一字段**拒收** |
| `reopen` | 清空目标 `satisfied*` + 追加 feedback Fact；**禁止**删历史 Fact/Step |

Decide 会话**禁止**注册/调用 bash 及一切环境执行工具。

---

## 5. Execute 工具与收束

- 工具 = 环境工具（bash/read/write/edit/ls/grep/find 等，经 env 层规范化）+ `submit_fact` + `commit_step`。
- 一轮只吃 **一个** `open` step。
- 必须以 **一条新 Fact** 收束（成功或显式失败 Fact）；无 submit 也强制观察 Fact。
- **顺序铁律（v4，按角色分述）**：要用 `structured_output` 交结构化结果时 —— **Execute**：**先** `fgs_submit_fact` 落草稿（能收束就再 `fgs_commit_step`），**然后**才交结构化结果；**Decide**：**先** `fgs_commit` 把本轮图改动落盘（草稿或 `operations[]` 均可），**然后**才交结构化结果（Decide 轮调 `fgs_submit_fact` / `fgs_commit_step` 会被角色隔离硬拒）。
  原因（宿主语义，真实事故）：DSH 记录 `structured_output` 后即视该 run 结束，后续工具调用不再执行（原文报错：`structured output already recorded: the run is complete, so fgs_submit_fact is not executed`）；丢失的是该条 Fact 的具体内容（只剩 §5 的兜底观察 Fact）。
- Execute **禁止** `satisfy_goal` / `open_step` / `drop_step` / `reopen`（角色物理隔离）。

---

## 6. `reopen` 语义

触发：假 FLAG、裁判打回、外部反馈「未过」。

行为：

1. 清空对应 goal 的 `satisfiedBy` / `satisfiedReason` / `satisfiedAt`；
2. 追加一条 feedback Fact（标题点明打回原因，content 可落文件）；
3. **永不**删除历史 Fact/Step；结束不等于锁死。

Orchestrator：`satisfiedAt` 存在视为可停；若随后 `reopen`，必须继续 Decide，不得当作终态。

---

## 7. Fact 硬约束（蒸馏）

- `title` ≤ **120** 字（字符）。
- `content` 超过阈值 **N** 字节（实现常量，建议默认 8–16 KiB，可配）时，content 内必须是**文件路径**（产物落 workspace），否则 Controller **拒写**。
- 禁止把 nmap 全文 / 整页 HTML 直接塞进 fact。

---

## 8. 因果与 satisfy 硬门

**因果拒写**：

- `submit_fact` 无 `producedBy`（**origin 种题种子除外**）→ 拒；
- `step.from` 空数组 → 拒。

**FLAG / `satisfy_goal`**：

- commit 前必须过 **外部校验 hook**（提交成功 / 正则 / 赛方 ACK）；不过则**不**写入 `satisfied*`。
- 契约层拦，不靠 prompt。

---

## 9. 上下文与 I/O（用户补充）

- 每次 Decide/Execute 会话：**干净上下文**，只啃一个小问题（Decide=整图规划；Execute=单 step）。
- 写图与 planner/subagent **上下文同步**（图变 → 下一轮 user 塞最新 YAML/投影）。
- 给 LLM **预制 I/O 规范**（`io-specs/`）；过滤工具进出，裁掉噪声再进模型。
- Windows：env 层统一 **WSL / PowerShell** 用法（路径、shell 选择、命令包装），业务代码不散落平台分支。

---

## 10. 必须交付的测试资产（Halo）

- `fixtures/`：至少 3 个 golden — `origin-only` / `mid-graph` / `post-satisfy` YAML。
- `controller` 单测：非法 `satisfy_goal`、缺 reason 的 drop、超长 fact、reopen 后 `satisfied*` 清空、因果拒写、FLAG verify hook 失败不 commit。
- 离线 replay：固定 Decide/Execute JSON 轨迹 → 断言图 diff（不接真模型）。

脚手架可以丑；**拒写规则不能丑完再补**。

---

## 11. 目录落点（相对插件根）

```
CONTRACT.md                 # 本文件（拷贝进仓库根）
fixtures/                   # golden YAML
controller/                 # 校验 + commit 单写者
hooks/                      # 写图 / FLAG verify / 同步
io-specs/                   # LLM 工具 I/O 预制 schema
env/windows.*               # WSL/PS 规范化
```

实现细节见 `DeepSeek_FGS_harness_plugin_design.md`；本契约只冻结「必须如此」。

---

## 12. v2（Cairn_Y）修订记录

> 触发：用户提供 Cairn 最新版文章并要求**以最新版思想为核心**后续工作。
> 来源：《AI 自动化渗透架构 Cairn 满分登顶 TsecBench Cybench —— 众人向左，我偏向右》
> https://mp.weixin.qq.com/s/ZzKF_0MOb0cak9izhHqCUQ ｜ 提炼：`CORE_IDEAS_v2.md`

### 12.1 修订条目

| # | 原冻结条款 | v2 修订 | 理由（原文依据） |
|---|---|---|---|
| 1 | 不做 `kind: sub` SubGoal | **做**：Sub Goal 一等公民，可动态增删 | 「Goal 描述项目的完成条件，即搜索的终止条件。**也存在可以动态增删的 Sub Goal**。」 |
| 2 | 不做 Finding | **做**：`Finding = 带 findingType 的 Fact`，类型可动态定义（`config.findingTypes`，留空即自由定义） | 「Finding 是 Cairn_Y 引入的一个很重要的概念……**Finding 也是可以动态定义的**。」 |
| 3 | 未明确 | **图只追加**：删除一律是标记（`state='dropped'` + reason），节点永不移除 | 「把搜索过程的全部状态外化成一张**只追加**的图。」 |
| 4 | 「有 open step → Execute，否则 Decide」 | **role = 本会话是否被派发（持有）一个 open Step**；没有 → Decide | v2：Decide/Execute 是「**独立的运行过程**，而非固定角色的 SubAgent」，且「**没有独立的跨会话记忆机制**」——所以不能把角色缓存成会话状态 |
| 5 | 未明确 | **Decide 必须能在有 open step 时工作**：`open_step`/`drop_step`/`change_step_priority`/`add_subgoal`/`drop_subgoal`/`commit`/`preview`/`claim_step` 在两类活动都放行 | v2：Decide 在「**图上信息有增加或者变化时**被触发」，职责是「对 Step 进行评估，进行 Step 的添加、废弃或者优先级调整」——这必然发生在有 open step 时；否则图会僵死 |
| 6 | 多 worker 租约**不做** | **做**：`claim_step` + `owner`/`claimedAt`（`stepLeaseMs` 默认 30min 超时后可被接手） | v1《无径之径》：「**Intent 认领有心跳超时与自动释放**」「Dispatcher 是协议的唯一写入者」；而实测证明「谁先看到谁执行」会造成 **6/6 跨会话因果链错位** |
| 7 | 未明确 | **§4 收窄为真正重要的那条**：没有 Step 的会话不得使用环境执行工具；goal 级判断（`satisfy_goal`/`reopen`）仍由 Decide 独占 | v2 只规定 Decide「只拥有查看和操作 FGS 图的 Tool」、Execute 拥有改世界状态的 Tool；互相禁止图操作并非 v2 要求，且会造成僵死 |

`executeSessionTtlMs`（默认 10 分钟）是**单题 Execute 会话墙钟**。到期由 Controller 写一条未完成 Fact，并把当前 open step 的 `owner`/`claimedAt` 放回任务池（step 仍为 open，挂上 `linkedUnfinishedFactId`），题目标 `deferred`（`state` / `deferredAt` / `deferredReason`）。deferred 之后本题拒绝 `open_step`、`claim_step`、会重新进入 Execute 的 `commit`，以及环境执行工具；只读与不重新认领的规划工具仍可用。没有其它可做题时，插件调用宿主已有的 `concludeTurn` 结束本会话。重复结算不改已写入的 `deferredAt` / `deferredReason`，也不删图节点。`stepLeaseMs`（默认 30 分钟）只决定别人何时能 `claim_step` 接手仍被占用、且**尚未 deferred** 的 step。两者正交：租约过期不写未完成 Fact，会话 TTL 也不替换租约，且不用 goal 级 `reopen`。

### 12.2 保留不变的

- 图是**唯一外化记忆**；顶层键只有 `facts` / `goals` / `steps`。
- 单写者 Controller + 写图前 preflight；校验失败拒写、不落盘。
- Fact 蒸馏（title ≤120 字 / content >8KiB 必须是产物文件路径）；因果铁律（`from` 非空且存在）。
- `satisfy_goal` 外部校验硬门；`reopen` 只清 `satisfied*` 并追加 feedback，永不删除历史。
- 「没在时限内到达 Goal 也要写下结论 Fact」（`forceCloseStep` 兜底）。
- Decide/Execute 都从**干净上下文**起，无跨会话记忆。

---

## 13. 图与外部世界：**不做**自动对账（v4）

- FGS 图**不与外部世界/平台自动对账**：题目已完成、flag 已提交后，对应 step 仍可能是 `open`（实测 `step_018` / `step_020`）。
- 代价：该 step 会被再次开工，白占容器额度；图上的 `open` **不等于**「确实还没做完」。
- 唯一正确处置：**协调者（Lead）用 `fgs_drop_step` 显式回收**（只回收未认领（unclaimed）或租约已过期的 step；不要 drop 别人租约内在跑的 step；`dropped` 只作标记，保留历史、不删图）。
- **禁止**声称「插件会自动收束已完成的题」——不存在与世界状态的自动对账（§5 的回合收口观察 Fact 兜底不在此列）。

---

## 14. v5.1 活动 run 协议（编排层，不改 kernel 契约）

活动模式（`FGS_ACTIVITY=decide|execute|bootstrap`）把上面 §4/§5 的「同一会话切角色」
换成「一个 run 只做一个活动」，kernel 的 schema / 校验 / FLAG 硬门 / 图格式完全不变。
完整设计见 [`docs/V5_ACTIVITY_RUNS.md`](docs/V5_ACTIVITY_RUNS.md)。

1. **工具面在注册期隔离**：Decide 只注册图工具；Execute 只注册
   `fgs_status/fgs_preview/fgs_submit_fact/fgs_commit_step`；Bootstrap 再加
   `fgs_satisfy_goal/fgs_commit`（Cairn bootstrap 的 fact+complete 权限）。
   越权工具不是「被拒」，而是根本不存在。
2. **认领由编排器做**：`tools/claim_step.mjs` 在起进程前写 `owner=<runId>`；
   插件 `startActivity` 只校验并复用，不参与抢任务（Cairn：Dispatcher 是唯一派发者）。
3. **写图走事务**：每个写动作经 `GraphStore.transact`（文件锁覆盖 load→apply→validate→save），
   因此同题多个 Execute 并行时不会丢更新。直接 `apply + commit` 只允许在测试/工具里
   单进程串行使用。
4. **失败语义**：超时或「正常退出但没落盘」→ 同 session 收束轮（`FGS_CONCLUDE=1`）；
   收束失败/非零退出 → `release_step` 追加**一条**未完成 Fact（幂等）并清 owner；
   其它 run 的 step 一律不得收束（`pickStep` 硬拒）。
5. **预算**：`FGS_BUDGET_MS` 写进本轮上下文；到点由编排器杀进程（模型侧不承担计时）。
6. **legacy 模式不变**：未设置 `FGS_ACTIVITY` 时，§4/§5 的单会话角色切换行为原样保留。
7. **v5.2 Decide rebase（仍不改 kernel 契约）**：图版本 `rev` 是 `sha256(dump(graphToDoc(graph)))`
   的**内存/台账值，绝不写进 `graph.yaml`**（§2 顶层键冻结）。只有 `FGS_REBASE=1` 且
   `FGS_ACTIVITY=decide` 的 run 走 `Controller.applyBatch(..., {rebase:true})`：
   逐项按最新图校验，冲突项回报给模型、其余照常落盘；legacy 与 Execute 仍是整批原子。
   `fgs_commit` 的响应文案与台账 `revBefore/revAfter/applied/rejected` 是这条路径的观测面。
