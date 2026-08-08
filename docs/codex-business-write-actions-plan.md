# Codex 业务写动作计划

## 1. 最可能需要调整的决定

### 1.1 首批外部写入只增加“确认发送回复”

```ts
type ButlerActionKind =
  | 'reply' // 只放入编辑框
  | 'send'  // 用户确认后发送
  | 'todo'
  | 'commitment'
  | 'ado'
  | 'codex';
```

- **Confidence: high**
- “拟回复”继续只写编辑框；“帮我回复 / 发给他”生成可编辑的发送确认卡。
- 当前 ADO 工作项创建已经通过确认卡进入现有创建对话框，不重复实现。
- ADO 评论和状态更新留到下一切片。
- **What would flip it:** 如果 Rocket.Chat 不能接受客户端提供的稳定消息 ID，首批外部写入必须退回只生成草稿。

### 1.2 当前业务 MCP 保持只读，写入由 RocketX Host 执行

```text
自然语言
  -> Codex draft_action(kind = "send")
  -> RocketX 可编辑确认卡
  -> typed checkpoint 进入 running
  -> Host 使用当前登录会话发送
  -> checkpoint + audit + 回执
```

- **Confidence: high**
- Codex 不取得 Rocket.Chat token，不直接调用写 MCP。
- 用户确认前没有外部副作用。
- 不增加常驻工具按钮；只有明确写入意图才出现确认卡。
- **What would flip it:** 只有 Codex 固定版和系统版都验证了 MCP 写工具审批、取消、重试和恢复语义，才考虑把执行器迁入 MCP。

### 1.3 消息写入使用 checkpoint 派生的稳定客户端消息 ID

```ts
interface ButlerActionDraft {
  checkpointId: string;
  messageId?: string; // send 动作必须存在，17 位安全字符
}

interface ChatSendOptions {
  rid?: string;
  tmid?: string;
  quote?: RcMessage;
  clientId?: string;
}
```

- **Confidence: high**
- 同一确认卡重试始终提交同一个消息 ID；服务端已落库但响应丢失时，沿用现有按 ID 回查逻辑。
- checkpoint 只有收到明确投递结果后才完成；失败保持可审查、可重试。
- **What would flip it:** 如果真实 Rocket.Chat Server 拒绝该 ID 格式，改为创建草案时调用现有 `randomMessageId()` 并把结果持久化，而不是放弃稳定 ID。

### 1.4 ADO 评论、状态更新和高风险动作不进入本批

- **Confidence: high**
- `directComment` 没有远端幂等键，崩溃窗口可能生成重复评论。
- 状态更新虽接近幂等，但需要目标工作项、合法状态和权限预览合同。
- 删除、PR 投票/合并、构建操作、发布继续禁止。
- **What would flip it:** 找到或实现可查询的远端 operation marker 后，ADO 评论可以进入下一批。

## 2. Assumptions

- **High / code:** `ButlerToolCheckpoint` 已持久化状态、幂等键、attempt、审计和恢复错误，不新建审批系统。
- **High / code:** `useChat.send` 已使用客户端消息 ID、乐观回显、按 ID 回查和 LAN 降级；只需增加稳定 ID输入与明确结果。
- **High / user direction:** 聊天是唯一入口，写入由自然语言触发，不增加常驻动作工具台。
- **High / product contract:** 草稿可自动生成；外部写入默认逐次确认。
- **Medium / server contract:** Rocket.Chat 接受 17 位字母数字客户端消息 ID；用真实/模拟 REST 回归和后续 dogfood 验证。

## 3. Deviation policy

- 遇到边界情况时选择可逆、最小爆炸半径、最接近“确认后单次发送”的方案，记录到实现说明后继续。
- 如果稳定消息 ID 不被服务器接受，保留 `send` 动作和审批 UI，改为在草案创建时生成并持久化现有格式的消息 ID。
- 如果发送结果无法可靠区分成功和失败，停止外部发送能力，不把“已进入本地队列”冒充“已发送”。
- 遇到需要扩大凭据范围、绕过审批、增加删除/合并/发布能力或破坏现有消息发送语义时停止并重新评审。

## 4. Mechanical work

低评审价值，交给实现者：

1. 扩展 `ButlerActionKind`、规范化、预览、capability、标签和基础指令。
2. 为 `send` 草案生成并持久化稳定 `messageId`。
3. 扩展 `useChat.send` 的 options 和返回结果，保持所有现有调用兼容。
4. 在 `ButlerActionCard` 中增加确认发送分支。
5. 更新动作审计标签、回归白名单和实现说明。

## 5. Verification

可观察验收：

1. “帮我拟个回复”仍只把文字放进编辑框，不发送。
2. “帮我回复……”产生“发送回复 · 等待确认”卡，确认前 REST 零调用。
3. 确认后只发送一条消息，并显示明确回执。
4. 同一 checkpoint 重试沿用同一消息 ID；模拟请求超时但服务器已落库时不产生第二条。
5. 失败时 checkpoint 保持 failed/retryable，不显示成功回执。
6. 重启恢复 running checkpoint 时不自动重放。
7. Web typecheck、动作/消息定向回归和全量 regression 通过。

## Handoff

- 实现期间维护 `docs/implementation-notes-codex-business-write-actions.md`。
- 发现偏差时立即记录文件/行号、原计划、实际选择和原因。
- 第三个偏差或单个 Surprise 推翻计划前提时停止实现，重新运行 kickoff。

