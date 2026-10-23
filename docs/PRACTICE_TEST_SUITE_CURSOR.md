# 代次 12 实操验收清单（Practice Test Suite）

给操作员在 **DeepSeek Harness** 里手跑的验收清单。对象是链接到本仓库的 `@local/fgs-deepseek-dsh`，**代次 12**（TTL + schema-ux + role-prompt 注入之后）。

这不是 `node --test`，也不新增产品行为。每一例都是：准备、步骤、黑板上应看到什么、通过 / 失败。用例保持最短，不写打法。

写这份清单时没有启动 Harness，也没有调用 `https://api.scienceedu.me`。通过与否以操作员在代次 12 上的当场记录为准。

## 0. 共享准备（Shared setup）

### 0.1 运行面

| 项 | 值 |
|---|---|
| 插件 | `@local/fgs-deepseek-dsh`，`dsh plugin --profile web add <本仓库绝对路径>` |
| 模型 | `deepseek-v4.1-flash` |
| 协议 | `openai-responses` |
| Base URL | `https://api.scienceedu.me/v1` |
| 密钥 | 放在本机环境变量或 Harness 配置里，不要写进仓库、图或本清单 |

在 Harness 的模型配置里核对上面三项。端口以本机 `dsh` 启动日志为准；下文用 README 里的 `127.0.0.1:3080` 作例子。

### 0.2 链接并确认进程加载的是代次 12

改插件文件后，Harness 可能把已链接的插件卸掉且不自动挂回。每次开跑前重做一次安装，并用 token 看快照（不带 token 的 `/fgs/state` 会被掩成 404，和「没加载」分不清）。

```bash
export FGS_REPO="<本仓库绝对路径>"
dsh plugin --profile web add "$FGS_REPO"
# TOKEN 从 dsh 启动 URL 里取
curl -s "http://127.0.0.1:3080/fgs/state?token=${TOKEN}"
```

先做完 **§10**。`pluginGeneration` 不是 `12`，或 `buildTag` 里没有 `schema-ux` 与 `role-prompt` 时，下面 1–9 全部不算数（跑的不是这一代）。

### 0.3 每例一个干净工作目录

一场比赛落在会话 cwd 的 `.fgs/`。每例单独建目录并在那个目录里开会话，避免图串题。

```bash
export CASE="$HOME/fgs-practice/pt-XX"    # 每例换一个名字
mkdir -p "$CASE"
# 在 DeepSeek Harness 里把该会话的 cwd 指到 $CASE
```

### 0.4 把夹具铺成活动题的图

图的主文件是 `.fgs/projects/<problemId>/graph.yaml`。`problemId` 会被规范成 `[a-z0-9_-]{1,64}`。`load` 只读 yaml；若旁边已有 `graph.json`，先删掉，免得人和镜像对不上。

```bash
# 会话里先建空题（不要带 brief，避免种出第二张 origin）
#   /fgs new <problemId>
cp "$FGS_REPO/fixtures/practice/<fixture>.yaml" \
  "$CASE/.fgs/projects/<problemId>/graph.yaml"
rm -f "$CASE/.fgs/projects/<problemId>/graph.json"
```

然后在同一会话里 `/fgs switch <problemId>`（若它已经是活动题可省略）。`/fgs status` 应能读到这张图，而不是「尚未种题」。

磁盘上的 id 必须是 `fact_NNN` / `step_NNN`。清单里的 **fact_with_flag** / **fact_without_flag** 只是角色名，对应夹具里的 `fact_001` / `fact_002`。

### 0.5 怎么读结果

| 看哪里 | 看什么 |
|---|---|
| 工具返回 | 该次调用的原文，含拒收原因 |
| `$CASE/.fgs/projects/<id>/graph.yaml` | facts / goals / steps 落盘结果 |
| 同目录 `meta.json` | deferred 等项目元数据 |
| 本轮注入上下文 | Harness 里该轮的 system / context（`fgs-rules`、`fgs-graph`，以及代次 12 注入的角色提示）。界面不展示时，导出该轮消息再搜 |
| `/fgs/state?token=` | `pluginGeneration`、`buildTag` |

