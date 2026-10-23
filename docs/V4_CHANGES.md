# fgs-deepseek v4（generation 10）— 最小修复清单

> 仓库：`/home/ubuntu/ws/fgs-v4`（`/home/ubuntu/ws/fgs-v3` 的完整副本，gen 9，基线 **149/149 绿**）。
> 本目录改过的文件：`index.js`、`CONTRACT.md`、`V3_CHANGES.md`、`io-specs/{decide,execute}.io.yaml`、
> `tests/{contract_fixes,verify_v3_adversarial,fix_v4_minimal,verify_v4_adversarial}.test.mjs`。
> live 插件 `/mnt/d/XunLei/med-lora/fgs26-10-12` 与冻结基线 `fgs-v3` **一律未动**。
> ⚠️ **本文正文含历史记录（按时间顺序），其中若干条目已被后续复核回退——以 §0 为准。**
> 测试命令：`cd /home/ubuntu/ws/fgs-v4 && node --test tests/*.test.mjs`

`PLUGIN_GENERATION = 9 → 10`
`BUILD_TAG = '10+cairn-v2+commit-per-step+orphan-visibility+readonly-decide-tools+claim-opened+ctx-budget+egress-tools+draft-no-loss+cap-in-forceclose'`
> （历史快照：F5 回退前曾带 `+deny-net-delegate`，现已移除。）

---

## 0. 最终状态与回退记录（权威，后写的覆盖先写的）

**裁决依据**：`run2/V4_TRIAGE.md`（用实战数据逐条核可达性）。原则：**只修为「实战已暴露」或「我们自己引入的回归」；审计构造、实战不可达的改动一律回退。**

| 项 | 最终状态 | 理由（实战数据） |
|---|---|---|
| F1 `structured_output` 进 Decide 出站白名单 | ✅保留 | **实战暴露**：4 次 `FGS Decide 会话禁止调用 structured_output`（run1） |
| D1/F6a 顺序规则**按角色**分述 | ✅保留 | **实战暴露**（1 次 Fact 真丢）＋我们在 A 里写错角色（回归） |
| F2 兜底补交保留 `findingType` | ✅保留 | 对抗可复现；1 个字段，同族路径实战命中过 |
| F3 删掉「过期草稿只留 5 条」截断 | ✅保留 | 删 1 行；同族缺陷 M（内容被吞）**实战命中 1 次**（`fact_031`） |
| F4 兜底收束受 cap 约束 + `cap > 0` 前置 | ✅保留 | 2 行；补的是 v3 自身守卫漏洞，且防止 F4 自己把不变量 1 打穿 |
| C io-spec 多行 YAML → 单行 + `loadIoSchema` 不再静默 | ✅保留 | **我们引入的真实故障**：解析抛错 ⇒ 整段 I/O 规范注入消失（测试 §9 抓到） |
| D5 契约措辞一致性（§5/§13 矛盾、`Lead` 未定义、drop 前置条件） | ✅保留 | 我们在 B 里引入的自相矛盾，不修等于发布错误规范 |
| V3_CHANGES.md:81 更正 `deniedEnvTools` 不实描述（P4 根因） | ✅保留 | P4 的根因是**文档不实**；只改文字、不动运行时（F5 的代码部分已回退） |
| **F5** 四个网络/委派类加入 `DEFAULT_DENIED_ENV_TOOLS` | ❌**已回退** | 实战零影响；只有自定义 `deniedEnvTools` 才绕过 ⇒ 纯审计路径。P4 的根因是**文档不实**，已由文档修正闭合 |
| **D3** io-spec「硬拒」注释 | ❌**已回退** | 随 F5 |
| **D4**「structured_output 是汇报通道不是存储通道」 | ❌**已回退** | 纯政策文字，无实战证据 |
| **D6** 多条过期草稿亮出条数/stepId | ❌**已回退** | 属可用性增强；实战同一会话最多 1 条过期草稿 |
| **D7-extra** io-spec `tools:` 补 3 个图工具 | ❌**已回退** | 既有文档漂移，实战无碍（只保留 `structured_output`，与 F1 绑定） |

