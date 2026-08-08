# Butler 文字协调层实施计划

目标：让 Butler 成为文字版 GPT-Live。主对话负责理解、查询和协调；复杂工作继续由
独立的 Codex Thread、Goal 和原生审批执行。

## 1. 最可能调整的决策

### 1.1 同一任务使用原生 `turn/steer`

- 接口：`steerErrand(runId, instruction)`。
- 有活动 turn 时调用 `turn/steer(expectedTurnId)`；没有活动 turn 时在同一持久
  thread 上开启 follow-up turn。
- 不创建第二个任务，不重建 Agent Loop。
- **Confidence: high**
- **What would flip it**：仓库固定或系统 Codex runtime 拒绝 `turn/steer`。

### 1.2 Butler 只协调来源会话内的任务

- 派活记录增加 `originSessionId?: string`。
- `list_errands` 默认只返回当前 Butler session 发起的任务。
- `steer_errand` 未给 `runId` 时，只允许当前 session 恰好有一件可继续任务；
  多件时要求用户点名，旧任务没有来源 session 时继续保留卡片控制。
- **Confidence: high**
- **What would flip it**：产品明确要求一个会话静默控制其他会话发起的任务。

### 1.3 重启后安全暂停，不自动重放

- 原 `running` / `awaiting-approval` 记录恢复为 `paused`，保留 thread、Goal 线索和
  过程记录，清除已经失效的审批 waiter。
- 用户点击“继续”或在原对话补充要求后，RocketX `thread/resume` 原 thread，
  先读取 Goal；已完成则只回收结果，未完成才显式开启续跑 turn。
- **Confidence: medium**
- **What would flip it**：实测证明 app-server 能跨进程原样恢复未完成审批和活动 turn，
  且不存在副作用重复窗口。

### 1.4 结果回流为简短对话，详情继续留在任务卡

- 首次等待审批、暂停、失败或完成时，在 `originSessionId` 对应会话追加一条 Butler
  消息。
- 对话只放结论摘要；完整回复、计划和 trace 保留在折叠任务卡。
- **Confidence: high**
- **What would flip it**：用户要求所有执行输出逐字进入主对话。

## 2. 假设

- Codex app-server 是唯一 Agent Runtime；来源：当前代码和用户确认。**高**
- 派活最多五件，按 session 缩小默认选择后，单任务隐式选择可接受；来源：当前限制。
  **高**
- `turn/steer` 在固定和系统 runtime 都可用；来源：生成协议，仍需运行时探针。**中**
- 未回答审批跨进程不能安全重建；来源：当前 waiter 是内存 Promise。**高**

## 3. 偏离策略

- 遇到协议或恢复边缘情况，选择可逆、显式、不会重复副作用的行为并记录后继续。
- 若发现恢复必须放宽 sandbox、绕过审批或自动重放未确认写操作，停止实现并重新评审。
- 不改终端、Worktree、完整任务中心、Skill Runtime 或其他不相关界面。

## 4. 机械工作（低评审价值）

- 给 `AppServerClient` 补齐生成协议已有的 `turn/steer` 类型和响应校验。
- 扩展 errand 状态、来源 session、steer/resume actions。
- 增加 `list_errands` / `steer_errand` Host Tools。
- 给暂停任务增加“继续”入口。
- 将任务关键事件追加到来源 Butler session。
- 补协议、store、持久化和 UI 回归。

## 5. 验证

- 活动 turn 接收 steer，仍使用同一 thread 和 turn。
- 空闲但未完成的任务在同一 thread 开 follow-up turn。
- 多任务时不允许含糊地控制错误任务。
- 模拟重启后任务显示为可继续；续跑先 resume/read Goal，不创建新 thread。
- 已完成 Goal 恢复时只回收结果，不重复执行。
- 完成、失败和审批消息只写入来源会话一次。
- Web typecheck、相关回归、全量 regression 和定向 UI 通过。
