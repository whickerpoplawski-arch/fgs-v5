# NEXT_STEPS —— 接手入口（上下文被压缩 / 明天新会话先读这里）

> 更新：2026-10-22 23:55。当前包 `@local/fgs-v5-dsh` **1.3.0** / generation **16** / 321 tests 全绿。
> 工作目录：`/home/ubuntu/ws/fgs-v4-5624fa3-1.0.0`（目录名历史遗留，内容就是 v5.2）。
> 没有 git：改坏了用 `/home/ubuntu/ws/fgs-v5-1.2.0.zip` 解压覆盖（v5.1 全绿基线）。

## 恢复顺序（照这个来）

1. **`docs/HANDOFF_V5_2.md`** —— 环境、历史决策、DSH 接线、三个环境陷阱（必读）。
2. **`docs/CHAMPION_ROADMAP.md`** —— 下一步往哪走（P0：真镜像 → 度量 harness → 时间预算）。
3. 跑下面的基线命令，确认 321/321。

## 基线（做任何事之前先确认）

```bash
cd /home/ubuntu/ws/fgs-v4-5624fa3-1.0.0
node --test "tests/*.test.mjs" 2>&1 | grep -E "^# (tests|pass|fail)"   # 期望 321 / 321 / 0
python3 -m py_compile contest/activity_loop.py contest/driver.py tests/fixtures/fake_worker.py
node -e "import('./index.js').then(m=>console.log(m.PLUGIN_VERSION, m.PLUGIN_GENERATION))"  # 1.3.0 16
```

版本/代次断言在 4 个测试文件里（`schema_ux`、`verify_v3_adversarial`、`verify_v4_adversarial`、
`verify_v4_final`），改版本时 4 处一起改。

## 当前是什么状态

**v5.2（Decide 与 Execute 并发）已实现并全绿**：

- 设计 + 实现手册：`docs/V5_2_PLAN_DECIDE_CONCURRENCY.md`（§12 是改代码时的第一参考）
- 落地记录 / 与方案的差异 / 已知限制：`docs/V5_2_LANDING.md`
- v5.1 运行时设计：`docs/V5_ACTIVITY_RUNS.md`
- 与 Cairn v1/v2 的对照：`/home/ubuntu/cc/cairn-highlights-and-dsh-placement.md`

## 还没做的事（按优先级）

1. **真镜像**（P0）：`contest/Dockerfile` 还是骨架（node+python3，无渗透工具、dsh 未 vendor）。
   工具清单与验收见 `docs/CHAMPION_ROADMAP.md` §4.1。
2. **度量 harness**（P0）：10 道题的 eval（SR/TTF/tokens/活动数），先基线再优化。
3. **真实模型 E2E**（P0）：带 key 的 headless 跑一道题，验证 `--session-id` 收束轮与
   rebase 回灌下的规划行为。
4. **竞赛镜像重建**：装 1.3.0 + `CONTEST_CONCURRENT_DECIDE=1`，跑真题量墙钟收益
   （期望：图变到重规划的延迟从 `activity_timeout`(600s) 降到秒级）。
5. **DSH 实战**：web profile 的 bundle 已补回（备份 `package.json.bak-fgs-rebundle-*`），
   需要用户重启 `dsh web` 才加载 1.3.0/gen16；重启前先检查 bundles 没被 agent-team 重写掉
   （见 `docs/HANDOFF_V5_2.md` §3）。

## 关键开关

插件 env（只由编排器注入）：`FGS_REBASE=1`、`FGS_REBASE_MODE=append|full`、`FGS_DECIDE_TIMEOUT_MS`。
竞赛旋钮：`CONTEST_CONCURRENT_DECIDE=1`、`CONTEST_DECIDE_TIMEOUT=300`、
`CONTEST_MAX_DECIDES=12`、`CONTEST_REBASE_MODE=full`；
默认 `CONTEST_ACTIVITY_PARALLEL=2`、`CONTEST_CONCLUDE_TIMEOUT=120`、`CONTEST_DECIDE_EVERY=3`、
`CONTEST_COLD_START_STEP=开`。

## 打包

```bash
cd /home/ubuntu/ws && rm -rf /tmp/pkg && mkdir -p /tmp/pkg/fgs-v5-1.3.0 \
 && tar -C fgs-v4-5624fa3-1.0.0 --exclude=node_modules --exclude=__pycache__ --exclude='*.pyc' \
      --exclude=.fgs --exclude=contest-work --exclude='*.bak' -cf - . | tar -C /tmp/pkg/fgs-v5-1.3.0 -xf - \
 && (cd /tmp/pkg && rm -f /home/ubuntu/ws/fgs-v5-1.3.0.zip && zip -qr /home/ubuntu/ws/fgs-v5-1.3.0.zip fgs-v5-1.3.0)
```
