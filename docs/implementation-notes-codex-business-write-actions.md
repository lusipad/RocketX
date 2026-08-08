# Implementation notes — Codex 业务写动作

Plan: `docs/codex-business-write-actions-plan.md`

## Summary

- 已落地第一批受控业务写：新增 `send` 动作，经确认卡批准后才真正发送 Rocket.Chat 回复。
- 既有 `reply` 语义保持不变，仍只把文本放入原会话编辑框，不直接发出。
- 发送动作把稳定 `messageId` 持久化到草稿和 checkpoint，重试沿用同一个客户端消息 ID。
- 当服务端结果因网络/5xx 暂时无法确认时，返回 `unknown` 并提示用户先检查原会话；不长时间等待。

## Decisions

- 第一批只增加显式“发送回复”；既有“回复草稿”语义保持不变。
- 执行继续留在 RocketX Host，业务 MCP 保持只读。
- 发送使用确认卡持久化的稳定客户端消息 ID。
- chat store 接受可选 `clientId` 并返回 `server | lan | unknown | failed`，便于 Butler checkpoint 只在真实投递后完成。
- 显式传入非法 `clientId` 时 fail closed，不回退随机 ID，避免破坏幂等承诺。
- `sendMessageRaw` 失败后仅在不确定错误（网络/5xx）下按同一 `messageId` 回查；若回查到不同正文，则按冲突 fail closed，不误称新文案已发送。
- 受控发送失败时不提供普通聊天的独立重试按钮；重试继续从原确认卡进入同一 checkpoint。

## Deviations

## Surprises

- 仓库已具备本地待办、Memory、Routine、派活和 ADO 创建的写入/确认链路；本批不另建统一动作系统。
- 现有 `chat.send` 已用 `_id` 做服务端去重，最小改动只需补充显式 `clientId` 入口和乐观上屏去重即可。

## Verification

- `pnpm --filter @rcx/web typecheck`
- `pnpm exec tsx --test scripts/regressions/butler-action-proposals.test.ts scripts/regressions/chat-send-idempotency.test.ts scripts/regressions/member-single-flight.test.ts`：20/20 通过。
- `pnpm exec playwright test tests/ui/butler-interactions.spec.ts --grep "确认发送回复前"`：1/1 通过。
- `pnpm test:regression`：897/897 通过。

## Questions for review
