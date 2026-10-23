# 冠军断档路线图（v5.2 之后往哪走）

> 写于 2026-10-22，v5.2 落地之后（1.3.0 / gen 16 / 321 tests）。
> 用途：明天接着聊的底稿 + 上下文被压缩后的恢复入口。
> 结论性判断都标了依据文件；**排序是待验证的假设**，不是结论——先有度量再谈优化。

---

## 0. 一句话

机制层（Cairn v1 六条 + Cairn_Y 完整档）已经不需要再加。断档来自四个乘数的乘积：

```
得分 ≈ 解出率 × 单位时间产出 × 稳定性(不丢分) × 知识复用
```

现在的短板不在第 7 条机制，而在**镜像、度量、工具纪律、时间分配**。

## 1. 现状盘点（已核实）

| 项 | 现状 | 依据 |
|---|---|---|
| 机制 | v5.1 六条 Cairn 机制 + v5.2 并发 Decide/rebase 全部落地，默认关闭并发 | `docs/V5_2_PLAN_DECIDE_CONCURRENCY.md` §12（checklist 全勾） |
| 测试 | 321/321 离线全绿（协议/假 worker/真子进程/真超时） | `node --test "tests/*.test.mjs"` |
| 真模型 E2E | **没跑过**。`--session-id` 收束轮、rebase 回灌下的规划行为都只是纸面验证 | `docs/V5_2_LANDING.md` §7 |
| 镜像 | **P0 骨架**：`node:22-bookworm-slim` + `python3`，无 curl/nc/jq，无任何渗透工具，dsh 未 vendor | `contest/Dockerfile` 注释与 `RUN apt-get` 行 |
| 预算默认 | 每题 1800s、单活动 600s、Decide 300s、收束 120s、`--parallel 2`、`max_active 3`、`decide_every 3` | `contest/activity_loop.py` 的 DEFAULT_*、`README.md` 环境变量表 |
| Prompt | Decide 22 行 + 整图 YAML；Execute 一段纪律 | `prompts/decide.system.md`、`prompts/execute.system.md` |
| Context 上限 | 图投影 `injectMaxChars=24000`；Decide 注入整图 | `index.js` `DEFAULT_CONFIG.injectMaxChars` |
| 知识复用 | 图按题隔离；无跨题战术库/字典/playbook | 仓库中无 `knowledge/` 一类目录 |
| 观测 | 两本 JSONL 台账已有（含 v5.2 的 rev/applied/rejected、startedWhileExecutes） | `docs/V5_ACTIVITY_RUNS.md` §10 |
| 评测 | 无 benchmark harness；`CONTEST_FIXTURE` 只解决「不去平台 list」 | `contest/driver.py` |

## 2. 优先级总表

权重：**P0 不做就是裸奔；P1 直接抬解出率；P2 抬速度/吞吐；P3 工程化**。

| # | 方向 | 现状 | 具体动作 | 验收指标 | 预估 |
|---|---|---|---|---|---|
| P0-1 | **真镜像** | 见上表 | 工具链 + 字典 + dsh + headless profile 打进镜像；≤3GB；离线可用 | 容器内 `curl/nmap/ffuf/sqlmap/nuclei/jq` 可跑；`dsh --version` 可用；冷启动 < 60s | 1–2 天 |
| P0-2 | **度量闭环** | 无 | 10 道练习题的 eval harness：跑 driver/loop，收两本台账 + dsh usage，输出 §3 的指标 | 一条命令产出 `eval.json`（SR/TTF/tokens/活动数） | 1–2 天 |
| P0-3 | **时间预算策略** | 默认值是拍的 | 阶段预算（侦察/利用/收尾）、无进展早停、按 flag 分批交付 | TTF 下降；死题上浪费的墙钟下降 | 2–3 天 |
| P1-4 | **Decide 质量** | 22 行 prompt | 结构化研判四段、负结果记忆、去重、step 粒度 | Decide 有效率（`revBefore≠revAfter` 占比）、重复执行率 | 3–5 天 |
| P1-5 | **执行工具纪律** | 只有"落一条 fact" | 工具 cookbook：超时/后台/并发/先探测后暴力/失败换招/大输出落文件 | 单题无效命令数、执行成功率 | 2–3 天 |
| P1-6 | **Finding 结构化** | `findingType` 自由定义 | 分类学 + 因果链（from→to），让 Decide 做攻击面推理 | 图的可读性/Decide 引用率 | 2 天 |
| P1-7 | **跨题 playbook** | 无 | `knowledge/`：题型 playbook、payload、字典、脚本，按题型注入 | 同类题 TTF 下降 | 持续 |
| P2-8 | **单题 portfolio** | 单策略 | 同题 2–3 个假设并行，先 flag 胜（用现有 slots） | SR 提升 vs token 成本 | 3 天 |
| P2-9 | **活动开销** | 一活动一进程 | execute 会话续跑 2–3 step 的实验；prompt cache；图投影只注入因果邻域 | tok/flag、activities/flag | 3 天 |
| P2-10 | **Context 工程** | 整图 YAML 注入 | 因果邻域 + 项目摘要 + 最近 delta（`graphDelta` 已是半个实现） | Decide 上下文 token、决策质量 | 2–3 天 |
| P2-11 | **交付/多 flag** | 有 `submit_flag` + flag 硬门 | 边解边交、提交失败重试与确认、多 flag 分批 | 提交失败率、部分分获取率 | 1 天 |
| P2-12 | **鲁棒性 soak** | 单测级别 | 8h 空转/限流/崩溃恢复；网关 429、SIGKILL 后收束、写锁超时 | 无人工干预跑满 8h | 2 天 |
| P3-13 | **Metrics 面板/复盘** | JSONL | 聚合 + 每题时间线（tree view 可扩展） | 5 分钟看懂一题怎么输的 | 2 天 |
| P3-14 | **真题回放** | 无 | record 模型输出做 deterministic replay | A/B 不烧 token | 2 天 |

