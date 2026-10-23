# fgs-deepseek v3（generation 9）— 变更清单

> 用户指令：**live 插件（`/mnt/d/XunLei/med-lora/fgs26-10-12`，gen 8）冻结、不再改动**；
> 所有改版都在本目录（`/home/ubuntu/ws/fgs-v3`）进行；每完成一次修复就开一个 worker 验证有效性。

## 冻结基线（live，只读，勿改）

```
83c01d415729887131c243c6f21010809a821235a1748cf9a536afc9942dcdf6  index.js
28479d529387e2adc140cd37b803848f9660eea862f2308c9c61f32f483eecd3  controller/index.js
17996b0d815fd01f0a6432773eca6ea3727a2a66f572665f287c1183b0478970  hooks/sync_context.js
40a6d40feff93fc2621f6cb423e7e45b28c240a140fa7ba0818e57defbfc6920  io-specs/execute.io.yaml
96234e24be9281979e65771e9b1fc2ecf30874d75ce5ed3c78b192f05b3c4a9d  io-specs/decide.io.yaml
```

`BUILD_TAG = 9+cairn-v2+commit-per-step+orphan-visibility+readonly-decide-tools+claim-opened+ctx-budget+egress-tools`
`PLUGIN_GENERATION = 9`

---

## 修复 1（最重要）— 缺陷 I 的二阶效应：**契约挡住 worker ⇒ worker 绕开黑板**

### 证据（真实轨迹，非推测）
worker `7585abfb` 在**一个 run** 里：`commit_step(step_027)`（a-13 入图 ✅）→ 再领 `step_028`(a-14) 失败
→ **又领 `step_029`(a-15) 并做通** → 但 Fact 再也交不上（配额），于是
**结果只写磁盘 `agent_report.md`、flag 直接 submit 刷分、完全绕过黑板**；
它两次请求 Lead「发条消息开新回合」而 **Lead 无法回复**（subagent 不可寻址，3/3 实测）。
净效果：**平台分数在涨，唯一真记忆却拿不到因果链，且没有任何信号**。

### 变更
| 旧语义 | v3 语义 |
|---|---|
| `lastCommitRound`：**每回合只能收束 1 个 step** | `(round, stepId)` 记账：**同一 step 每回合至多一次**，不同 step 可继续收束 |
| 显式换 step → 直接拒「要换 step 请结束本回合」 | 允许换到**另一个未收束**的 step（仍拒跨会话/已收束/不存在） |
| 无总量上限 | `maxCommitsPerRound`（默认 **4**）兜住「单 run 无限膨胀」的原意 |

同时把两条拒收文案改成**带出路**的（结束本回合 / 先写草稿 / 交给 Lead 代落盘 / **不要绕过黑板**）。

### 实现要点
- `createRun`: `committedRound` / `committedStepIds:Set` / `commitsThisRound`
- `observeRound`: 进入新回合时清空三者
- `pickStep`: 换步分支 + 缺省分支统一走 `committedThisRound()` / `alreadyCommittedError()`
- `forceCloseStep`: 同样按 (round, stepId) 判定，不再「本回合收束过就整体跳过」

### ⚠️ 修复过程中发现的隐藏陷阱（值得单独记住）
`refreshRole()`（`index.js:766`）每次都会执行 `run.currentStepId = mine[0].id`，
所以「刚 commit 完 A，`currentStepId` 自动变成 B」是**常态**。
因此换步分支**必须先判「这个 step 是不是本回合刚收束过」**，否则 `open.find()` 找不到（已 done）
就会退回含糊的 `不是 open step`，模型只会反复重试 —— 这个坑是**测试逼出来的**，
最初我把判定只放在缺省分支，测试立刻报 `expected /已经收束过/ but got 不是 open step`。

---

## 修复 2 — 缺陷 K/L：孤儿可见性与对账

### 证据
`openUnclaimed` 只数 `owner` 为空的；**租约已过期的孤儿在所有模型可读表面上都不计**。
实测：worker 跳过孤儿去领别的 step；被明确指派后 `fgs_claim_step(step_015)` 一次就领走
⇒ **机制正确，缺的只是可见性**。

### 变更
- `hooks/sync_context.js`（**模型每回合真正读的那一行**）：
  `【open steps】step_017[high](mine), step_025[high](可接手(租约已过期)), …`
  并新增 `【任务池】open= / mine= / unclaimed= / 可接手(租约已过期)=` 与租约分钟数。
- `/fgs/state` 的 `counts` 新增 `openTakeover`、`openOwnedByOthersFresh`。
- 判据与 guard 同源（`claimFreshInHook`），避免注入面与守卫漂移。

---

## 修复 3 — 缺陷 J：Decide 的只读/规划工具被白名单连坐

### 证据（4 例实测）
Decide 轮里 `send_message` / `present` / `get_goal` / `create_goal` 全被「白名单没有就拒」挡掉，
模型只好开一个**纯为获准说话的空转 step** 绕过去。

### 变更
判定原则从「白名单里没有就拒」改为「**只有能改变外部世界的工具才拒**」（回归 §4 本意）：
- 放行：`get_goal` / `list_agents` / `team_task_list` / `team_task_get` / `job_list` / `job_output`
  （只读控制面）+ `create_goal` / `update_goal` / `todo_write` / `skill` / `ask_user_question` / `exit_plan_mode`（规划控制面）
  + `send_message` / `present`（出站）+ `cordis_inspect_*`
- 仍然拒：`bash` / 文件类（硬拒清单 `deniedEnvTools`）+ 网络 / 委派类（当时**只是「白名单缺省」**、不在 `deniedEnvTools` 里，一旦写进 `decideAllowTools` 就会被放行——对抗测试 `C2-d` 实测）。**更正（v4）**：这里原先只是描述不实，**不是**运行时不变量——`CONTRACT §4` 已禁止 Decide 执行环境动作，是否允许通过 `decideAllowTools` 显式放行属可配置策略；v4 曾把这四者加入硬拒清单，经实战可达性复核已**回退**（见 `V4_CHANGES.md` §0 / `run2/V4_TRIAGE.md`）

---

## 测试
`node --test tests/*.test.mjs` → **130/130 绿**（基线 130 → 5 个旧断言按 v3 语义重写，新增覆盖见 `contract_fixes.test.mjs`）

## 未做（刻意）
- **未部署到 live**（用户指令：live 冻结）。要让 DSH 真正加载 v3，需切换加载路径 + 重启 DSH
  （重启会腰斩所有在飞的 agent turn）。**由用户决定何时切。**
