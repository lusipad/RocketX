# ChatGPT Pro 协作验收结果：Butler 状态真相闭环

## 结论

- 最终 verdict：`PASS`
- ChatGPT Pro 对话：<https://chatgpt.com/c/6a6d2a8e-e4c8-83ea-ad91-ebd4ed827f4a>
- 源码基线：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 分支：`main`
- 交付状态：仅本地 dirty worktree；未 stage、commit、push、创建 PR 或部署。

## 提交给 ChatGPT Pro 的源码包

上传前均排除 `.git`、`node_modules`、构建产物、缓存、数据库、运行/浏览器状态及凭据文件，并完成内容密钥扫描；扫描结果为 PASS。

| 包 | 文件数 | 大小 | SHA-256 |
| --- | ---: | ---: | --- |
| 初始审查包 `rocketx-butler-status-truth-3ab265f-20260801.zip` | 22 | 106,694 bytes | `75C762E45DEED010FE191D2D4C3D351594574685C71018558E622C189F48B562` |
| 候选复审包 `rocketx-butler-status-truth-candidate-v2-3ab265f-20260801.zip` | 22 | 109,410 bytes | `812A4D6EA2DCD7438DAA5E47F2CFBAC5D2E6E7555EA7F06915B65304BB658262` |

本地持久位置：

- `C:\Users\lus\Documents\RocketX-Pro-Reviews\2026-08-01-butler-status-truth\`
- `C:\Users\lus\Documents\RocketX-Pro-Reviews\2026-08-01-butler-status-truth-candidate-v2\`

## 实际修改

### Runtime 状态真相

- `turn/completed` 后读取 `thread/goal/get` 失败时，从永久 `running` 改为 `paused`。
- 保留 `threadId`、工作区和任务责任；清除 activity 与失效 approvals，记录用户可读原因与 warning trace，拒绝该任务的 approval waiters，并停止本地 client。
- 不自动 `turn/start` 或重放旧 turn；只允许用户通过现有显式 resume 链恢复同一 thread。
- app-server 意外中断时按持久线程分流：已有 `threadId` 的非终态任务进入 `paused`；尚未建立线程的启动失败不伪装为可恢复任务。
- 保留 replied/failed 终态，不让 expected stop 或迟到中断覆盖已经确定的结果。

### 回归与 UI

- 新增 Goal 状态读取失败、已有线程意外中断、无线程启动中断三条生产 store/notification 回归。
- 锁定 approvals/waiters 清理、兄弟任务隔离、持久化与重载语义。
- UI 用例从 `useButlerErrandRuns` 真实 store 经 `syncErrandsIntoButler()` 投影到任务卡，验证原因可见、无自动 resume，且用户点击只触发一次继续。

## ChatGPT Pro 反馈与修正闭环

1. Pro 确认 `paused + error` 足以承载本切片语义，无需新增 `offline` / `unknown` raw enum。
2. Pro 建议结构化 `errorCode`；独立审查发现当前没有行为消费者，未采纳这项持久模型扩张。
3. Pro 初次候选复审把 `settleCompletedTurn()` 中 runtime/client 缺失早退列为 blocker，认为迟到 `turn/completed` 可能留下永久 `running`。
4. 独立核对所有公开 action、`onInterrupted()` 和 `stopClient()` 调用方后，确认当前没有这种可达终态：意外断连同步暂停/失败；主动停止随后终态、暂停、删除或恢复。终态 stop 期间的迟到完成事件若强制改 paused，反而会把 replied/failed 降级。
5. 将完整调用链和可触发性要求反馈给 Pro 后，它撤销该 blocker 并最终回复 `PASS`。因此没有加入无法通过公开接口先写出 RED 的推测性分支。
6. 本地测试审查另外发现 UI 首稿直接注入展示 store、且中断回归缺少持久化断言；两项均已修正并复审通过。

## 独立验证

### TDD 证据

- RED：Goal 读取失败实际为 `running`，已有线程的 app-server 中断实际为 `failed`；定向命令 0/2 通过。
- GREEN：三条状态回归 3/3 通过。

### 最终门禁

| 验证 | 结果 |
| --- | --- |
| `pnpm exec tsx --test scripts/regressions/butler-errands.test.ts` | PASS，34/34 |
| `pnpm exec playwright test tests/ui/butler-interactions.spec.ts` | PASS，42/42 |
| 结果不确定 UI 定向用例 | PASS，1/1 |
| paused 到 `needs-user` 投影定向回归 | PASS，1/1 |
| `pnpm typecheck` | PASS，7/8 workspace projects 有 typecheck task |
| `pnpm test:pure` | PASS，230/230 |
| `pnpm test:regression` | PASS，936/936 |
| `pnpm codex:protocol:check` | PASS，671 个协议文件与 codex-cli `0.144.4` 一致 |
| `pnpm build` | PASS，7/8 workspace projects 有 build task；仅有既存 Vite chunk/import warnings |
| `git diff --check` | PASS；仅输出 Windows LF/CRLF 提示，无 whitespace error |

仓库根 `package.json` 没有 lint script，因此没有声称执行 lint。

## 仍未验证的风险

- 没有连接真实 Rocket.Chat、Azure DevOps 或真实 Codex app-server 进程；当前 transport、进程退出和 UI 证据分别来自 fake client、生产 store 回调与本地 Playwright。
- 没有执行真实进程 kill、网络断开或桌面重启后的端到端恢复；持久化重载由回归测试验证，不等同于生产联机验证。
- 当前工作树包含本切片之前的大量未提交改动；本次只做了目标文件的外科式修改，未清理或覆盖其他修改。