## 3. 度量：先定义，再优化

### 3.1 指标

| 指标 | 定义 | 数据来源 |
|---|---|---|
| SR | 解出题数 / 总题数 | driver/平台 |
| TTF | 首个 flag 时间 − 题目开始 | 台账 `at` |
| tokens/flag | 模型 token 总消耗 / flag 数 | dsh `--json` 输出里的 usage（**待确认字段**），否则网关日志 |
| activities/flag | 活动数 / flag 数 | `orchestrator.jsonl` |
| Decide 有效率 | `revBefore≠revAfter` 的 Decide / 总 Decide | `activity.jsonl`（v5.2 已记） |
| 重复执行率 | 同一 step 被执行 >1 次的比例 | `orchestrator.jsonl` |
| 失败率 | `timedOut`/非零退出/`blocked` / 总活动 | 两本台账 |
| 稳定性 | 同配置跑 N 次 SR 的方差 | eval 多次 |

### 3.2 harness 最小实现（建议）

```
contest/eval/
  run_eval.py      # 输入：题目清单（fixture 形式：id/desc/addr）、模型 key、预算、旋钮矩阵
                   # 动作：逐题起 driver（或直接 activity_loop），超时收割
                   # 输出：eval.json（每题的指标 + 汇总）
  report.py        # eval.json → markdown 表（按题、按配置对比）
  cases/          # 10 道练习题的最小清单（地址可 mock 或真容器）
```

约束：本机没有平台 token 时用 `CONTEST_FIXTURE` + 本地可访问的目标；没有真目标时至少验证
「跑通—计时—收账」链路。

### 3.3 A/B 协议

- 固定 10 题 × 2 次；成对比较（同一题同一天）。
- 先看 SR，再看 TTF，最后看 token；SR 不降才允许换 TTF/成本。
- 一次只动一个旋钮/一个 prompt 段，改动进 git（本仓库没有 git → 用 zip 快照命名
  `fgs-vX.Y.Z.zip` + `docs/CHANGELOG_*.md`）。

## 4. 断档级杠杆（详解）

### 4.1 镜像就是能力边界（P0-1）

`bookworm-slim` 里连 `curl` 都没有，Execute 只能拿 node/python 手搓——这不是"弱一点"，
是很多题直接做不了。上传上限 3GB、托管沙箱**无公网**，所以所有东西必须预装。

建议清单（按体积/收益排序，装完实测镜像 < 3GB）：

- 基础：`curl wget jq git netcat-openbsd dnsutils whois openssl ca-certificates vim-tiny`
- 侦察：`nmap`（含 NSE 脚本）、`whatweb`、`nikto`、`ffuf`/`gobuster`、`nuclei`（静态二进制）
- 利用：`sqlmap`、`hydra`、`john` 或 `hashcat`（二选一并控制体积）
- 脚本：`python3-requests pyjwt beautifulsoup4 lxml pwntools`、`node` 全局 `axios` 可选
- 字典：SecLists 精选子集（目录/子域/口令/用户名），控制 < 300MB
- harness：`dsh` + headless profile + 本插件（vendor 进镜像，`CONTEST_DSH_LAUNCH=1`）

验收：容器内 `nmap -h`、`ffuf -h`、`sqlmap --version`、`nuclei -version`、`curl -V` 都通；
`dsh --version` 通；`CONTEST_DSH_LAUNCH=1 CONTEST_ACTIVITY_RUNS=1` 能起一次性活动进程。

