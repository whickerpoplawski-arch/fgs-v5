# 会话交接（v5.2 落地后 · 明天新会话从这里恢复）

> 写于 2026-10-22 23:55。当前包 `@local/fgs-v5-dsh` **1.3.0** / generation **16** / 321 tests 全绿。
> 本文件是**环境 + 历史 + 接线方式 + 明天从哪开始**的自足上下文；机制细节在
> [`V5_ACTIVITY_RUNS.md`](V5_ACTIVITY_RUNS.md)、[`V5_2_LANDING.md`](V5_2_LANDING.md)，
> 优化方向在 [`CHAMPION_ROADMAP.md`](CHAMPION_ROADMAP.md)。

---

## 0. 30 秒看懂

- 这是一个 **DeepSeek-Harness 插件**（`@local/fgs-v5-dsh`）：FGS 黑板（Fact→Step→Fact），
  kernel 看图/写锁/校验，插件提供图工具 + 提示词 + guard + HTTP 面板。
- 外面套了一套 **竞赛编排器**（`contest/`）：把一道题拆成一串一次性活动 run
  （Decide 规划 / Execute 执行 / Bootstrap 冷启动），每题一个 `dsh --profile headless` 子进程，
  唯一共享记忆是磁盘上的图。
- 今天交付了 **v5.2：Decide 与 Execute 并发 + rebase 提交**（默认关闭，开关打开）。
- 明天要做的是 **`docs/CHAMPION_ROADMAP.md` 的 P0**：真镜像 → 度量 harness → 时间预算；
  先跑基线再谈优化。

## 1. 机器与环境（已核实）

| 项 | 值 |
|---|---|
| 工作目录（会话 cwd） | `/home/ubuntu/cc` |
| 仓库 | `/home/ubuntu/ws/fgs-v4-5624fa3-1.0.0`（1.6MB；**无 git**，目录名是历史遗留） |
| 包 | `@local/fgs-v5-dsh` 1.3.0，`PLUGIN_GENERATION=16` |
| Node / Python / dsh | v22.22.1 / 3.14.4 / 0.2.1-rc.2 |
| DSH 安装 | `/home/ubuntu/.local/node/lib/node_modules/@deepseek-ai/dsh/` |
| Web GUI | `http://127.0.0.1:3080`（**正在运行，承载当前会话；绝对不要 kill**） |
| Web profile | `~/.dsh/profiles/web`（插件以 `link:` 依赖指向仓库，改代码重启即生效） |
| Headless profile | `~/.dsh/profiles/headless`（竞赛 worker 用；同样 link 到仓库） |
| 快照/回滚 | `fgs-v5-1.3.0.zip`（当前）、`fgs-v5-1.2.0.zip`（v5.1 全绿基线）、`fgs-v5-1.1.0.zip` |
| 网络 | 本机可访问外网；**托管竞赛沙箱无公网**（镜像必须自带一切） |

自检命令（改任何东西之前先跑）：

```bash
cd /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0
node --test "tests/*.test.mjs" 2>&1 | grep -E "^# (tests|pass|fail)"   # 期望 321 / 321 / 0
python3 -m py_compile contest/activity_loop.py contest/driver.py tests/fixtures/fake_worker.py
node -e "import('./index.js').then(m=>console.log(m.PLUGIN_VERSION, m.PLUGIN_GENERATION))"   # 1.3.0 16
```

## 2. 今天交付了什么（v5.2）

- 设计 + 实现手册：[`V5_2_PLAN_DECIDE_CONCURRENCY.md`](V5_2_PLAN_DECIDE_CONCURRENCY.md)（§12 checklist 全勾）
- 落地记录（改动清单、与方案差异、10 条不变量、已知限制）：[`V5_2_LANDING.md`](V5_2_LANDING.md)
- 新增测试 23 条：`rebase.test.mjs`(8) / `plugin_v52.test.mjs`(7) / `activity_loop_v52.test.mjs`(7) / driver(+1)
- 版本 1.3.0 / gen 16 / BUILD_TAG 前缀 `16+...concurrent-decide+rebase-commit`；4 处代次断言同步
- 打包：`fgs-v5-1.3.0.zip`（解压后 321/321 已验证）

关键行为：只有 `FGS_ACTIVITY=decide` + `FGS_REBASE=1` 的 run 走 rebase（逐项校验、冲突回报、
其余落盘）；legacy/Execute 仍是整批原子；关闭 `CONTEST_CONCURRENT_DECIDE` 逐行为等于 v5.1。

## 3. 三个必须先知道的环境陷阱

1. **web profile 的 `dsh.profile.bundles` 会被 agent-team bundle 重写，把 fgs 丢掉**（已发生两次）。
   今天又发现丢了，已补回并备份为 `package.json.bak-fgs-rebundle-20261022-235335`。
   **重启 `dsh web` 前先检查**：
   ```bash
   python3 - <<'PY'
   import json;d=json.load(open('/home/ubuntu/.dsh/profiles/web/package.json'))
   print(d['dsh']['profile']['bundles'])
   PY
   # 必须包含 @local/fgs-v5-dsh；另外 cordis.patch.yml 里应有 - id: fgs-v5 / disabled: false
   ```
   丢了就补回（`dsh plugin --profile web add /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0` 是正规做法，
   但它会碰运行中的 profile；手工补 bundles 更稳，补完必须重启才生效）。
2. **不要 kill 正在跑的 `dsh web`**：它承载会话。要加载新代码，让用户重启；重启后
   `curl -s "http://127.0.0.1:3080/fgs/state?token=<token>"` 看 `pluginGeneration=16`、
   `graphRev` 出现（不带 token 的请求会被掩成 404，和"没加载"分不清）。
