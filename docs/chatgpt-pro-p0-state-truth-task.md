# ChatGPT Pro 工程任务：P0 状态可信闭环

## 背景与目标

RocketX 是一个基于 Codex App Server 协议、深度集成 Rocket.Chat 与 Azure DevOps 的个人助理产品。当前 ADO 受控写入的身份绑定、unknown-result 和共享 deadline 已完成；产品成熟度审计把下一优先级确定为 P0-1“状态可信闭环”。

本任务不是新增 Agent Runtime，也不是扩展功能。目标是让现有状态机满足：

1. 所有 loading/starting/running 状态都有可证明的终态；
2. 离线或 app-server 中断必须被明确投影给用户；
3. 失败后保留上下文并提供安全、显式的恢复入口；
4. 多会话错误不得串到无关会话；
5. 刷新或进程重启后不能把中断状态伪装成成功或继续运行。

## 当前源码基线

- 仓库：`D:\Repos\rocketchatx`
- 分支：`main`
- HEAD：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 工作区存在大量未提交改动；本压缩包中的文件是当前工作区快照，不应假设等同于 HEAD。
- `apps/web/src/stores/workbench.ts` 已有与本任务无关的用户改动，禁止覆盖或回退。

## 已确认的真实缺陷

`apps/web/src/stores/sharedAgent.ts` 的 `resumeSession()`：

1. 先把持久化 session 从 `interrupted` 改为 `starting`；
2. 再启动 app-server 并调用 `thread/resume`；
3. 成功时改为 `ready`；
4. 但 `ensureClient()`、`thread/resume` 或 lease-card 更新失败时没有 catch/finally 状态收口。

因此，如果请求超时、协议错误或服务端拒绝，session 会永久停在 `starting`。`AgentPanel.tsx` 只在 `interrupted` 显示“恢复”按钮，所以用户同时失去恢复入口。按钮使用 `void resume(tmid)`，失败还可能形成未处理 Promise rejection。

## 需要研究和修改的范围

优先级 A，必须交付：

- `apps/web/src/stores/sharedAgent.ts`
- `apps/web/src/agent/session.ts`
- `apps/web/src/components/AgentPanel.tsx`
- 对应 regression/UI tests

要求：

- resume 任何失败都必须在有限时间内落到显式、可恢复的状态；
- 保留原 `codexThreadId`、workspace、host lease 和上下文；
- 清除失效的 `activeTurnId`、审批和 in-flight waiter；
- 不自动重放任何 turn 或副作用；
- 错误归属具体 session，不能让 A 会话的错误显示在 B 会话；
- UI 显示中文状态与恢复动作；
- 恢复按钮自身必须有 pending 防重复提交，并处理 rejection；
- 继续复用现有 `AgentSessionStatus`、`interruptSession()`、持久化与 AppServerClient，不增加第二套 runtime。

优先级 B，评审并给出最小建议：

- `localCodex.ts` 的 resume/send 已有 catch，但缺少真实运行时回归测试；
- `workbench.refresh()` 已有 finally，但失败/重试闭环缺少测试；
- Rocket.Chat reconnect/offline UI 缺少端到端状态恢复证据。

如果这些与 A 相互独立，请不要把它们揉进同一个大补丁；只报告后续独立切片及验收标准。

## 明确交付物

1. 基于源码的缺陷确认或反证，必须给出文件和行号；
2. 最小、完整、可应用的 unified diff，仅覆盖优先级 A；
3. 新增测试清单与实际运行命令；
4. 安全边界审查：自动重放、审批残留、跨会话错误污染、持久化恢复；
5. 对优先级 B 的排序建议，但不要实现；
6. 未验证风险与真实环境验证步骤。

## 必须执行的测试

- 失败注入：`thread/resume` 明确错误；
- 失败注入：`thread/resume` 15 秒超时；
- 失败注入：app-server 在 resume 中退出；
- 断言失败后不再是 `starting`，而是可恢复的 `interrupted`；
- 断言旧 threadId、workspace 与会话归属仍保留；
- 断言对应审批/waiter 清除且不自动发起 turn；
- 断言再次显式点击恢复可以成功进入 `ready`；
- 断言并行两会话中，A 失败不污染 B 的错误或状态；
- Web typecheck；
- 定向 regression；
- 对应 UI/Playwright。

## 禁止操作与禁止声称

- 禁止提交、推送、创建 PR、部署或访问真实用户数据；
- 禁止修改 lockfile、引入依赖、重构整个 Agent Runtime；
- 禁止覆盖当前 dirty worktree 的既有改动；
- 禁止自动重试 `turn/start`、写操作或审批；
- 禁止用源码字符串断言冒充真实行为测试；
- 未运行的测试不得声称通过；
- 模拟 app-server 测试不得声称是真实 Codex/生产验证。

## 验收标准

- `resumeSession()` 的每条成功/失败路径都有明确终态；
- 用户不会无限看到“正在启动”；
- 失败原因在正确会话可见，其他会话不受污染；
- 用户可以从同一 session 显式重试；
- 重试不会自动重放旧 turn、审批或副作用；
- 回归、UI、typecheck 通过；
- diff 小、分层不变、没有新依赖。