**最终测试数字：`node --test tests/*.test.mjs` → 181 tests / 181 pass / 0 fail**（本文其他地方出现的 155/153/2、182/181/1 均为历史快照）。
`BUILD_TAG` 同步去掉已回退项的 `+deny-net-delegate` 标记。

---

## 六个已确认缺陷的修复

### F1（高）Decide 白名单漏掉 `structured_output`
- **为什么**：用 schema 派生的子代理在 Decide 轮无法交付结构化结果（实测 4 次被拒：
  `Error: FGS Decide 会话禁止调用 structured_output`）。
- **改动**：`EGRESS_TOOLS` 加入 `'structured_output'`（`index.js:163`），上方注释的枚举同步加词
  （`index.js:154`）。它是「把已产出的结果交出去」的出站通道，不动世界状态；该工具只在结构化运行的
  子代理里存在，平时不存在，加了无副作用。

### F2（中）`forceCloseStep` 兜底补交丢 `findingType`
- **为什么**：`vuln` 经 turn-stopping 兜底补交时静默降级成 `info`（commit_step 路径本已保留）。
- **改动**：`index.js:1821` 的 `submitFactOp({...})` 增一个属性 `findingType: draft.findingType ?? null`。

### F3（中）过期草稿只保留最近 5 条 ⇒ 更早内容静默丢失
- **为什么**：每次 `submit_fact` 都返回 `ok:true`，但第 6 条把第 1 条挤出数组，丢得无声无息。
- **改动**：删除旧 `index.js:754` 的截断
  `if (run.expiredDrafts.length > 5) run.expiredDrafts.splice(...)`。
  `expiredDrafts` 是会话级、run 结束即释放，只会被「补交落盘 / 注入面展示」消费，无「最多 5 条」依赖。

### F4（低）`maxCommitsPerRound` 约束不了回合兜底收束
- **为什么**：`turn-stopping` 的兜底 `forceCloseStep` 不看 cap，同一回合实收 = cap+1。
- **改动**：`index.js:1789-1790`，`limited` 为真时 `(run.commitsThisRound ?? 0) >= cap` 直接 `return false`；
  `cap` 与 `commit_step` 同源取值（`Number.isFinite(...) ? ... : 4`）。
  保住的**不变量**：`limited` 为假（turn 未知 / 信号收尾）时不做上限判断；
  本回合 0 次收束时 `0 < cap`，回合收口**仍然**落一条观察 Fact。

### F5【已回退，见 §0】（低，纵深防御）`DEFAULT_DENIED_ENV_TOOLS` 不含网络/委派类
- **为什么**：`web_fetch`/`web_search`/`subagent`/`workflow` 仅「因不在白名单」被拒，
  一旦写进 `decideAllowTools` 就放行。
- **改动**：`DEFAULT_DENIED_ENV_TOOLS` 加 4 个字符串（`index.js:138-141`）。硬拒优先于白名单。

### F6a（中）「先落 Fact 再交结构化结果」的顺序规则没写进注入文本
- **为什么**：宿主一旦记录结构化输出即视本 run 结束，同回合后续 `fgs_submit_fact` 会被丢弃
  （实测原文 `structured output already recorded: the run is complete, so fgs_submit_fact is not executed`）。
- **改动**：`FGS_RULES` 加一行（`index.js:248`）。**只**讲顺序要求，不写「会被拒」——
  F1 之后 `structured_output` 在两类活动都放行，提示词不得与 guard 打架。

### F7 代次标记
- `index.js:48` `PLUGIN_GENERATION` `9 → 10`；
- `index.js:56-58` `BUILD_TAG` 前缀 `9+ → 10+`，末尾追加
  ~~`+draft-no-loss+cap-in-forceclose+deny-net-delegate`~~ **（历史快照：F5 回退后该段为 `+draft-no-loss+cap-in-forceclose`）**（原有 `commit-per-step` / `orphan-visibility` /
  `readonly-decide-tools` 等子串全部保留）。

