# ChatGPT Pro 工程任务：Codex App Server 真实中断与跨进程恢复验收

## 背景和目标

RocketX 是一个基于 Codex App Server、深度集成 Rocket.Chat 与 Azure DevOps 的文字个人助理。
Codex 负责 thread、turn、Goal、模型循环、审批和 sandbox；RocketX 负责业务呈现、持久任务投影、
显式恢复与外部副作用闸门。

当前仓库已修复 Butler 的状态真相：Goal 读取失败或已有持久 thread 的 app-server 中断都会进入
可恢复 paused，不会永久 running，也不会自动重放。但这些状态回归使用可控 transport；当前真实
app-server smoke 只验证 ephemeral thread 的一次 turn。我们需要一个可重复、可诊断、无业务副作用
的真实验收门禁，证明仓库固定 Codex 进程被非优雅终止后，新 app-server 进程能恢复同一 persistent
thread 与 Goal，并且旧 turn 不会被 RocketX 自动重放。

源码基线：`main` / `3ab265f5356a37b39750f47c71d43122e5967c44`。附件包含未提交工作树中的
当前真实代码；必须以附件为准，不得用 HEAD 或旧报告覆盖当前事实。

## 当前架构与不可破坏边界

- Codex App Server 是唯一 Agent runtime；禁止新增第二套 router、sandbox、Agent Loop 或自动重试器。
- 必须复用生产 `AppServerClient` 以及现有 Node app-server transport/test utilities。
- persistent thread 与 Goal 是 Codex 原生真相；RocketX 不复制其内部状态。
- 非预期退出后的 continuation 必须由测试显式发起且至多一次；禁止透明重放不确定的旧 turn。
- 只允许终止验收脚本自己创建的 app-server 子进程；禁止按外部 PID 或进程名杀进程。
- 使用临时空工作区、read-only sandbox、network disabled、禁止工具；不得触及真实 Rocket.Chat、
  ADO、用户仓库或用户数据。
- 不新增依赖，不改 lockfile，不改协议生成物，不做相邻重构。
- 保留 dirty worktree 的所有现有改动。

## 重点研究范围

- `scripts/lib/codex-app-server-spike.ts`
  - `NodeCodexTransport.start/write/stop`
  - expected stop 与 unexpected exit 的区别
  - Windows 与 Unix 的非优雅子进程终止语义
- `apps/web/src/agent/protocol/client.ts`
  - `AppServerClient.start/request/stop/interrupt`
  - pending request 拒绝、`onInterrupted`、重复退出事件
- `scripts/smoke-codex-app-server.mjs`
- `scripts/spike-codex-shell-contract.ts`
- `scripts/regressions/codex-app-server-client.test.ts`
- `scripts/regressions/codex-spike-runtime.test.ts`
- `apps/web/src/agent/protocol/generated/v2` 中 thread/turn/Goal 合同
- `package.json` 的现有门禁入口
- `docs/codex-real-lifecycle-acceptance-plan.md`

## 必须回答的工程问题

1. 最小、跨平台且不会误杀外部进程的 unexpected termination API 应是什么？它应如何与 `stop()`
   区分，并确保 `AppServerClient.onInterrupted` 恰好收到一次？
2. 在真实模型 turn 可能很快完成的情况下，哪个协议通知/等待点最适合确定性地制造 mid-turn crash？
   若 `turn/started` 存在竞态，是否需要可控 approval/dynamic-tool checkpoint？
3. 第二进程应通过哪些协议事实证明恢复的是同一 thread、同一 Goal，且没有自动重放？
4. 如何检查旧 turn 的状态而不硬编码上游未保证的具体枚举？显式 continuation 如何证明只启动一次？
5. thread archive、client stop、临时目录清理如何在成功与失败路径都执行，同时不吞掉主失败？
6. 哪些证据只能证明协议/进程层，不能外推为桌面 UI、IndexedDB 或真实业务系统恢复？

## 明确交付物

1. 文件/行号级根因与设计审查。
2. keep / adapt / drop 清单以及关键时序图。
3. 最小完整 unified diff 候选：优先只改 scripts/test utility/package script；只有证明确有生产缺陷时
   才修改生产客户端。
4. RED/GREEN 测试设计和可执行命令。
5. 结构化 JSON 验收输出 schema，至少含 runtime/version、两个 process ID、thread ID、Goal、
   interruption、恢复、turn 数量/ID、显式 continuation 次数、cleanup。
6. 安全、并发、超时、Windows 子进程、清理和不确定模型输出的 blocker 级审查。
7. 最终给出 `PASS` 或 `REQUEST CHANGES`，并单列未验证风险。

## 必须执行或设计的测试

- transport 单测：预期 `stop()` 不触发 interrupted；非预期终止触发一次 interrupted 并拒绝 pending。
- 真实固定 runtime：
  1. 进程 A initialize；创建 persistent thread；设置唯一 Goal；
  2. 启动 read-only/no-tools turn，在权威活动点终止进程 A；
  3. 观察真实 interrupted，且 harness 未自动调用新的 `turn/start`；
  4. 进程 B initialize；`thread/resume` 同一 ID；读取同一 Goal；读取 turns；
  5. 由 harness 显式启动且只启动一个 continuation，等待真实终态；
  6. 再次读取 thread/Goal，归档线程并清理；
  7. 任一事实不满足则非零退出。
- system runtime 作为显式可选诊断，结果独立报告，不得改变固定 runtime 的结论。
- 仓库相关 regression、协议检查、typecheck、pure、全 regression、build、`git diff --check`。

## 禁止执行或禁止声称

- 禁止 commit、push、PR、部署、数据库迁移、线上配置或真实用户数据操作。
- 禁止访问真实 Rocket.Chat/ADO，禁止工作区写入、shell 命令或网络工具调用。
- 禁止把 mock/fake transport 冒充真实 app-server 验证。
- 禁止把一次模型 marker 输出冒充 thread/Goal/turn 生命周期证据。
- 禁止声称未实际运行的测试通过。
- 禁止声称该脚本验证了完整桌面重启、Butler UI/IndexedDB 连续性或所有 Codex 版本。
- 禁止为了让测试稳定而扩大 sandbox、自动重放旧 turn 或隐藏失败。

## 验收标准

- 先有能复现缺口的 RED/合同失败，再由最小改动转 GREEN。
- 非预期退出来自脚本持有的确切 child handle；不会影响任何其他 Codex/ChatGPT 进程。
- 进程 B 恢复的 thread ID 与 Goal objective 完全一致。
- 中断到显式 continuation 之前没有新的 `turn/start`；显式 continuation 恰好一次。
- 验收不依赖真实业务副作用，且 cleanup 在成功/失败路径均可诊断。
- 输出足以区分协议事实、模型文本与测试推断；失败时给出具体阶段和错误。
- 固定 runtime 的真实门禁通过后，相关仓库门禁全部通过，且未引入依赖/lockfile/协议漂移。

请先审查并提出候选补丁，不要声称在你的环境运行了本地仓库或真实 Codex；最终是否合格由
RocketX 负责人在隔离/本地环境独立验收。