角色由图决定：本会话没有自己持有的 open step → **Decide**；持有一条 open step → **Execute**。`fgs_satisfy_goal` 只在 Decide。默认 `fgs_commit` 会把本轮新开的 step 认领给自己，下一步就是 Execute。

配置保持默认，除非某一例写明要临时改：

- `verifyMode: regex`（默认 `flagPattern` 能匹配 `flag{practice-any-ok}` 这种形态）
- **不要**设置 `satisfyFlagMode`，或显式设为 `any`。设成 `all` 时 §2 无效
- §6 可以临时把 `executeSessionTtlMs` 改短，测完改回，不要把短值提交进仓库

### 0.6 记录

每例记四行：`problemId`、工具原文或上下文摘句、`graph.yaml` / `meta.json` 里相关片段、通过或失败。模型若擅自改了指定参数（例如把 `step_recon` 改成 `step_001`），该例作废重跑，不算通过，也不算产品失败。

---

## 1. Cold-start Bootstrap

**目的：** 图上只有 origin 时，第一轮 Decide 只开一条指向 `goal_final` 的 step，而不是一次扇出多条侦察。

**准备**

- 工作目录 `pt-boot`，`/fgs new pt-boot`
- 铺上 `fixtures/practice/origin-only.yaml`
- `/fgs status`：`facts=1`，`steps=0`，`open=0`，角色 Decide
- 确认 `prompts/decide.system.md` 的冷启动句已是「优先一条指向 goal_final」，并且会在 §9 里被注入。本例不在用户消息里替模型写出这一步

**步骤**

在该会话发一条，不要附加分步方法：

> 图已经在黑板上。请判断下一步并提交。不要调用环境工具。

**期望（黑板 / 工具）**

- 出现 `fgs_open_step`（或 `fgs_commit` 的 `operations[]` 里一条 `open_step`），然后 `fgs_commit` 成功
- `graph.yaml` 在 `fact_origin` 之外新增 **恰好 1** 条 step，id 为 `step_001`
- 该 step：`state: open`，`from` 含 `fact_origin`，`action` 是一句话，读得出来是在尝试满足 `goal_final`（夹具的完成标准是正文出现 `flag{practice-boot}`）
- `goal_final` 仍没有 `satisfiedBy`
- 没有环境工具调用

**通过：** 第一次成功的 commit 之后，`steps` 长度是 1，且这一步指向 `goal_final`。

**失败：** 同一次提交写出 ≥2 条 step；或唯一一步的 action 看不出是在尝试 `goal_final`；或 commit 没落盘。模型开出合法的一条之后又在同轮追加侦察 step，也算失败。

---

## 2. satisfy_goal OR

**目的：** 默认 `satisfyFlagMode=any` 时，`satisfiedBy` 里只要有一条事实含标记即可通过。另一条没有标记不会把整批拒掉。

**准备**

- 工作目录 `pt-or`，`/fgs new pt-or`
- 铺上 `fixtures/practice/satisfy-or.yaml`
- 配置里 `satisfyFlagMode` 缺省或为 `any`，`verifyMode` 为 `regex`
- `/fgs status`：无 open step，角色 Decide
- 角色名对照：`fact_001` = fact_with_flag（正文有 `flag{practice-any-ok}`），`fact_002` = fact_without_flag（正文无标记）

**步骤**

> 不要开 step，不要调用环境工具。按下面参数各调用一次，不要改参数：
>
> 1. `fgs_satisfy_goal`，`goalId`=`goal_final`，`reason`=`fact_001 含标记`，`satisfiedBy`=`["fact_001","fact_002"]`
> 2. `fgs_commit`

**期望（黑板 / 工具）**

- 两次调用都成功，返回里没有「未匹配 flag」
- `graph.yaml` 里 `goal_final.satisfiedBy` 同时有 `fact_001` 和 `fact_002`
- `satisfiedReason`、`satisfiedAt` 已写入
- `fact_001`、`fact_002` 都还在（没有为了过门而删掉无标记的那条）