---

## 为什么改写这 5 处既有断言

`tests/verify_v3_adversarial.test.mjs` 的这 5 个测试当初是**反例测试**（断言缺陷存在），
修好缺陷后它们断言的是「错误行为」，因此改写为「修复后的正确行为」，测试名 `【对抗】→【修复】`，
并在测试内保留一行注释写明旧断言：

| 测试 | 旧断言（缺陷行为） | 新断言（修复后正确行为） |
|---|---|---|
| `C1-e` | cap=2 时兜底又落一条，`graph` 出现 `step_003 无有效产出`（实收 3 > cap） | 兜底不再收束：Fact 数不变、无 `step_003 无有效产出`、`step_003` 保持 `open` |
| `C2-d` | 四者写进 `decideAllowTools` 后 `ok===true`（因不在硬拒清单里） | ~~改为断言硬拒~~ **已回退为 v3 原文**（F5 回退后「放行」重新成为事实，见 §0） |
| `C4-c` | `doesNotMatch(/findingType: vuln/)`（`vuln` 被吞） | `match(/findingType: "vuln"/)`（YAML 会加引号，必须按带引号形式断言） |
| `C4-d` | 6 条草稿只留 5 条，`doesNotMatch(/草稿0/)` | 6 条分别绑定 6 个 step、跨回合逐条补交，`草稿0..草稿5` 全部落盘、无 `无有效产出` |
| `C4-e` | `PLUGIN_GENERATION === 9`，文案 gen 9 | `PLUGIN_GENERATION === 10`，文案 gen 10（三条 `BUILD_TAG` 断言不变） |

> `C4-c` / `C4-d` 的旧断言其实写得偏弱（`findingType: vuln` 少了引号、单 step 只能落一条），
> 修好缺陷后旧断言会「空转通过」。这里一并改成能真正证伪的强断言，避免留下假绿。

---

## 新增聚焦测试

`tests/fix_v4_minimal.test.mjs`（6 条，每修复至少 1 条）：F1 出站放行 + `bash` 仍拒；
F2 兜底保留 `findingType`；F3 6 条过期草稿不丢；F4 cap 生效且 0 次收束仍落观察 Fact；
F5 `web_fetch`/`workflow` 写进白名单仍拒；F6a 注入文本含顺序要求。

## 验证状态（如实记录）

`node --test tests/*.test.mjs` → **155 tests / 153 pass / 2 fail**。两条失败**均不在本次允许写入的 4 个文件内**：

1. `tests/contract_fixes.test.mjs:84`「§4：decideAllowTools 可配置扩展白名单」——
   该测试断言 `decideAllowTools:['web_search']` 时 `web_search` 放行，与 F5「硬拒优先」直接互斥。
   它不在任务点名的 5 个可改测试之列，故未改动；需要一行断言更新（或把 `web_search` 移出 F5 清单）。
2. `tests/contract_fixes.test.mjs:310`「§9：io-specs 注入」——
   另一子代理刚改的 `io-specs/decide.io.yaml` / `execute.io.yaml` 第 46 行使用多行纯量
   （plain scalar），仓库自带 `yaml.js` 解析器直接抛「YAML 缩进异常」→ `loadIoSchema` 返回 null。
   属 `io-specs/` + `yaml.js` 范围，本次未越权改动。

---

## 收尾修复 C（2 条范围外红 + 1 处可诊断性加固）

