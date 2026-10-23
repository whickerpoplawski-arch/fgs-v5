# Contest supervisor

插件 D-002 已经在 deferred 之后拒绝 Execute（`docs/DEFERRED_STOP.md`）。进程和容器槽位不归插件管。本目录补的是这一层。

只把插件装进 profile `bundles` 不会启动这里的 reap / retire。那一层只在托管容器走 `contest/entrypoint.sh` → `contest/driver.py` 且 `CONTEST_SUPERVISOR=1` 时运行。对照 README「[托管容器额外要求](../README.md#hosted-container-extras)」。

A profile-bundle install does not run reap / retire. See README 「托管容器额外要求」.

## 谁在调度

托管入口只有一个调度器：`contest/driver.py`。

`CONTEST_SUPERVISOR` 默认开启。循环在 driver 进程内，顺序是：

1. **reap** — 容器仍是 `available` / `pending` / `stop_pending`，或本进程启动过的 worker 已经退出，且没有存活 pid → `close` 一次。有存活 pid → 留下。
2. **retire** — 存活 worker 的 meta 是 `deferred` 或 `solved`，或平台 `is_completed`。过宽限后 `SIGTERM`，仍在则 `SIGKILL`，然后 `close`。平台已通关但 meta 还不是 `solved` 用短宽限（默认 30 秒），其余默认 60 秒。`solved`（含平台对账）会把 worker 目录归档为 `_done_*`。
3. **gc** — `monitor_sampler.sh loop` 的 `SESSION_ID` 不属于存活 worker 时杀掉。
4. **补派** — `alive_workers < CONTEST_MAX_ACTIVE` **并且** `active_containers < CONTEST_MAX_ACTIVE` 才从本 driver 的未完成队列启动下一题。任一护栏顶满都不派。列表失败时按活跃容器已满处理，不补派。

队列空且没有存活 worker 时 driver 退出。`CONTEST_SUPERVISOR=0` 不进入循环，仍是一次性 list → start → 预种 → dsh。

`contest/supervisor/autosup.sh` 是 `$RUN/workers/wN_<code>` 那套目录布局的手动入口，内部同样是 gc → retire → reap → 双护栏。它和 driver **不能同时补派**：谁先拿到 `$RUN/monitor/scheduler.lock`，另一方直接退出。entrypoint 不会启动 `autosup.sh`。

## 环境

| 变量 | 默认 |
|---|---|
| `RUN` | `CONTEST_WORKDIR` |
| `BENCHMARK_TOKEN` / `BENCHMARK_BASE_URL` | 必填，运行时注入，不进镜像 |
| `CONTEST_SUPERVISOR` | `1` |
| `CONTEST_MAX_ACTIVE` | `3` |
| `CONTEST_RETIRE_GRACE` | `60` |
| `CONTEST_RETIRE_GRACE_SOLVED` | `30` |
| `CONTEST_SUPERVISOR_INTERVAL` | `20` |

`CONTEST_SUPERVISOR_INTERVAL` 是 driver 循环和手动 `autosup` 两轮之间的休眠秒数。`0` 仍合法（不休眠）。别名 `GRACE` / `GRACE_SOLVED` 仍覆盖对应的 `CONTEST_RETIRE_*`。

`reap.sh` / `retire.sh` / `autosup.sh` 缺 `RUN` 或 `BENCHMARK_*` 时失败并写明缺哪一个。路径和凭证只来自环境变量，不写死某一次 run 的目录或 env 文件。

## 竞赛推荐 env

默认已经与下面这一档对齐（deferred 之后大约再占宽限加一轮间隔）。上传页或编排可以显式写上，便于核对。本地单测可以 `CONTEST_SUPERVISOR=0`，或显式把 `CONTEST_RETIRE_GRACE` 拉大。正式赛不要关 supervisor。

```bash
# 竞赛推荐（本仓库默认已与此对齐；显式写出便于上传页/编排核对）
CONTEST_SUPERVISOR=1
CONTEST_MAX_ACTIVE=3
CONTEST_RETIRE_GRACE=60
CONTEST_RETIRE_GRACE_SOLVED=30
CONTEST_SUPERVISOR_INTERVAL=20
CONTEST_DSH_LAUNCH=1
SOLVER_GATEWAY=1
# + BENCHMARK_TOKEN / BENCHMARK_BASE_URL / 模型 key（运行时注入，勿进镜像）
# profile：openai-completions（勿用会丢 function_call 的 responses 流）
```

解题 prompt 不包含这些脚本。监管只动进程和槽位，不改题目内容。
