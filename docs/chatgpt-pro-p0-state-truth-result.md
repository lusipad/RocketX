# ChatGPT Pro P0 状态可信闭环验收结果

## 结论

- 本地独立复审：`PASS`
- ChatGPT Pro 候选 v2 复审：`PASS`
- 本切片已解决共享 Agent 恢复失败后永久停在 `starting` 的 P0 问题，并修正“Codex 已恢复成功，却被 Rocket.Chat 状态卡同步失败反杀”的事务边界。
- 本结果只代表本地候选通过；没有提交、推送、创建 PR 或部署。

## 基线与外部审查

- 分支：`main`
- 基线提交：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 工作树：审查开始前已存在大量未提交改动；本轮未覆盖或清理无关改动。
- ChatGPT Pro 对话：<https://chatgpt.com/c/6a6d22f5-c2dc-83ea-b6d3-875ed2e1d6e6>

### 交付给 Pro 的源码包

| 阶段 | 文件 | 大小 | SHA-256 | 结果 |
| --- | --- | ---: | --- | --- |
| 初始审阅包 | `C:\Users\lus\Documents\RocketX-Pro-Reviews\2026-08-01-p0-state-truth\rocketx-p0-state-truth-3ab265f-20260801.zip` | 496,462 bytes | `E5823811ABC820479231C9F1E6AEAD5CFE8FE05869B9401BAE1EC43C3B692DBC` | 根因确认 |
| 候选 v1 | `C:\Users\lus\Documents\RocketX-Pro-Reviews\2026-08-01-p0-state-truth-candidate-v1\rocketx-p0-state-truth-candidate-v1-3ab265f-20260801.zip` | 46,732 bytes | `2E0C5C11FD1CDCC8F165562AC5FB28C4E9E9A9AB6293317939403282D252DD7E` | `REQUEST CHANGES` |
| 候选 v2 | `C:\Users\lus\Documents\RocketX-Pro-Reviews\2026-08-01-p0-state-truth-candidate-v2\rocketx-p0-state-truth-candidate-v2-3ab265f-20260801.zip` | 47,801 bytes | `2082CF94C4690554FFF66C1536CB725D20ED85E393F8E70E36A77DCDDD8FB072` | `PASS` |

三个包均在上传前做了高置信凭据扫描；v2 精确包含 10 个文件，不含 `.env`、Cookie、Token、私钥、数据库、构建产物或浏览器状态。

## 实际修复

1. `resumeSession()` 在 `ensureClient()`、`thread/resume` 明确错误、真实 15 秒 timeout 或 app-server 退出时，统一从 `starting` 收敛到 `interrupted`。
2. 失败时保留 `codexThreadId`、`workspaceRoots` 和租约，清除 stale `activeTurnId`，只清理目标会话的 approvals/waiters。
3. 错误写入 session 级 `lastError`，`AgentPanel` 不再把 A 会话错误展示到 B 会话。
4. 恢复按钮有 pending、异常提示和显式重试；成功恢复只执行 `thread/resume`，不会自动重放旧 `turn/start`。
5. `thread/resume` 已成功并持久化为 `ready` 后，`updateLeaseCard()` 失败只写脱敏 warning，不再停止 client、回滚为 `interrupted` 或让恢复调用失败。
6. session 持久化改为延迟读取原有 `kernelStore.appData`，并提供可还原的内存后端测试缝；生产 IndexedDB 路径不变。
7. client factory 测试缝保留原有桌面端检查、`AppServerClient.start()` 和默认生产行为。

## TDD 与纠错记录

- 初始 store 回归暴露 eager `kernelStore` 在 Node 中依赖 IndexedDB，随后用可还原的 AppData 注入边界解耦测试环境。
- 在实现 client factory 前，回归以 `setSharedAgentClientFactory is not a function` 失败，证明恢复生产路径尚不可测。
- 候选 v1 虽通过最初目标测试，但本地 reviewer 指出 timeout 只是伪造错误字符串、且缺少 `ensureClient()` 失败覆盖。
- ChatGPT Pro 在 v1 发现 blocker：`updateLeaseCard()` 仍位于恢复主事务内，会把已经成功的 runtime 错误打回 `interrupted`。
- 对旧事务边界运行状态卡用例，真实 RED 为 `Error: rocket.chat updateMessage failed`，调用栈为 `updateLeaseCard -> resumeSession`。
- v2 使用真实 `AppServerClient.request()` 与永不回复 `thread/resume` 的 fake transport，只缩短实际收到的默认 `15000ms` 计时；不再伪造 timeout 文案。
- 本地复审最后发现 `setAgentSessionAppData()` override 未逐测试还原；补 `test.afterEach()` cleanup 后最终给出 `PASS`。

## 独立验证

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsx --test scripts/regressions/shared-agent-runtime.test.ts` | 6/6 通过 |
| `pnpm exec tsx --test scripts/regressions/agent-session.test.ts scripts/regressions/codex-app-server-client.test.ts scripts/regressions/local-codex-entry.test.ts scripts/regressions/shared-agent-runtime.test.ts` | 29/29 通过 |
| `pnpm exec playwright test tests/ui/core-flows.spec.ts -g "共享 Agent 恢复失败会回到可重试状态，成功重试不重放旧 turn"` | 1/1 通过 |
| `pnpm --filter @rcx/web typecheck` | 通过 |
| `pnpm test:regression` | 933/933 通过 |
| `pnpm test:pure` | 230/230 通过 |
| `pnpm codex:protocol:check` | 通过；与 `codex-cli 0.144.4` 的 671 个生成文件一致 |
| `pnpm build` | 通过；保留既有 Vite 动静态 import 分块 warning |
| `git diff --check` | 通过；仅有现有 Windows CRLF 提示 |

ChatGPT Pro 没有把这些本地命令声称为自己运行；其 v2 结论来自对上传源码的独立 blocker 级审查。

## 修改范围

- `apps/web/src/agent/session.ts`
- `apps/web/src/agent/sessionStore.ts`
- `apps/web/src/components/AgentPanel.tsx`
- `apps/web/src/stores/sharedAgent.ts`
- `scripts/regressions/shared-agent-runtime.test.ts`
- `tests/ui/core-flows.spec.ts`
- `docs/chatgpt-pro-p0-state-truth-task.md`
- `docs/chatgpt-pro-p0-state-truth-result.md`

## 未验证边界

- 没有连接真实 Codex App Server 验证进程强杀、管道关闭与恢复。
- 没有连接真实 Rocket.Chat 验证 WebSocket 重连、REST 失败恢复或认证过期。
- 没有做真实浏览器 IndexedDB reload/restore；持久化回归使用内存后端。
- 没有运行全部 Playwright E2E，只运行了本切片相关 UI 用例。
- `onInterrupted()` 在进程退出与外层 catch 同时触发时可能产生重复 trace/持久化写；现有路径幂等且按 tmid 隔离，Pro 判定为非阻断 B 级改进。
- 导出的 client factory 是测试缝，没有 UI 或用户输入入口；Pro 判定为非阻断，后续可考虑收窄到测试专用导出。