**对照（同一例，确认硬门还在）**

另开目录 `pt-or-none`，铺 `fixtures/practice/satisfy-or-none.yaml`。用同样的 `satisfiedBy`=`["fact_001","fact_002"]` 做 satisfy + commit。

- commit **失败**，原因点名缺标记（两张事实都没有）
- `goal_final` 仍然没有 `satisfiedBy` / `satisfiedAt`

**通过：** 有标记的那组落盘且保留无标记事实；全无标记的那组被拒且不写 `satisfied*`。

**失败：** 有标记组被「`fact_002` 未匹配」拒掉（这是旧的逐条 AND）；或全无标记组也通过（门被拆掉）；或只有删掉 `fact_002` 之后才通过。

---

## 3. fgs_preview 拒未知参数

**目的：** `fgs_preview` 与 `fgs_status` 一样，不接受参数。未知键要失败，而不是被丢掉仍返回投影。

**准备**

- 可复用 `pt-boot` 的 Decide 会话（无本会话持有的 open step）。没有的话按 §1 的夹具另开 `pt-preview`
- 先确认 status 的旧行为还在，再测 preview

**步骤**

不要改参数，各调用一次：

1. `fgs_status`，参数 `{ "noop": true }`
2. `fgs_preview`，参数 `{ "action": "ignored", "noop": true }`
3. `fgs_preview`，参数 `{}`

**期望（工具）**

- 1 失败，原文含 `fgs_status 不接受任何参数`，并点名 `noop`
- 2 失败，原文含 `fgs_preview 不接受任何参数`，并点名收到的键（至少含 `action` 或 `noop`）
- 3 成功，返回当前图的只读投影（能看到 `fact_origin`）
- 三次调用都不改 `graph.yaml`

**通过：** preview 带未知键失败且说明不接受参数；无参 preview 成功。status 的拒参行为同时成立。

**失败：** 带 `action` / `noop` 的 preview 仍返回投影（把垃圾参数吞掉）。

---

## 4. 非法 stepId `step_recon`

**目的：** 预分配 id 不是 `step_NNN` 时整批拒收，错误里给出合法例子 `step_001`。不落盘、不改写成别的 id。

**准备**

- 新目录 `pt-step`，铺 `fixtures/practice/origin-only.yaml`，角色 Decide
- 记下铺完后的 `graph.yaml`（`steps: []`）

**步骤**

> 不要改我给的 id，不要改调用环境工具。按此提交一次：
>
> `fgs_commit` 的 `operations` 为一项：`op`=`open_step`，`stepId`=`step_recon`，`action`=`尝试满足 goal_final`，`from`=`["fact_origin"]`

若界面只能分步调用，则 `fgs_open_step` 使用同一个 `stepId`，再 `fgs_commit`。id 必须仍是 `step_recon`。

**期望（工具 / 黑板）**

- 调用失败。原文同时表明 id 非法，并出现提示 **`step_001`**
- `graph.yaml` 仍是 `steps: []`。没有 `step_recon`，也没有被自动改成的 `step_001`
- `goal_final` 无 `satisfiedBy`

**通过：** 拒收，且操作员不用猜格式就能从错误里看到 `step_001`；图无新 step。

**失败：** 调用成功并写下任意 step；或只说「须 step_NNN」但没有 `step_001` 这个例子；或错误之后图被写了一部分。

---

## 5. Decide 拒绝 bash

**目的：** Decide 轮调用 `bash` 被拒，原文里带下一步：先 `fgs_open_step`，再 `fgs_commit`。

**准备**

- 新目录 `pt-bash`，铺 `fixtures/practice/origin-only.yaml`
- `/fgs status` 确认角色是 Decide，且没有 `owner` 为本会话的 open step
- 若上一轮已经 commit 出 open step，本例作废，换干净图。Execute 轮允许环境工具，测不到这条拒收

**步骤**

