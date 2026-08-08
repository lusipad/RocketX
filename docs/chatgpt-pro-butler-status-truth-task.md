# ChatGPT Pro 工程任务：Butler paused / unknown 状态可信闭环

## 背景与目标

RocketX 是基于 Codex App Server 协议、深度集成 Rocket.Chat 与 Azure DevOps 的文字个人助理。产品必须让用户始终知道任务是在运行、等待、暂停、已交付、已知失败，还是结果暂时无法确认，并提供安全的下一步。

上一切片已修复共享 Agent 的永久 `starting`。本切片只处理 Butler 派活 runtime 中仍存在的两条假状态路径：

1. `turn/completed` 后 `thread/goal/get` 失败，当前代码只记录 warning 并 return，任务会永久显示 `running`。
2. 已有持久 `threadId` 的派活遇到 app-server 意外中断，当前统一进入终态 `failed`，丢失现有的显式恢复语义。

注意：当前 dirty worktree 已将 `paused` errand 投影为 `needs-user`，这不是待修问题。必须以附件源码为准，不得用 HEAD 或旧报告覆盖当前事实。

## 当前架构与不可破坏边界

- Codex App Server 是唯一 Agent runtime；不得新增第二套 router、sandbox、task runtime 或自动重试器。
- `ButlerErrandRun` 是持久任务真相；`ButlerWorkspaceModel` 和卡片只是投影。
- 已有 `paused -> thread/resume -> 读取原线程/Goal -> 用户显式继续` 链路。
- 未确认结果时禁止自动 `turn/start`，避免重复 ADO、Rocket.Chat 或其他外部副作用。
- `failed` 只应表达已知失败；已有 threadId 的控制面中断应优先保留可恢复性。
- 保留 dirty worktree 中与 Skill、Business MCP、Goal、steer/resume、ADO 安全有关的现有改动。
- 不新增依赖、不修改 lockfile、不改协议生成物。

## 需要研究的范围

重点逐行审查：

- `apps/web/src/stores/butlerErrandRuns.ts`
  - `settleCompletedTurn()`
  - `onInterrupted()`
  - `stopClient()` / `expectedStops`
  - `resumeThreadControl()` / `resumeErrand()`
  - notification、approval waiter、runtime/client map 清理
- `apps/web/src/lib/butlerErrands.ts`
- `apps/web/src/lib/butlerWorkspace.ts`
- `apps/web/src/lib/butlerPaper.ts`
- `apps/web/src/components/ButlerErrandRunCard.tsx`
- `apps/web/src/components/ButlerTasksView.tsx`
- 相关 regression 与 Playwright 测试
- 共享 Agent 已通过的 interrupted/显式恢复语义仅作为参考，不得照搬不同状态模型。

## 需要回答的架构问题

1. 是否应沿用 `paused + structured/user-readable reason`，还是必须新增 `offline` / `unknown` raw enum？请用现有消费者和持久化兼容性证明，不要凭偏好。
2. Goal 读取失败后应如何清理 client/runtime/buffer，才能离开 running 且不误杀远端线程？
3. `onInterrupted()` 如何区分已有 threadId 的可恢复任务与尚未成功创建 thread 的启动失败？
4. `stopClient()` 的 expected-stop 回调与外层异常是否可能造成重复状态迁移或覆盖原始错误？
5. 显式 resume 如何证明不会自动重放旧 turn 或重复外部副作用？
6. 哪些状态必须落盘，重启后能否保持同样的用户语义？

## 明确交付物

1. 以文件和行号为证据的根因报告。
2. keep / adapt / drop 状态语义清单。
3. 最小完整 unified diff 建议；只覆盖本 P0，不做旁支重构。
4. 可执行 TDD 测试设计，必须调用生产 Zustand store/notification 路径，不能只做源码字符串断言。
5. 对安全、持久化、并发、重复回调和多任务隔离的 blocker 级审查。
6. 明确 `PASS` / `REQUEST CHANGES`；未验证风险单列。

## 必须执行或设计的测试

- Goal 读取失败：`running -> paused`，清 activity，保留 thread/workspace，错误说明“结果暂时无法确认”，停止本地 client，不自动 `turn/start`。
- app-server 意外退出：已有 threadId 时进入 paused；无 threadId 时不得伪装可恢复。
- 目标任务 approvals/waiters 被清理，不影响另一任务。
- 重启/持久化后仍为 paused，并保留原因。
- 用户显式继续：只恢复同一 thread，依据真实 thread/Goal 决定是否继续，不重放旧 turn。
- UI：任务进入“需要我”，原因可见，“继续”只触发一次；无永远 spinner。

## 禁止执行或禁止声称

- 禁止 commit、push、PR、部署、数据库迁移、线上配置或真实用户数据操作。
- 禁止访问真实 Rocket.Chat / ADO / Codex 进程。
- 禁止声称未实际运行的测试通过。
- 禁止把 mock/fake transport 冒充真实生产联机验证。
- 禁止扩大为全局状态中心、自动重试框架或新 runtime。

## 验收标准

- 两条已确认假状态路径都有真实 RED，再由最小生产改动转 GREEN。
- 任何 failure/timeout/exit 分支都不会留下无 active turn 的永久 `running`。
- 未确认是否完成时不声明 failed/completed，也不自动重放；用户能看懂原因和下一步。
- 已知失败与可恢复中断不会混淆。
- 现有 paused、Goal、steer/resume、审批隔离测试不回归。
- Web typecheck、相关 regression、Playwright、pure、全 regression、协议检查、生产 build、`git diff --check` 通过。
