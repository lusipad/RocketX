# Codex ADO 状态写入计划

## 1. 最可能需要调整的决定

### 1.1 用专用 `draft_ado_state`，不扩展通用 `draft_action`

```text
“建一个 ADO 工作项” -> draft_action(kind = "ado")
“把 #123 改成已解决” -> draft_ado_state(workItemId = 123, targetState = "已解决")
```

- **Confidence: high**
- 创建工作项与修改既有工作项是不同风险、不同参数的动作；保留两个明确工具，避免 `kind=ado` 同时承担两种语义。
- 新工具只读取当前工作项并生成确认卡，不直接 PATCH。
- **What would flip it:** 如果 Codex 动态工具数量成为实际瓶颈，再评估带判别联合类型的通用动作工具。

### 1.2 复用现有 Butler action checkpoint，新增 `ado-state` 动作种类

```ts
interface ButlerAdoStateDraft {
  kind: 'ado-state';
  workItemId: number;
  currentState: string;
  targetState: string;
  expectedRevision: number;
  adoBase: string;
  adoAuth?: 'ntlm' | 'pat' | 'bearer' | 'none';
  adoAccount: string;
}
```

- **Confidence: high**
- 继续复用可见确认卡、checkpoint、持久化恢复和审计，不新建第二套审批系统。
- 草案不保存 PAT；只保存用于确认连接未切换的非秘密连接身份。
- 用户确认前，ADO 只有 GET，没有外部写副作用。
- **What would flip it:** 如果现有 action 草案不能安全表达参数化动作，再拆成独立草案 store；当前类型与 checkpoint 参数已足够。

### 1.3 状态修改按“目标状态幂等 + revision 并发保护 + 写后回读”执行

```text
确认
  -> GET 当前工作项
  -> 已是目标状态：完成，不 PATCH
  -> state/revision 与草案不一致：冲突失败，不 PATCH
  -> PATCH [test /rev, add System.State]
  -> GET 回读
  -> 只有目标状态可确认时完成
```

- **Confidence: high**
- Azure DevOps 官方 Work Item Update 合同支持 JSON Patch `test /rev`；用它关闭预读与写入之间的并发窗口。
- PATCH 不做自动重试。请求报错时只做一次 GET 回读；若目标状态已满足则按幂等成功处理，否则明确失败或“结果无法确认”。
- 相同确认卡重试先 GET；远端已到目标状态时不会再写一次。
- **What would flip it:** 如果目标 ADO Server 2022 实测不支持 `/rev` test，则停止该聊天写能力，不降级成盲 PATCH。

### 1.4 Business MCP 继续只读，写入仍由 RocketX Host 执行

- **Confidence: high**
- 现有 Workbench 已经通过 `adoDirect` 使用 PAT、Bearer、Windows 集成认证或无认证访问 ADO。
- 不把 PAT 暴露给 Codex，不开放通用 PATCH MCP，也不增加新的凭据配置。
- 配置/账号在草案与确认之间改变时 fail closed，要求用户重新发起动作。

### 1.5 本地待办和承诺先落盘，再完成 checkpoint

- **Confidence: high**
- `awaitLastTodoWrite()` 已经提供“刚刚那次”桌面 SQLite 写入的结果；动作分支只需在 `add` 后立即 await。
- Web/localStorage 路径仍立即完成；桌面 SQLite 失败则回滚乐观项并把动作标记为 failed。

## 2. Assumptions

- **High / code:** `directGetWorkItem` 的 REST 响应包含顶层 `rev`；需要把它映射进 `WorkItem.revision`。
- **High / official contract:** ADO Work Item Update 接受 `application/json-patch+json`，并支持 `test /rev`。
- **High / product:** 状态名由项目过程模板决定，不在 RocketX 硬编码枚举；服务器最终校验合法性。
- **High / user direction:** 聊天自然语言是入口，确认卡是唯一写入口，用户无需理解 PAT/MCP 路由。
- **Medium / runtime:** NTLM 路径已有有限网络超时；其他直连请求由现有 HTTP 层返回网络失败，不增加长轮询或后台重放。

## 3. Deviation policy

- 边界情况优先选择不写、少写和可回读；任何无法确认的 PATCH 都不得自动重发。
- 如果工作项已是目标状态，按目标幂等完成，不制造无意义 revision。
- 如果 state、revision、ADO 地址、认证方式或账号发生变化，停止执行并要求重新发起。
- 不在本批增加 ADO 评论、删除、指派、PR 投票/合并、构建或发布写能力。
- 第三个偏差或任何一个 Surprise 推翻“`/rev` 可用 / 回读可确认”前提时，停止实现并重新 kickoff。

## 4. Mechanical work

1. 给 `WorkItem` 映射 revision，并为受控状态修改增加可测试的请求/执行合同。
2. 新增 `ado-state` 草案字段、规范化、checkpoint 参数、预览、能力和 preflight。
3. 新增 `draft_ado_state` 动态工具及两条运行路径的自然语言指令。
4. 在确认卡里展示 `#编号 + 标题 + 当前状态 -> 目标状态`，确认后由 Host 执行。
5. 待办/承诺分支 await `awaitLastTodoWrite()`。
6. 更新工具标签、动态工具白名单、回归与实现说明。

## 5. Verification

1. “把 #123 改成已解决”只生成状态修改确认卡；确认前 PATCH 为零。
2. 草案冻结工作项编号、当前状态、目标状态、revision 和非秘密连接身份。
3. 远端已是目标状态时零 PATCH 并完成；状态或 revision 冲突时零 PATCH 并失败。
4. PATCH body 先 `test /rev` 再修改 `System.State`，成功后必须 GET 回读。
5. PATCH 网络结果不确定时不自动重发；重试同一草案不会产生第二次有效状态写。
6. ADO 配置或账号切换后旧草案不能执行。
7. Todo/commitment 只有 SQLite 写入完成后 checkpoint 才 completed；写失败不得显示成功。
8. Web typecheck、定向回归、全量 regression 与一条 Playwright 确认卡验收通过。

## Handoff

- 实现期间维护 `docs/implementation-notes-codex-ado-state-write.md`。
- 优先新增失败测试，再改生产代码。
- Business MCP 的 GET-only 边界保持不变。