> 现在不要开 step。只调用一次 `bash`，命令是 `printf ok`。不要改用别的工具。

**期望（工具 / 黑板）**

- `bash` 失败（角色隔离 / 禁止环境执行工具）
- 失败原文同时含 **`fgs_open_step`** 和 **`fgs_commit`**
- `graph.yaml` 仍只有 `fact_origin`，`steps` 仍为空
- `printf` 没有真正执行（没有命令输出被当成成功）

**通过：** 拒收文案里两个工具名都在，图没有变化。

**失败：** `bash` 被执行；或拒了但原文没有 `fgs_open_step` 或没有 `fgs_commit`。

---

## 6. TimeoutSettle

**目的：** Execute 持有一步并超过 `executeSessionTtlMs` 仍未收束时，协议自己写下未完成 Fact、释放认领、标上 deferred。再 settle 一次不会把同一结论再写一条。

本例只看插件在活进程里的 settle。不要发 SIGTERM，不要靠外部监督进程杀会话。

**准备**

- 新目录 `pt-ttl`，铺 `fixtures/practice/origin-only.yaml`
- 仅本例把运行配置里的 `executeSessionTtlMs` 设为 `20000`（20 秒），重载插件后用 §10 确认仍是代次 12。默认不改时这条等待是 10 分钟量级，也可以，但记录实际等待值
- 测完把该配置改回原值，不要提交进仓库

**步骤**

1. 发一条，只要开步，不要收束：

   > 请只开一条指向 goal_final 的 step 并 fgs_commit。不要调用环境工具，不要 fgs_submit_fact，不要 fgs_commit_step。

2. 确认 `graph.yaml`：恰好一条 open step，`owner` 是本会话（角色已是 Execute）。记下 step id 与当时的 facts 列表（应只有 `fact_origin`）。
3. 再发一条让模型停下：

   > 停。在我下一条消息之前不要调用任何工具。

4. 进程保持运行，等待不少于 `executeSessionTtlMs` 再加几秒。不要杀进程。
5. 发一条，只为让下一轮走到刷新 / settle，不要嘱咐它编一条新发现：

   > 时间到了。不要调用环境工具，不要新开 step，不要 fgs_commit_step。

6. 立刻读 `graph.yaml` 和 `meta.json`。记下未完成 Fact 的 id。
7. 再等一个 TTL（或把第 5 步再发一次），然后重读这两个文件。

**期望（黑板）**

第一次 settle 之后：

- 相对第 2 步，新增 **一条** Fact。正文或标题能看出未完成，并同时带有「卡在」「已试」「为何停」三类信息
- 这不是信号兜底那句「未经模型收束」的空记录
- 该 step 仍是 `state: open`，`owner` 为空（字段消失或空）
- `meta.json` 有 deferred 标记（键名含 `deferred`，且不是空）。若同时有 `linkedUnfinishedFactId`（在 step 上或 meta 里），它指向这条 Fact
- `goal_final` 没有 `satisfiedBy`

第二次 settle 之后：

- 这条未完成 Fact 的 id 还在，没有第二条内容相同或同一 step 的未完成 Fact
- facts 条数不因再 settle 而增加
- step 不会因此被收成 `done`，`goal_final` 仍未满足

**通过：** 富未完成 Fact + 释放认领 + deferred，且再 settle 不双写。

**失败：** TTL 过后图仍只有 `fact_origin`；或唯一新 Fact 是「未经模型收束」；或 step 仍挂着本会话 `owner`；或 meta 没有 deferred；或第二次 settle 又追加一条未完成 Fact。模型在 TTL 之前自己 `fgs_commit_step` 了，本例作废重跑。

---

## 7. SubGoal（多标记）

**目的：** 图上的 `goal_final` 明确要求两个标记都成立时，Decide 至少调用一次 `fgs_add_subgoal`，或者本轮 Decide 上下文已经提到这个工具。两条满足其一即可。

**准备**

