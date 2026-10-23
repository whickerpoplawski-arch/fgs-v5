# Deferred 之后 Execute 必须停

`execute_timeout`（以及任何把 `meta.state` 写成 `deferred` 的路径）只表示这道题的 Execute 会话结束。

到期时仍然：

- 写一条未完成 Fact，step 保持 `open`，认领释放（`owner` 清空）
- `meta.state=deferred`，并写入 `deferredAt` 与 `deferredReason`
- 不删除已有 fact / goal / step

到期之后，这道题上的这些调用必须被拒绝，错误里带 `deferred` 和 `deferredReason`：

- `fgs_open_step`
- `fgs_claim_step`
- `fgs_submit_fact` / `fgs_commit_step`
- `fgs_commit` 里带 `open_step` 或 `claim_step`
- 环境工具（如 `bash`）

`fgs_status` / `fgs_preview`，以及不重新认领的规划提交（如 `change_step_priority`）仍可调用。

若没有其它可做题，插件调用宿主已有的 `concludeTurn`（与 goal 满足相同的钩子）结束本会话。还有别的非 deferred 题时不结束会话，那些题仍可 `open_step`。重复结算不改已写入的 `deferredAt` / `deferredReason`，也不再追加一条未完成 Fact。

插件不调用 `reap.sh` / `retire.sh` / `autosup.sh`。容器回收仍由 runner / supervisor 负责；插件只保证本题不再进入 Execute，并在没有其它题时请求宿主结束会话。