### 4.2 Decide 质量决定上限（P1-4）

Cairn_Y 的判断是"规划质量 > 执行速度"。当前 Decide 只有 22 行 prompt + 整图 YAML。
改造方向（每条都能 A/B）：

1. **结构化研判**：每轮强制输出四段——已知（引用 fact id）/ 未知（攻击面缺口）/ 假设（可证伪）/
   下一个最小可验证动作。写进 `prompts/decide.system.md`，必要时用 `structured_output`。
2. **负结果记忆**：显式"试过且失败"的 Fact 要阻碍重复投入（现在只靠模型自己读图）。
   可在 Decide 上下文里单列 `failed_attempts`（从 findingType/kind 或 step.dropped 推导）。
3. **去重**：同一攻击面对两个 open step 时先合并/降优先级，避免两个 Execute 撞车。
4. **step 粒度**：一个 step = 一个可并行、可独立验证的微动作；禁止"渗透目标"这种大 step。
5. **子目标分期**：多 flag/多阶段用 `add_subgoal`，让每期有独立完成判据。

验收：Decide 有效率、重复执行率、TTF。

### 4.3 执行层的工具纪律（P1-5）

Execute prompt 目前只有"做这个 step + 落一条 fact"。补一份 cookbook（写进
`prompts/execute.system.md` 或按场景拆多份）：

- 任何命令都要有超时/后台策略；长扫描放后台，不许阻塞回合。
- 先探测（一个轻量请求确认服务活着）再暴力/利用。
- 大输出落文件，fact 里只引用文件名 + 结论。
- 常见工具参数模板（nmap/ffuf/sqlmap/JWT/反序列化/命令注入）。
- 失败换招清单：同一方法连续 2 次失败就换假设，不许原地重试。
- 产物目录约定（避免并行 Execute 互相踩文件）。

验收：单题无效命令数、执行成功率、tokens/flag。

### 4.4 跨题知识复用（P1-7，唯一"越跑越强"的杠杆）

比赛题目重复率极高。建 `knowledge/`：

```
knowledge/
  playbooks/web.md / pwn.md / crypto.md / misc.md   # 题型套路
  payloads/…                                        # 常用 payload/绕过
  checklists/recon.md                               # 侦察清单
  wordlists/…                                       # 与镜像共用
```

注入方式：Decide 按题目信息/已有 Fact 的 findingType 选 1–2 篇 playbook 注入（别全塞）。
产出方式：赛后复盘把新套路写回 `knowledge/`，下一场直接受益。

## 5. 反模式（别做）

1. **别再补 Cairn 机制**：机制比原版还全；瓶颈在模型、工具、时间。
2. **没有度量就调参**：加并发、加 Decide 频率、堆 prompt——大概率是噪声。
3. **重构 kernel**：图/写锁/活动协议是资产，不是债。
4. **无限并行**：token 成本与网关限流会先吃掉收益。
5. **把"机制完整"当卖点**：评分只看 flag 和时间。

## 6. 如果只做三件事

1. **真镜像**（工具链 + 字典 + dsh），跑通 `CONTEST_DSH_LAUNCH=1`；
2. **10 道真题的度量 harness**，拿到基线数字；
3. **Decide/Execute 两份 prompt + playbook 重写**，用 harness 做 A/B。

先别写机制代码——先跑基线。

## 7. 明天要确认的问题（开放项）

1. 平台评分规则：部分 flag 是否给分？单题时限、总时限、并发上限？模型是否固定？
2. 上传镜像 3GB 上限下，工具链取舍（john vs hashcat、字典体积）。
3. 模型是否可选（flash vs pro）、reasoning effort 是否可调、网关是否支持 prompt cache。
4. 一题多 agent 是否允许（portfolio 的前提）。
5. 真模型 E2E 的 key/网关可用时间（决定 P0-2 何时能真跑）。

## 8. 相关文件

- 机制现状：[`V5_ACTIVITY_RUNS.md`](V5_ACTIVITY_RUNS.md)、[`V5_2_LANDING.md`](V5_2_LANDING.md)、[`V5_2_PLAN_DECIDE_CONCURRENCY.md`](V5_2_PLAN_DECIDE_CONCURRENCY.md)
- 竞赛面：[`../README.md`](../README.md)（环境变量表）、[`../contest/Dockerfile`](../contest/Dockerfile)、[`../contest/SUPERVISOR.md`](../contest/SUPERVISOR.md)
- 交接入口：[`../NEXT_STEPS.md`](../NEXT_STEPS.md)
- 与 Cairn 的对照：`/home/ubuntu/cc/cairn-highlights-and-dsh-placement.md` §12