- 新目录 `pt-sub`，铺 `fixtures/practice/multi-flag.yaml`
- 角色 Decide，`steps` 为空
- 先按 §9 的看法确认本轮 Decide 上下文（有无 `fgs_add_subgoal` 字样），再让模型规划

**步骤**

> goal_final 要两个标记都成立。请只做 Decide 并提交你这一轮的图操作。不要调用环境工具，不要去获取标记。

**期望（黑板 / 工具 / 上下文）**

满足下面 **任一** 即本例的行为部分通过：

- 工具轨迹里有至少一次 `fgs_add_subgoal`，且 commit 之后 `graph.yaml` 出现 `kind: sub` 的 goal（id 形如 `goal_sub_001`），`goal_final` 仍在、未被替换
- 或者：本轮 Decide 注入上下文在多标记 Goal 已经在图上时，原文出现 `fgs_add_subgoal`

无论哪一条：

- 没有环境工具调用
- `goal_final` 没有 `satisfiedBy`（本例不要求真的拿到两个标记）

**通过：** 上列两条途径至少一条成立。

**失败：** 上下文没提到 `fgs_add_subgoal`，工具也没调用它；或调用了但 commit 后图上没有 sub goal；或 `goal_final` 被删掉 / 被改成别的 kind。

---

## 8. Execute 的 findingType

**目的：** Execute 上下文能看见 findingType 那一句。过程发现可以带 `findingType` 落成 Fact，这不会使 `goal_final` 达成。

**准备**

- 新目录 `pt-find`，铺 `fixtures/practice/origin-only.yaml`
- 先开一条 step 并 commit，使本会话进入 Execute（`/fgs status` 里该 step 为 mine）。不要在这条用户消息里要求 satisfy

**步骤**