3. **活动模式下 `/fgs/state?sessionId=` 查不到活动 run**（`run.sid` 是 runId 不是会话 id，
   v5.1 既有行为）。验证活动 run 用无参或 `?problemId=`；细节见 `V5_2_LANDING.md` §3.4。

其他小坑：无 git（改坏解压 zip 覆盖）；打包排除 `__pycache__`/`.fgs`/`contest-work`；
`dsh --session-id` 只能接管**已存在** session（收束轮依赖 `session-persistence-jsonl`，dsh-base 默认有）。

## 4. 架构速览（够用来改代码）

```
DSH 宿主席
 ├─ index.js            插件入口：工具注册/提示词/guard/命令/HTTP 路由/活动启动
 │   ├─ controller/index.js   唯一写者：validate + transact(文件锁) + revisionOf/applyBatch(v5.2)
 │   ├─ controller/activity.js 选择规则：bootstrap|decide|execute|wait|done|defer|budget
 │   ├─ hooks/*               注入上下文、角色文案、FLAG 硬门、写图预检
 │   └─ tools/*.mjs           给编排器用的 CLI（activity/claim_step/release_step/bootstrap_project）
 └─ contest/
     ├─ entrypoint.sh → driver.py      列题、起题、种题、拉起编排器、supervisor（reap/retire/补派）
     ├─ driver.py                      fixture/平台 API、预算、并发、activity_loop_argv 透传
     ├─ activity_loop.py               活动编排：pick → claim → spawn dsh → 收账 → 超时收束
     ├─ supervisor/                    本地 worker 目录模式（driver 内已含，不另起 autosup）
     └─ Dockerfile                     **P0 骨架**（只有 node+python3，无渗透工具、dsh 未 vendor）
```

活动协议（编排器 → 插件）：`FGS_ACTIVITY`、`FGS_STEP`、`FGS_RUN_ID`、`FGS_LEASE_MS`、
`FGS_BUDGET_MS`、`FGS_CONCLUDE`、`FGS_SUPPRESS_SIGNAL_FLUSH`；v5.2 加 `FGS_REBASE`、
`FGS_REBASE_MODE`、`FGS_DECIDE_TIMEOUT_MS`。完整表在 `docs/V5_ACTIVITY_RUNS.md` §3。

## 5. 历史与关键决策（压缩后别丢的东西）

| 时间线 | 决策 |
|---|---|
| 起点 | 从 Cairn v1 源码（用户 Windows：`D:\XunLei\cairn\repo`，此 Linux 会话**访问不到**）+ Cairn_Y 文章提炼亮点；结论是做成 **DSH 插件**而不是模式，然后在插件上迭代 |
| v5 | 活动 run 化（一活动一进程、注册期工具隔离、预算透传）；放弃单会话角色切换作为竞赛路径（保留 legacy） |
| v5.1 | 补 Cairn 六条机制：写锁事务、预认领、bootstrap 冷启动、Finding/每 K 次触发 Decide、两阶段收束、预算。**298 tests** |
| v5.2 | 补最后一处结构差距：Decide 与 Execute 并发 + rebase 提交 + delta 回灌。**321 tests** |
| 竞赛路径 | `CONTEXT_*` 旋钮默认：每题 1800s、单活动 600s、parallel 2、max active 3、decide_every 3、cold start 开；并发 Decide 默认**关** |

实现时的取舍（写在 `V5_2_LANDING.md` §3）：并发模式线程池 `parallel+1`；`max-decides` 用尽且
无候选 → `mark_deferred` + `deferred`（与 v5.1 defer 语义一致）；loop 测试用 `--parallel 3`
才能制造 `startedWhileExecutes=2`。

## 6. DSH 接线现状（明天要用）

- **web profile**：`package.json` 的 `dependencies` 有 `@local/fgs-v5-dsh: link:/home/ubuntu/ws/fgs-v4-5624fa3-1.0.0`；
  `dsh.profile.bundles` 今天已补回（见 §3）；`cordis.patch.yml` 有：
  ```yaml
  - id: fgs-v5
    disabled: false
    config:
      autoAttach: false
      treeRoot: /home/ubuntu/ws/tsecbench-run/run4/workers
  ```
  **运行中的进程仍是旧代码（gen 15）**，需要用户重启 `dsh web` 才加载 1.3.0/gen16。
- **headless profile**（竞赛 worker 用）：bundle + dependency 都在，patch 里 `- id: fgs-v5 disabled: false`。
- `pnpm-lock.yaml` 里还残留旧包名 `@local/fgs-deepseek-dsh`（历史更名遗留）；不影响运行，
  但 `dsh plugin list` 会显示旧名。下次正规重装时用 `dsh plugin --profile web add <repo>` 会归一化。

## 7. 明天从哪开始

1. 读 [`CHAMPION_ROADMAP.md`](CHAMPION_ROADMAP.md)（P0：真镜像 → 度量 harness → 时间预算）。
2. 先确认基线：§1 的三条命令。
3. 建议第一个动作：**P0-2 度量 harness 的最小骨架**（不依赖真 key 就能先把链路跑通），
   同时把 **P0-1 镜像 Dockerfile** 的完整工具清单落成可构建的版本。
4. 开放问题清单在 roadmap §7（评分规则、3GB 取舍、模型可选性、一题多 agent、真 key 时间）。

## 8. 协作约定（用户偏好）

- 中文沟通；**结构化**（表格/清单）、给**可点击的文件链接**、**诚实说明未验证项**。
- 用户会追问"有没有危害/为什么"，回答要区分「实质风险」与「体验问题」。
- 大改动前先给方案（用户常要求先落文档再动手）；文档要自足（用户会压缩上下文后直接要求照文档实现）。
- 不要 kill 用户正在用的服务；不要把密钥写进仓库/图/文档。