### C-1（P0，真实故障）io-spec 多行 plain scalar → 解析抛错 → 整段注入消失
- **故障链**：`io-specs/decide.io.yaml` / `io-specs/execute.io.yaml` 的 `notes:` 末条被写成跨两行的
  plain scalar（原 45-46 行）。仓库自带的 `yaml.js` 只支持 `|`/`>` 块标量与单行 plain scalar，
  **不支持多行 plain scalar**；解析到第 46 行（缩进 4、非 `- ` 项、非映射）时在 `parseMap` 抛
  `YAML 缩进异常（第 46 行）`。`index.js` 的 `loadIoSchema()` 是 `try { ... } catch { return null; }`，
  异常被静默吞掉 ⇒ 该角色 `ioSpec` 恒为 `null` ⇒ 注入文本里**整套 I/O 预制规范消失**。
  表象只是 `§9` 一条测试红，真实危害是模型在 Decide/Execute 轮看不到全部 I/O 预制规范。
- **最小修法**：把两处 notes 末条由「跨两行」改为**单行**（仅删掉换行与续行缩进，正文逐字未改，
  顺序要求 + 宿主语义原因全部保留）。
  - `io-specs/decide.io.yaml:45`（原 45-46，-1 行）
  - `io-specs/execute.io.yaml:45`（原 45-46，-1 行）
- **自证**：用 `yaml.js` 直接 `load` 两个文件均成功，`notes` 各 5 条，末条以「顺序：」开头（顺序要求在）。
- **全仓排查**：两个 io-spec 已无「非注释、非 `- ` 项、非映射」的续行；`filter:` 下两条 2 空格缩进
  是合法嵌套映射，不是多行标量。

### C-2【已回退，见 §0】（范围外红 #1）`contract_fixes §4` 示例工具迁移
- **原因**：旧用例断言 `decideAllowTools:['web_search']` 时 `web_search` 放行；v4 已把 `web_search`
  放进 `DEFAULT_DENIED_ENV_TOOLS`（硬拒优先于 `decideAllowTools`），该断言与 F5 直接互斥。
- **旧示例**：`web_search`（对照 `web_fetch` 仍被拒）。
- **新示例**：`team_task_create` —— 不在 `DEFAULT_DENIED_ENV_TOOLS`，也不在
  `DEFAULT_DECIDE_ALLOW_TOOLS`，只有写进 `decideAllowTools` 才放行；对照仍为 `web_fetch`（硬拒不受影响）。
  用例内注释保留「旧示例是 web_search、为何迁移」（硬拒语义由 `C2-d` 与
  `tests/fix_v4_minimal.test.mjs` 的 F5 覆盖）。
- **未采用 `todo_write`/`skill`**：它们本就在 `DEFAULT_DECIDE_ALLOW_TOOLS`（`PLAN_CONTROL_TOOLS`），
  即使 `decideAllowTools` 失效也会放行 ⇒ 断言会空转（弱化），故改用真正「本来会被拒」的工具。
- 仅改 `tests/contract_fixes.test.mjs:84-104`（原 84-91，+13 行），该文件其他内容未动。

### C-3（可诊断性加固）`loadIoSchema` 不再静默
- `index.js:878-884`：`catch { return null; }` → `catch (err) { console.warn('[fgs] io-spec …解析失败，已跳过注入: …'); return null; }`。
  行为不变（仍返回 null、仍不阻断 apply），只是 io-spec 写坏时不再悄无声息。**只改这一个 catch**（+5 行）。
  （仓库此前无 `console.*` 用法；此处仅在解析失败、且每次 apply 至多触发两次，噪声可忽略。）

### 最终测试数字
`cd /home/ubuntu/ws/fgs-v4 && node --test tests/*.test.mjs` → **155 tests / 155 pass / 0 fail**
（修复前 153 pass / 2 fail）。

---

## 收尾修复 D（两位独立评审的残留问题）

> 评审输入：对抗验证 23 例 + 架构审查 398 行。
> 只改了允许写入的 6 个文件；`PLUGIN_GENERATION`（保持 10）与 `BUILD_TAG` 一律未动
>（架构审查明确要求本轮不再滚代次 / 清理旧 token）。

