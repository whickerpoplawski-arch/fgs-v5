# HANDOFF — Cairn 核心思想驱动的 FGS 缺陷修复

> 更新时间：2026-10-13 09:3x
> 状态：**测试已全绿（117/117）**；但按用户要求需**以 Cairn_Y（最新版 v2）思想为核心重排计划**——见 §0.5。

---

## 0. 当前状态（2026-10-13 09:3x 更新）

```bash
cd /home/ubuntu/ws/fgs-fix && node --test tests/*.test.mjs
# → tests 117 / pass 117 / fail 0
```

**已收敛**：
- 23 个失败是**单一根因**：新增的 `OP.CLAIM_STEP` 没登记进写图 preflight（`hooks/validate_write.js` 的 `default: 未知操作类型`），
  于是每次认领都抛错、被 `refreshRole` 静默兜底成 Decide ⇒ 角色/收束/上下文全线失败。**已在 preflight 补 CLAIM_STEP 校验，一次修好 23 条。**
- FIX-6（`fgs_status` 显式拒绝未知参数 + 显示 open step 的认领状态）已落地。
- 新增 5 条回归 `tests/cairn_fixes.test.mjs`，**已用原始插件验证：原版 0 pass / 5 fail，修复版 5 pass**（真回归，不是空断言）。

---

## 0.5 ⚠️ 计划重排：以 v2（Cairn_Y）为核心

用户提供了最新版文章：
《AI 自动化渗透架构 Cairn 满分登顶 TsecBench Cybench —— 众人向左，我偏向右》
https://mp.weixin.qq.com/s/ZzKF_0MOb0cak9izhHqCUQ
→ 已提炼为 `tsecbench-run/cairn/CORE_IDEAS_v2.md`，**要求以 v2 思想为核心**。

**v2 相对 v1 的关键差异（决定后续工作）**

| v2 要点 | 插件现状 | 待办 |
|---|---|---|
| **FGS 图 = Fact-Goal-Step Graph，只追加** | 需核对 drop/reopen 的"只追加"语义 | 补不变量 + 测试 |
| **Sub Goal 可动态增删**（一等公民） | CONTRACT §1 明确"不做 SubGoal" | ❌ **必须补** |
| **Finding**（搜索过程的结构化产物，可动态定义） | 完全没有 | ❌ **必须补** |
| Decide/Execute = **独立运行过程**，同一 runner 注入不同 Prompt/Tool，**无跨会话记忆** | FIX-1 已让角色由 (图,会话) 现算 | ✅ 方向对 |
| **Decide 在"任务开始 / 图有变化"时触发，串行执行** | 任意会话随时可 Decide，无串行保证 | ⚠️ 补串行化 |
| **反对以角色为主的多 Agent / 多类专业 Subagent** | 实测子代理会继承同工作区图并直接写 | ❌ 协议层阻止 |
| Goal = 搜索的终止条件（可多个） | 只有单个 `goal_final` | 随 Sub Goal 一起改 |

> **因此：FIX-2 的"owner + 30min 租约"是 v1（Dispatcher/心跳超时）的产物，v2 不强调租约。**
> 建议保留 owner 作为 **Execute↔Step 的派发绑定**（这正是修 D1 的关键），但把"心跳租约"降级为纯安全网，
> 并把主线转向 v2 缺的能力（Sub Goal / Finding / append-only / Decide 串行 / 禁止子代理写图）。

---

## 0.6 原有开工清单（已完成，留档）

```bash
cd /home/ubuntu/ws/fgs-fix
node --test tests/*.test.mjs 2>&1 | grep '^not ok'   # 现已为空
```

---

## 1. 当前资产（都在磁盘上，可直接续）

| 路径 | 内容 |
|---|---|
| `/home/ubuntu/ws/fgs-fix/` | **修复工作副本**（原插件副本 + 我的改动）。原插件是只读参照，未改动 |
| `fgs-fix/FIXES.patch` | 相对原插件的完整 diff（475 行，含 `a/` `b/` 前缀，可 `git apply`） |
| `/home/ubuntu/ws/tsecbench-run/cairn/` | 文章取证：`article.html`（3.5MB 原文）、`slides/`（41 页 PPT）、`ocr/all.txt`（OCR 全文）、`CORE_IDEAS.md`（核心思想提炼） |
| `/home/ubuntu/ws/tsecbench-run/fgs-eval/` | FGS 评估交付物：报告 + `traces.jsonl`（117 次调用）+ 3 个可复现脚本 |
| `/mnt/d/XunLei/med-lora/fgs26-10-12/` | **原插件（live 版，未被改动）** —— `diff -rq` 已确认只有我这 3 个文件在副本里不同 |

> ⚠️ **live 插件保持原样**，所以这台机器的 FGS 现在仍跑旧语义（含那份死锁）。是否部署修复由你决定。

---