1. 进入 Execute 后、调用工具前，按 §0.5 查看本轮上下文，确认能看到 findingType 说明（与 §9 的 Execute 句是同一句）。
2. 再发：

   > 不要获取最终标记，不要调用 fgs_satisfy_goal。请 fgs_submit_fact：title 为「过程记录」，content 为「过程中看到一个标记位，尚未形成最终结果」，findingType 为 info。然后 fgs_commit_step。不要在 content 里写 flag{。

**期望（黑板 / 上下文）**

- Execute 上下文含 findingType 句：过程发现用 `findingType`，并且不要把 Finding 当成 `goal_final`（见 §9 的原文要求）
- commit 成功。新 Fact（`fact_001`）有 `findingType: info`，`producedBy` 指向刚才那条 step
- 该 step 变为 `done`，`to` 指向这条 Fact
- `goal_final` **没有** `satisfiedBy` / `satisfiedAt`
- 图的顶层仍然只有 `facts` / `goals` / `steps`，没有单独的 findings 节点

**通过：** 上下文里有 findingType 句；带 `findingType` 的过程 Fact 已落盘；`goal_final` 仍未满足。

**失败：** Execute 上下文看不到 findingType 句；或 `findingType` 被丢掉 / 改成别的类型；或这条 Fact 导致 `goal_final` 被写成已满足。

---

## 9. 角色提示注入（Role prompt）

**目的：** 代次 12 把角色提示送进对应上下文，而不是只放在仓库里。

**准备**

- Decide 用 `pt-boot`（只有 `fact_origin`）
- Execute 用 `pt-find` 进入 Execute 之后的那一轮（或按 §8 再开一条未收束的 step）
- 打开**正在运行的那份**插件文件，不是别的副本：
  - `prompts/decide.system.md`
  - `prompts/execute.system.md`

**步骤**

1. 从 `decide.system.md` 抄出冷启动那一句（关于只有 `fact_origin` / 无 open step 时怎么开第一步）。
2. 打开 Decide 轮的注入上下文，做子串对照（空白差异可忽略）。
3. 从 `execute.system.md` 抄出 findingType 那一句。
4. 打开 Execute 轮的注入上下文，做同样的对照。

**期望**

Decide 文件中的冷启动句，以及上下文里的同一句，都要表达：

- 图上只有 `fact_origin`、还没有中间 Fact 时，**优先开一条**尝试直接满足 `goal_final` 的 step
- 冷启动的默认动作不是「开多条侦察」

Execute 文件中的 findingType 句，以及上下文里的同一句，都要表达：

- 过程发现用 `findingType`
- 不要把 Finding 当成 `goal_final`

**通过：** 两个文件里的对应句都能在对应角色的注入上下文里找到；两句的语义就是上面四条。

**失败：** 上下文里没有文件中的那一句（提示没注入）；或注入的仍是「开多条相邻但互补的侦察方向快速起量」作为冷启动默认；或 Execute 上下文没有 findingType 句。文件改了但进程仍是旧代次时，先回到 §10，不要把本例记成提示缺陷。

---

## 10. pluginGeneration / buildTag

**目的：** `/fgs/state` 证明进程里的代码是代次 12，并且带 schema-ux 与 role-prompt 标记。

**准备**

- 插件已按 §0.2 重新 `dsh plugin add`，Harness 已加载
- 手上有启动 URL 里的 token

**步骤**

```bash
curl -s "http://127.0.0.1:3080/fgs/state?token=${TOKEN}"
```

没有活动会话时，返回可以是 `active: false`，但代次字段仍然要在。

**期望**

- JSON 里 `pluginGeneration` 为数字 **12**
- `buildTag` 为字符串，同时含子串 **`schema-ux`** 和 **`role-prompt`**
- 不带 token 时不要用 404 判断代次

**通过：** 两个字段都符合。本清单其余各例只在这次结果为通过时有效。

**失败：** 代次仍是 10 或 11；或 tag 缺 `schema-ux` / `role-prompt`；或必须重启才变、但重启后仍是旧值（进程没加载到这一份仓库）。

---

## 本清单故意不测（Out of scope）

Cursor 写的是插件黑板上的实操清单。下面这些属于竞赛运行器或赛场环境，不在本清单里，也不要为了打勾去改插件提示词：

- **Runner / supervise：** 监督进程的超时、SIGTERM、杀进程之前是否等 TimeoutSettle 跑完、空的「未经模型收束」Fact、强制 deferred 第二波、`MAX` 并发、题目分池、21 道未开题
- **VPN：** watchdog 是否常驻、隧道恢复、向图里追加「VPN restored」。本清单不连 VPN，也不测恢复后的黑板
- **赛场侧：** 平台提交接口、`verifyMode: command`、容器清理、`defect_scan`、多 worker 抢同一条 step、Decide 跨进程串行锁
- **模型能力：** 除上面各例的单轮行为外，不评分、不要求真的产出 `flag{practice-boot}`

§6 只证明插件自己的 TTL settle。运行器若提前杀进程，那是运行器的缺口，不要记进本清单的通过栏。

---

## 结果表（Score sheet）

| # | English label | 通过条件（短） | 结果 |
|---|---|---|---|
| 1 | Cold-start Bootstrap | 第一次 commit 只有一条指向 goal_final 的 step | |
| 2 | satisfy_goal OR | `[fact_001, fact_002]` 在 any 下通过；全无标记仍拒 | |
| 3 | preview rejects args | 未知参数失败并说明不接受参数；无参成功 | |
| 4 | illegal stepId | `step_recon` 拒收，错误含 `step_001`，图不变 | |
| 5 | bash denial | Decide 拒 bash，原文含 `fgs_open_step` 与 `fgs_commit` | |
| 6 | TimeoutSettle | 未完成 Fact + 释放 + deferred；再 settle 不双写 | |
| 7 | SubGoal | 多标记图上调用了 `fgs_add_subgoal`，或 Decide 上下文提到它 | |
| 8 | findingType | Execute 可见该句；过程 Fact 带类型且 goal_final 未满足 | |
| 9 | Role prompt | Decide 冷启动句与 Execute findingType 句来自对应 md 且已注入 | |
| 10 | generation 12 | `/fgs/state` 为 12，tag 含 `schema-ux` 与 `role-prompt` | |

十例都通过，才算代次 12 的这张实操清单通过。
