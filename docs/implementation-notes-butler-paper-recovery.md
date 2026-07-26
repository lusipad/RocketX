# Implementation notes — Butler paper recovery
Plan: `docs/butler-sole-surface.md`（刀 1.5）

## Decisions

- 2026-07-26：TODO 直接消费 Codex `turn/plan/updated`，不从 trace 推断，也不新增独立任务源。
- 2026-07-26：单件活叫停使用该活自持 AppServerClient 的 `turn/interrupt`；没有活动 turn 的排队阶段则直接停止该 client。
- 2026-07-26：过程尾巴展示每件活现有 trace 的最近 6 行；完整原文继续由 `codex resume <threadId>` 提供。

## Deviations

## Surprises

- Claude Code 的主会话并非因实现失败停止，而是子任务在理解检查处等待输入，随后 OAuth token 被撤销。
- 已落盘实现把 TODO 留成空插槽，且未把单件活叫停接到派活 store；这两项与刀 1.5 的验收合同不符。

## Questions for review