## 2. 已完成：Cairn 核心思想的提炼（`cairn/CORE_IDEAS.md`）

文章是 PPT（正文全在 41 张图里，本机模型无视觉，用 tesseract OCR 取出）。七条核心：

1. **问题本质**：近乎无限状态空间中的**有向搜索**。不变量 = 已知起点 Origin + 明确达成标准 Goal + 未知中间路径。泛化到"已知代码→必有漏洞""已知定理→待证命题"。
2. **黑板元素**：**Fact**（已落定的发现）· **Intent**（探索声明）· **Hint**（图外经验，注入判断不干预推理）。origin/goal 是特殊 Fact。
3. **Cairn 隐喻**：每个 Fact 是登山者垒的一块石头；Agent 沿前人垒的路标往上爬，同时为后来者垒新的。
4. **工作循环**：读全图 → Reason → 写 Intent → Explore → Write Back。任务指令只有 **Bootstrap / Reason / Explore**；**Agent 每次只看到「当前图 + 一条任务指令」**；**没到达 Goal 也要写结论 Fact**。
5. **架构**：黑板只保证一致性与持久化；**Dispatcher 是协议的唯一写入者**；**Agent 不直接认领 Intent、不直接 heartbeat、不直接调用任何协议接口**；**Intent 认领有心跳超时与自动释放**。
6. **协调 = Stigmergy**：Agent 之间不直接通信，**通过改变共享环境（写黑板书）协调**；图就是共享信息素环境。
7. **批判角色分工**：传统多 Agent 的角色是"人类局限的投影"；**Worker 没有身份，只有任务，任务从图里来**。Less Is More（0 MCP / 0 RAG / 0 预定义角色）。

---

## 3. 核心思想 → 缺陷的映射（这是修复的依据）

| Cairn 核心思想 | 旧 FGS 实现 | 由此产生的缺陷 |
|---|---|---|
| **Dispatcher 是协议的唯一写入者**；Agent 不直接写回协议 | 每个会话（含子代理）直接调 `fgs_*` 写同一张工作区级图 | **D1** 因果链 100% 跨会话错位（6/6） |
| **Intent 认领有心跳超时与自动释放** | step **无 owner、无租约、无超时释放**；`fgs_drop_step` 从未被调用 | **D3** 孤儿 step + 僵尸草稿 |
| **Worker 没有身份，只有任务；任务从图里来** | `run.role` 是**会话级缓存**，开 step 时定成 execute 后不再重算 | **D2** 会话死锁 + §4 环境工具禁令静默失效 |
| 黑板"可随时停止/恢复"、观测一致 | 4 个观测面各自推导（缓存/图/上下文/面板） | **D6** 互相矛盾 |
| Less Is More | `fgs_status` 沦为轮询且静默吃未知参数 | **D5** 浪费轮次 |

**一句话**：旧实现把 Cairn 的「**任务指令**」误做成了「**会话角色缓存**」，并让每个 Agent 直接写协议——
这恰好退回到文章批判的「角色分工是人类局限的投影」。

---

## 4. 已实现的修复（代码已写入 `fgs-fix/`，测试未收敛）

### ✅ FIX-1 角色 = f(图, 本会话)，每轮现算（对应 D2）
- 新增 `pickDispatchable(graph, sid, leaseMs)`：**自己已认领的 open step** > **未认领/租约过期** > 无。
- 重写 `refreshRole(run)`：不再缓存；图上有 open step 但全被别人持有时 ⇒ 本会话**没有任务** ⇒ 回 Decide（**这正是死锁的解**）。
- **guard（dispatch 层）与每轮上下文注入都先 `refreshRole`** —— 旧实现两处都直接读缓存，这是 D2 的代码级根因。

### ✅ FIX-2 step 认领 + owner + 租约（对应 D1/D3）
- `controller/ops.js`：`openStepOp` 增加 `owner/claimedAt`；新增 `claimStepOp` + `OP.CLAIM_STEP`。
- `controller/index.js`：`graphToDoc/graphFromDoc` 序列化 `owner/claimedAt`；`openStep` 落 owner；新增 `claimStep()`（租约内被他人持有 ⇒ `WriteRejected`）。
- `index.js`：`claimStep()` 走 Controller 写图；`pickStep()` 增加**跨会话拒写**（"Agent 不直接写回别人的 Intent"），缺省不再取"全局第一个 open step"。
- 新增配置 `stepLeaseMs`（默认 30 min）。

### ✅ FIX-3 本回合开的 step 允许本回合收束（对应 D3 根因）
- `commit_step`：先 resolve step，再判"一轮一步"；**本回合自开的 step 放行**。旧实现一律拒 ⇒ 产生孤儿 step + 僵尸草稿。

### ✅ FIX-4 僵尸草稿回收（对应 D3）
- 新增 `stepDraftTtlMs`（默认 60 min）+ `expireStaleDraft()`，在 `refreshRole` 里兜底清理，并置 `run.draftExpired`。