### D1（HIGH）顺序规则与 guard 打架（历史缺陷 A 的复现）
- **为什么**：`★ 用 structured_output 交结构化结果之前，必须先 fgs_submit_fact…` 原本写在 **Decide 段落内部**
  （讲 Decide 的 244-251 行之间），而 Decide 轮调用 `fgs_submit_fact` 会被 guard **硬拒**
  （`FGS 角色隔离：当前 Decide 轮不得调用 fgs_submit_fact`）；结构化交付事故恰恰发生在 Decide 场景
  ⇒ 模型被指到一个本轮不可用的工具名。
- **改动**：
  - `index.js:248`：改为 Decide 专述 —— 必须先用 `fgs_commit` 把本轮图改动落盘（并注明 Decide 不得调
    `fgs_submit_fact` / `fgs_commit_step`）+ 宿主语义原因；
  - `index.js:254`：**新增 1 行** Execute 专述 —— 必须先 `fgs_submit_fact` 落草稿（能收束就再 `fgs_commit_step`）+ 同一原因；
  - `CONTRACT.md:68-69`：顺序铁律改为**按角色分述**（Execute = `fgs_submit_fact`→`fgs_commit_step`；
    Decide = `fgs_commit`），原因句保留；
  - `tests/fix_v4_minimal.test.mjs:203-223`（F6a）：改为**按角色双断言** —— 取 `fgs-rules` 段文本，
    以 `- 本会话持有（owner = 本会话）一个 open step → Execute` 为锚点切成 Decide 段 / Execute 段；
    Decide 段**不得**出现 `必须先 fgs_submit_fact`、**必须**出现 `必须先用 fgs_commit 把本轮图改动落盘`；
    Execute 段**必须**出现 `必须先 fgs_submit_fact 落草稿`。不再用整段注入文本做模糊断言。

### D2（LOW-MED）`cap=0` 打穿契约不变量 1
- **为什么**：架构审查实测 `maxCommitsPerRound: 0` 时 `if (limited && (run.commitsThisRound ?? 0) >= cap)`
  命中 `0>=0` ⇒ 本回合 **0 条新 Fact**、step 仍 open（「回合必须以一条新 Fact 收束」被破）。
- **改动**：
  - `index.js:1803`：`if (limited && cap > 0 && (run.commitsThisRound ?? 0) >= cap) return false;`
    （cap 只限制「超过 cap 后的继续收束」，不抑制本回合的第一次兜底）；
  - `index.js:1616` / `index.js:1802`：回落的字面量 `: 4` → `: DEFAULT_CONFIG.maxCommitsPerRound`（消除漂移，语义不变）；
  - `tests/fix_v4_minimal.test.mjs:249-258`：新增用例 —— `maxCommitsPerRound: 0` 时 turn-stopping 仍落观察 Fact。
- **副作用（必须让 Lead 知道）**：`tests/verify_v4_adversarial.test.mjs:426-443` 的 **F4-d** 断言的正是旧退化行为
  （`cap=0 时 0 次收束也不落观察 Fact`），本修复让它按设计必红；该文件在「禁止改」清单内，故**未改**
  （精确修法见文末「遗留红」）。

### D3【已回退，见 §0】（MED，纯注释）"硬拒"不是地板
- `io-specs/decide.io.yaml:35-36` 原把优先级写成无条件。事实是 `normalizeConfig`（`index.js:277-279`）
  对**非空** `deniedEnvTools` 是**整体替换**默认清单 ⇒ 用户自定义 `deniedEnvTools:['bash']` 时
  `web_search` 反而可能被 `decideAllowTools` 放行。
- 改为如实两句：默认清单下硬拒优先；**若配置显式提供非空 `deniedEnvTools`，默认清单被整体替换**（硬拒不再保证）。
- `V3_CHANGES.md:81` 的更正由写入者 B 完成（把「网络/委派类在 deniedEnvTools 里」更正为「当时只是白名单缺省」，并注明 v4 的硬拒尝试已回退）。

