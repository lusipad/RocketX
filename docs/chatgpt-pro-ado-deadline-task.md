# ChatGPT Pro 工程任务：ADO 受控直连 15 秒总 deadline

- 对话：<https://chatgpt.com/c/6a6d1045-bfa4-83ea-9c48-2a76bd0d66bc>
- 源码包：`rocketx-ado-state-review-3ab265f-20260731.zip`（ChatGPT UI 显示为同名 `(1)`）
- 文件数：52
- 字节数：348192
- SHA-256：`2556df7e2b1500b7a42f1a59f6ad98cd0a45932b77967f4732a8203a756beb95`
- 基线 commit：`3ab265f5356a37b39750f47c71d43122e5967c44`

## 背景与目标

为 RocketX 的 Azure DevOps 受控直连 GET/PATCH 实现可证明的 15 秒总 deadline，重点修复：

- PAT/browser `httpFetch` 未传 `AbortSignal`；
- WinHTTP 的 resolve/connect/send/receive 是逐阶段上限；
- NTLM 401 challenge 会重复 send/receive；
- body read 可多次阻塞；
- TypeScript `Promise.race` 只能停止 UI 等待，不能取消 Rust `spawn_blocking`，可能留下迟到 PATCH。

本任务必须提供真实代码补丁和测试，不接受仅给设计方案。

## 不可破坏边界

- 不新增 Router/Runtime，不改 Rocket.Chat Server。
- 不把 PAT/token/cookie 暴露给模型、日志、草案或 checkpoint。
- Business MCP 继续 GET-only，不开放 arbitrary URL/PATCH。
- JSON Patch 仍严格 `test /rev` 后 `add /fields/System.State`；PATCH 不自动重试。
- 写后只做一次 GET 回读；无法确认时返回 unknown/失败，不伪报成功。
- 不改变 Workbench 旧拖拽两参更新合同。
- 不新增依赖、不改锁文件、不连接真实 ADO、不提交/推送/部署。

## 修改范围与要求

1. 追踪 `adoRequest` / `ntlmRequest` / `httpFetch` / `directGetIdentity` / `directGetWorkItem` / `directSetWorkItemStateControlled` 到 Tauri `win_auth_request` 的完整调用链。
2. 普通 fetch/plugin-http 必须传真实 `AbortSignal`；不得只 race Promise。
3. Tauri NTLM 命令必须接收明确 timeout/deadline，并在 Rust blocking 函数内部使用单一 `Instant` deadline。DNS/connect/send/receive、401 challenge 重发、query/read body 都只能消费同一个剩余时间；阶段 timeout 必须 clamp 到 remaining。
4. Tauri invoke 不能早于原生请求真实结束或取消而返回超时。
5. 单次公开直连读取必须在 15,000ms 内结束。受控确认的 `GET → PATCH → GET` 必须共享一个 15,000ms 总预算；预读耗尽安全预算时在 PATCH 前失败且 PATCH 为零。
6. 明确区分 deadline before PATCH、PATCH timeout/abort、readback timeout；timeout 后未确认的写不得报成功。
7. 保持函数默认兼容，只引入共享 deadline 所需的最小参数/类型。

## 测试

- 更新 `scripts/regressions/ado-write-actions.test.ts` 或增加最小消费者级纯回归，证明：
  - `AbortSignal` 被传递；
  - 15 秒预算共享；
  - 预读耗尽时 PATCH 为零；
  - PATCH 只发一次；
  - timeout 后只回读一次且不声明成功。
- 为 `apps/desktop/src-tauri/src/winauth.rs` 增加纯 Rust 单元测试，覆盖 remaining budget/clamp、NTLM 两轮不重置 deadline、deadline exhausted 的稳定错误分类；不得发真实网络。
- 必须评估并尽可能运行：Web typecheck、ADO 定向回归、全量 regression、Web build、desktop Cargo tests。不能运行时必须明确记录未执行。

## 交付物

- `ADO_DEADLINE_REVIEW.md`：调用链、设计取舍、修改文件、错误分类、命令结果和未验证风险。
- `rocketx-ado-deadline.patch`：基于附件快照的 git-style unified diff，包含生产代码和测试，无锁文件/生成物/无关格式化。
- 最终回复列文件名、字节数和 SHA-256。

## 验收标准

- Host 在 15 秒边界内给出明确结果；
- 原生 PATCH 不会在 Host 已返回“超时”后仍由本地后台继续执行；
- 确认前零 PATCH，预读耗尽预算零 PATCH；
- PATCH 不重试，只做一次有界回读；
- unknown 不报成功；
- PAT 与 NTLM 都有可执行测试证据；
- 无新依赖、无秘密泄漏、无范围外改动。