### ✅ FIX-5 观测面自证（对应 D6）
- `/fgs/state` 新增 `derivedRole`（图视角）、`roleDiverged`、`dispatch`（owned/claim/held-by-others/none）、`ownedStepId`、`draftExpired`、`counts.openOwnedByMe/openUnclaimed`。
- **面板只读、不认领**（避免别人查面板时替会话抢任务）。

### ⏳ FIX-6 `fgs_status` 拒绝未知参数（对应 D5）—— **还没做**
源码里 schema 已是 `additionalProperties:false`，但宿主没强校验（实测传 `{"action":"bad ref probe"}` 仍正常返回）。需要在 `run()` 里显式检查未知键。**同时应显示 open step 的 owner**。

### ⏳ FIX-7 回归测试（**关键未完成项**）—— 见 §5

---

## 5. ⚠️ 明天要做的（按优先级）

1. **把 23 个失败用例逐条定性**（更新断言 vs 真回归）。已知的高风险项：
   - `§5：一轮只吃一个 open step——同回合第二次 commit_step 被拒` → 被 FIX-3 有意放宽，需改成"第二次 commit 目标**不同** step 时才拒"。
   - `open step 出现后 → Execute：规划工具被硬拒…` / `§4：进入 Execute 轮后环境工具恢复` → 多半是**测试直接调 controller 建 step、没走会话**，于是 step 无 owner、会话也认领不到 ⇒ 需在测试脚手架里让 mock 会话认领，或让 `run.cfg` 在测试路径下也有值。
   - `§5：跨回合后仍然会为「没人做」的旧 step 补观察 Fact` → FIX-1 可能让"没人做"的 step 变得不可派发，**要确认这条硬规则没被关掉**。
   - `固定轨迹 replay：图与 canonical diff 完全一致` → 图多了 `owner/claimedAt` 字段，canonical 需更新（或让无 owner 时不写字段——**优先选后者**，更省事且向后兼容）。
2. **补 4 条新回归**（报告 §7 已列出）：
   - a) 两会话：A 开 step，B `submit_fact` **必须被拒**（D1）
   - b) 开 step → 收束（**由别的会话收束**）→ 断言 role 回 decide、且 Decide 环境工具禁令**真的**生效（D2）
   - c) 同回合"先收后开再想收"⇒ 要么允许、要么拒绝且**不留草稿**（D3）
   - d) 宿主 `structured output already recorded` 时给出明确降级语义（D4）
3. **FIX-6**（`fgs_status` 未知参数 + 显示 owner）。
4. **跑通 112+ 全绿**后，再决定是否部署到 live：备份原插件 → `rsync fgs-fix/ → fgs26-10-12/` → 重启 DSH 使其重载（`/fgs/state` 看 `pluginGeneration` 是否变）。
5. 更新 `CONTRACT.md`：旧契约 §1 明确写"**不做**多 worker 租约（claim/heartbeat）"——**这条已被证明是错的**（文章的核心机制之一，且正是 D1/D3 的根因）。建议改成"做：step 认领 + 租约 + 超时自动释放"。

---

## 6. 顺带确认：TSecBench 跑分任务已结束

```
GET /openapi/v1/challenges → {"code":"invalid_state","message":"task task_B5j4sujDY27C already finished"}
```
任务已完结（超时或手动停止），**无法再提交 flag**；也没有遗留活跃容器需要 close。
最终成绩：**7/63 题通关**（e1-01 e1-02 e1-03 e1-04 e1-05 e1-06 a-05），累计 1600 分。

> VPN 已于 2026-10-12 23:11 因 `SIGTERM[soft,exit-with-notification]` 断开（`tun0` 已消失、openvpn 进程已退出）。
> 任务既然结束就无需重连；**若明天还要连**：
> ```bash
> timeout 120 wsl.exe -u root -e bash -lc 'bash /root/vpn_start.sh'   # 脚本仍在，配置在 /root/vpn/tsec.ovpn
> ```

---

## 7. 环境备注（明天可能用到）

- 本机是 **WSL2**，`sudo` 需交互密码；但 **`wsl.exe -u root -e bash -lc '...'` 可直接拿 root**（同一 netns），我用它装了 openvpn / nmap / sqlmap / pwntools / tesseract。
- **本机模型（deepseek-flash）不支持图片输入**，看 PPT 一律走 tesseract OCR（`chi_sim+eng`，先 `convert -resize 300% -colorspace Gray`）。
- `web_search` 工具当前不可用（`provider "deepseek-official" is not registered`）；微信文章靠 mobile UA + curl 抓取。
- 插件 `tests/` 用假宿主，**不需要 node_modules**；跑法必须是 `node --test tests/*.test.mjs`（`node --test tests/` 会把 helper 也当测试跑而报 MODULE_NOT_FOUND）。
