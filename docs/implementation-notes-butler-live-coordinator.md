# Implementation notes — Butler 文字协调层

Plan: `docs/butler-live-coordinator-plan.md`

## Summary

已完成最小协调闭环：

- Butler 可用 `list_errands` 查询当前对话派出的任务，并用 `steer_errand` 给原任务
  补充约束。
- 活动 turn 使用原生 `turn/steer`；空闲任务继续使用同一 thread 的新 turn。
- 重启后的运行态与审批态安全恢复为 `paused`，只在用户明确继续后
  `thread/resume`，不会自动重放外部动作。
- 首次审批、暂停、失败和最终结果会回到发起任务的 Butler session；完整细节仍留在
  任务卡。
- 暂停任务可在任务卡直接继续或叫停。

## Decisions

- 2026-07-31：生成协议已包含 `turn/steer`；优先接入原生方法，不用 interrupt +
  新线程模拟。证据：`apps/web/src/agent/protocol/generated/ClientRequest.ts`。
- 2026-07-31：重启恢复采用显式续跑；恢复阶段不自动重放写操作或未回答审批。
- 2026-07-31：`steer_errand` 是用户当轮明确表达的方向调整，因此按 `draft` effect
  立即送入已获授权的原任务；任务内部仍服从原 sandbox 与审批策略，不再加一层重复
  确认。
- 2026-07-31：任务查询和控制按发起时的 `originSessionId` 隔离；Butler turn 在开始
  时捕获 session id，避免异步工具调用误用后来切换的会话。

## Deviations

- 恢复设计原本写作“先读 Goal 再决定”；实际先检查 `thread/resume` 返回的活动状态。
  如果仍在等待审批/输入，或线程 active 却没有可续跑 turn，会直接保守暂停，不再读
  Goal。这比原计划更安全，也避免制造重复 turn。
- 恢复到已有 `inProgress` turn 时使用 `turn/steer`；只有没有活动 turn 且线程不是
  可疑 active 状态时才 `turn/start`。

## Surprises

- `turn/steer` 已存在于生成协议，但 `AppServerClient.ClientMethods` 尚未暴露。
- 当前 errand 持久化保留 `threadId`，但运行时 `sessionId` 和审批 waiter 仅在内存；
  新进程必须创建 transport 后再 `thread/resume`。
- 固定 Codex `0.144.4` 与系统 Codex `0.145.0` 都通过 shell contract，均暴露
  `turn/start`、`turn/steer`、`turn/interrupt`，持久 Goal 与子代理结果回传也可用。
- 固定 Codex `0.144.4` 的真实跨进程审批探针显示：旧进程停在
  `item/commandExecution/requestApproval` 后退出，再 `thread/resume` 会返回 idle，
  不会伪造可继续回答的旧审批。若某个外部实例仍让线程保持 waiting，RocketX 明确
  降级为 `codex resume` 接管。
- 重启后直接叫停 paused 任务会先恢复最小控制面、暂停 Goal，再中断活动 turn；
  任一步无法确认时都保持 paused，不向用户宣称“已叫停”。

## Questions for review

- 当前按“状态迁移”投递对话提醒；若进程恰好在任务终态落盘与会话消息落盘之间退出，
  重启后仍可在任务卡看到结果，但不会自动补投那条摘要。为避免新增投递游标和迁移
  复杂度，本轮接受这个极窄窗口。

## Verification

- `pnpm typecheck`：7 个工作区包通过。
- `pnpm test:regression`：871/871 通过。
- `pnpm exec playwright test tests/ui/butler-interactions.spec.ts --grep "重启后暂停的活"`：
  1/1 通过。
- 固定 Codex `0.144.4` 与系统 Codex `0.145.0` 的
  `scripts/spike-codex-shell-contract.ts`：均 PASS。
- 独立代码审查：最终结论 APPROVE，0 个遗留 correctness 问题。
