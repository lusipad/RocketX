# Implementation notes — Codex ADO 状态写入

Plan: `docs/codex-ado-state-write-plan.md`

## Summary

- ADO 状态动作现在冻结 revision、连接描述和稳定的非秘密 identity id。
- 确认时重新读取 identity；配置未变但实际账号变化时在 PATCH 前 fail closed。
- PATCH 结果未知会把 checkpoint 标为不可重试并锁定旧卡，重启后也不会静默重放。
- 受控 `GET -> PATCH -> GET` 共享 15 秒 absolute deadline，PATCH 不重试且最多一次回读。
- PAT/NTLM 直连使用真实 request deadline；Rust WinHTTP 的四项 timeout 共享 remaining budget。

## Decisions

- 使用专用 `draft_ado_state`，保留 `draft_action(kind=ado)` 的“创建工作项”语义。
- 写入由 RocketX Host 通过现有 ADO 直连执行；Business MCP 保持只读。
- 采用目标状态幂等、revision 并发保护和写后回读。
- Todo/commitment 必须等待本次本地持久化完成后才完成 checkpoint。
- 显式 HTTP 4xx 视为服务端确定性拒绝；timeout、网络错误和 5xx 在不能正向确认成功时视为 unknown。
- 同步 WinHTTP 只承诺收紧可控阶段，不宣称数学上严格的 15 秒 wall-clock 上限。

## Deviations

- ChatGPT Pro 生成的 round 3、round 4 和 deadline v2 patch 均未直接采用；Codex 在隔离工作树独立实现并由本地 reviewer 与 ChatGPT Pro 复审。
- 没有把 Business MCP 扩展为写能力；受控写仍留在 Host direct path。

## Surprises

- Workbench 已有确认后直连 PATCH，但没有 revision 并发保护和写后回读；聊天动作不能直接复用这段盲写语义。

## Verification

- `pnpm typecheck`：PASS。
- `pnpm test:pure`：230/230 PASS。
- `pnpm test:regression`：926/926 PASS。
- ADO 定向回归：50/50 PASS。
- ADO Playwright：4/4 PASS。
- `pnpm codex:protocol:check`：PASS。
- `pnpm build`：PASS（仅既有 chunk 警告）。
- `cargo fmt --check`：PASS。
- `cargo test --no-fail-fast`：75/75 PASS。

未验证真实 ADO Server 2022、PAT/NTLM、极端网络、安装包或生产环境。

## Questions for review
