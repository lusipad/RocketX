# Implementation notes — Butler 持续工作系统

Plan: `docs/butler-continuous-work-system-design.md`

## Decisions

- 2026-07-28：复用现有 `useButler`、Todo、Routine、Rounds、Errand Run、Memory 和房间浮层，不另建第二套执行引擎。新领域层先作为这些事实源之上的统一投影，再逐步收敛持久化边界。
- 2026-07-28：RocketX 全局仍只有一个 Butler 入口；“现在、任务、例行照看、对话、记忆与偏好、连接与权限”是 Butler 内部视图。
- 2026-07-28：NeedToKnow 的“知道了”只确认注意力，不改变原 Todo、Routine 或房间提醒；确认记录按账号持久化，并提供撤销。
- 2026-07-28：Suggestion 接住后直接生成真实 Todo，原建议隐藏；撤销时同时删掉 Todo 并恢复建议，避免两套责任。
- 2026-07-28：长回答以 480 字、diff 或任务清单为确定性门槛沉淀为 Artifact。原聊天只保留摘要，Artifact 自己保存来源、验收状态和版本。
- 2026-07-28：Routine Contract 复用现有 Routine schema 增量迁移，所有调整和回退都追加版本，不覆盖历史运行。
- 2026-07-28：派活元数据按账号持久化。重启后无法安全续接的执行和审批转为明确失败、清除失效审批并保留原责任，避免重复外部动作。

## Deviations

- Task 暂不另建第二张持久化表；统一投影将现有 Todo 与 ButlerErrandRun 映射为同一任务视图。这避免双写，且所有操作仍回到原事实源。
- Decision 继续以 Codex 原生 approval 为事实源，由工作区投影和既有房间浮层共同呈现。当前 Codex transport 不提供跨进程 approval waiter 恢复，因此重启后的 open Decision 安全转为待重试失败，不伪装成仍可批准。
- 768px 的 Artifact 工作面采用对话上方的独立成果区；超宽屏双栏可在不改变 Artifact 合同的前提下继续演进。
- 本轮没有引入 Email、Notion、云文档等新连接，也没有重做 RocketX 全局品牌；符合设计文档 18.3 的明确边界。

## Requirement coverage

| 需求 | 实现证据 | 状态 |
|---|---|---|
| 一个 Butler、六个内部视图 | `ButlerWorkspaceNav`、`ui.butlerView` | 完成 |
| 主动工作驾驶舱 | `ButlerPage` 的概况、统一 Composer、上下文列 | 完成 |
| NeedToKnow / Suggestion 分流 | `buildButlerWorkspaceModel`、`butlerAttention` | 完成 |
| Suggestion 转持续责任并可撤销 | Rounds snooze/restore + Todo add/remove | 完成 |
| Task / Decision / Run 统一投影 | `butlerWorkspace` + `ButlerTasksView` + `ButlerErrandRunCard` | 完成 |
| Routine 健康、运行、配置、版本 | `ButlerRoutines` 四页签、真实 contract versions 和 rollback | 完成 |
| 对话与 Artifact 协作 | `butlerArtifacts` + `ButlerArtifactsPanel`，长输出自动沉淀 | 完成 |
| 可见记忆与连接边界 | 复用 `ButlerLearnedPanel` / `ButlerAuditTrail`，新增 `ButlerConnectionsPanel` | 完成 |
| 全新账号首次价值 | 无状态时显示三条真实入口，启用首个守护后进入正常工作区 | 完成 |
| 重启与账号隔离 | Attention、Artifact、Errand Run 加入 account scope；中断执行安全恢复 | 完成 |
| 390 / 768 / 1440 视觉与交互 | Butler 专属解除旧 940px 最小宽度；Playwright 三档快照，Routine 独立快照 | 完成 |

## Surprises

- 2026-07-28：当前 `ButlerPage` 仍是 760px “今日纸面”，管理和完整对话通过两个布尔状态互斥切换；与已确认的六视图主动驾驶舱存在结构性差距。见 `apps/web/src/pages/ButlerPage.tsx`。
- 2026-07-28：已有主动能力分散在 `butlerPoller.ts`、`butlerRoundsRunner.ts`、`routines.ts` 和 `butlerLedger.ts`，且部分状态仍在账户作用域的 `localStorage`，不能直接把任一模块当作统一责任核心。
- 2026-07-28：现有 ButlerErrandRun 原本只在进程内保存；若直接把 approval 持久化，重启后会出现“按钮还在但 waiter 已不存在”的假 Decision。实现选择显式失败恢复，而不是恢复一个不可执行的批准按钮。

## Questions for review

- 无阻断问题。真实 Rocket.Chat / Codex 外部写入仍受既有审批、沙箱和读回合同控制；本轮端到端测试使用确定性 mock，没有在生产服务器上制造消息或代码副作用。

## Verification

- `pnpm --filter @lusipad/rocketx typecheck`：通过。
- `pnpm test:regression`：772 / 772 通过，包含构建。
- `pnpm test:ui -- tests/ui/butler-workspace.spec.ts`：6 / 6 通过。
- 视觉验收：1440px 驾驶舱、1440px Routine 版本、768px Artifact、390px 真单列快照通过；`visual-verdict` 96 / 100。
- `git diff --check`：通过。