### D4【已回退，见 §0】（MED，纯文字边界）`structured_output` 是汇报通道，不是存储通道
- **为什么**：宿主真源 —— `structured_output` 会 `concludeTurn()`，被记录后该 run 后续工具调用全部变 no-op；
  其载荷直达父代理 ⇒ 可绕过黑板的 `producedBy` 因果链与 §8 的 flag 硬门。
- **改动**：`CONTRACT.md:70` 加 1 行；`io-specs/decide.io.yaml:50` 与 `io-specs/execute.io.yaml:47` 的 notes 各加同一条。

### D5（MED/LOW，纯文字一致性，共 3 小处）
- `CONTRACT.md:179`：「不存在任何自动收束」与 §5「无 submit 也强制观察 Fact」字面冲突 ⇒
  改为「不存在与世界状态的自动对账（§5 的回合收口观察 Fact 兜底不在此列）」；
- `CONTRACT.md:178`：回收动作补前置条件（只回收未认领（unclaimed）或租约已过期的 step；不要 drop 别人租约内在跑的 step）；
  未定义的 `Lead` → `协调者（Lead）`；
- `CONTRACT.md:69`：「曾因此静默丢失一条 Fact」→「丢失的是该条 Fact 的具体内容（只剩 §5 的兜底观察 Fact）」。

### D6【已回退，见 §0】（LOW）多条过期草稿的可发现性
- **为什么**：`draftSummary` 只亮**最后 1 条**过期草稿，模型不知道还有 N-1 条
  （F3 修好了「不丢」，但恢复率取决于模型是否碰巧去补交）。
- **改动**：`index.js:837-848` —— 只有 1 条时文案**逐字不变**；`> 1` 条时带上**条数与 stepId 列表**
  （内容仍只列最近一条）：`⚠️ 已回收 N 条草稿（stepId: …），内容仍保留：commit_step <对应 stepId> 可逐条补交；最近一条：fact(…)`。
- 测试：`tests/fix_v4_minimal.test.mjs:227-245` —— 造 6 条过期草稿，断言注入文本含 `已回收 6 条草稿` 与 `step_001` / `step_006`。

### D7【部分回退，见 §0】（LOW，清单一致性；仅保留 `structured_output`）
- `io-specs/decide.io.yaml:18-21` 的 `tools:` 补 `fgs_claim_step` / `fgs_add_subgoal` / `fgs_drop_subgoal` / `structured_output`
  （这些在 Decide 由 guard 放行，且 v4 起 `structured_output` 也放行；漏列会让模型不知道可用）；
- `io-specs/execute.io.yaml:20` 的 `tools:` 补 `structured_output`。
- **每项一行**（`yaml.js` 只支持单行 plain scalar，不续行）；已用 `yaml.js` 复验两文件解析成功（tools=14/19，notes=6/6）。

### 最终测试数字（本轮）
`cd /home/ubuntu/ws/fgs-v4 && node --test tests/*.test.mjs` → **182 tests / 181 pass / 1 fail**。
唯一失败为 **F4-d（范围外，见下）**。

### 遗留红：F4-d 与 D2 直接互斥（超出本轮写入范围）
- 位置：`tests/verify_v4_adversarial.test.mjs:426-443`，失败断言在第 437-438 行
  （`assert.equal(countFacts(cwd), before, '复现退化行为：cap=0 时「0 次收束」的回合兜底也被关掉，不落观察 Fact')`）。
- 该用例名即「【退化】…（不变量 1 在该退化配置下破了）」，**如实记录的是缺陷行为**；D2 一修，它必红。
- 精确修法（供有权限者落地，性质是**增强**而非弱化断言）：把 437-438 行改为
  `assert.equal(countFacts(cwd), before + 1, 'cap=0 已修：0 次收束的回合兜底仍必须落观察 Fact')`，
  并把用例名 / 注释里的「【退化】…破了」改为「cap=0 不再打穿不变量 1」；第 439-442 行的工具路径断言
  （`fgs_commit_step` 在 cap=0 仍被拒、step 保持 open —— 本插件只改了兜底路径）依旧成立，不需改。
