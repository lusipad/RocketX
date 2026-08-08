# Codex 真实生命周期验收计划

## 1. 目标与当前缺口

RocketX 以 Codex App Server 作为唯一 Agent runtime。当前生产客户端、持久 thread、Goal、
显式 resume 和 Butler 的保守 paused 投影都已有实现与回归，但真实进程门禁只验证了
ephemeral thread 的单轮完成；尚未证明 app-server 非预期退出后，新进程能恢复同一持久
thread 与 Goal，也没有证明恢复过程不会自动重放旧 turn。

本切片只补这个交付证据，不实现第二套 runtime、自动重试器或新的任务状态机。

## 2. Premise challenge

| 前提 | 结论 | 证据 / 待证事实 |
| --- | --- | --- |
| Codex App Server 是唯一 Agent runtime | confirmed | `docs/blueprint.md`、`docs/agent-runtime-reliability-design.md` |
| 当前真实 smoke 覆盖跨进程恢复 | false | `scripts/smoke-codex-app-server.mjs` 只启动 ephemeral thread 并完成一次 turn |
| 当前 Butler 状态回归等于真实 app-server 崩溃验收 | false | 状态回归使用可控 client/transport，只证明 RocketX 投影语义 |
| 固定 Codex `0.144.4` 能在本机跨进程恢复同一 thread/Goal | unverified | 本切片的真实 acceptance harness 决定 |
| 可在不访问 Rocket.Chat/ADO、不写工作区的前提下制造中断 | confirmed | 使用临时空工作区、read-only sandbox、禁止工具，并直接终止测试拥有的 app-server 子进程 |

## 3. 最可能需要调整的决策

### 决策 A：新增独立 lifecycle acceptance，而不是膨胀现有单轮 smoke

单轮 smoke 保持启动握手和最小模型可用性职责；跨进程测试包含真实 turn、异常退出、第二进程
resume、Goal 读取和清理，使用独立脚本与 package script，失败报告也更容易定位。

**Confidence：high**

**What would flip it：** 若审查证明现有 shell contract 已有完全相同的进程重启阶段，则复用该阶段，
不增加平行入口。

### 决策 B：只给 Node 验收 transport 增加显式“非预期终止”能力

`stop()` 是预期停止，会抑制 `onExit`；验收需要终止脚本自己创建的 app-server 子进程并让
`AppServerClient.onInterrupted` 收到真实退出。该能力只属于 `scripts/lib`，不扩大 Web/Tauri
生产权限面，也不允许按任意 PID 杀进程。

**Confidence：high**

**What would flip it：** 若无需改 transport 就能通过关闭其 stdio 可靠触发同一退出合同，则选择
代码更少、跨平台更稳定的实现。

### 决策 C：在 `turn/started` 后立即中断，恢复后只做一次显式 continuation

第一进程创建 persistent thread、设置 Goal、启动 read-only/no-tools turn；收到同一 thread 的
`turn/started` 后立即非优雅终止。第二进程必须：

1. `thread/resume` 返回同一 thread ID；
2. `thread/goal/get` 返回同一 Goal；
3. 在任何新的 `turn/start` 前先读 thread，并证明 harness 没有自动重放；
4. 仅由测试代码显式发起一个 continuation turn，并得到唯一终态；
5. 归档 thread、停止进程、清理临时工作区。

**Confidence：medium**

**What would flip it：** 若协议在 `turn/started` 前已返回足够权威的 active turn 状态，或短 turn
存在完成竞态，则改用一个可控的本地审批/动态工具等待点；仍不得依赖外部副作用。

### 决策 D：固定 runtime 是发布门禁，system runtime 只做可选兼容诊断

默认验收仓库锁定的 `@openai/codex@0.144.4`；`--runtime system` 可复用脚本，但不把用户机器
当前版本混入默认 build gate。每个 runtime 独立输出版本、thread ID、阶段和 PASS/FAIL。

**Confidence：high**

## 4. Keep / adapt / drop

- **Keep**：Codex 原生 persistent thread、Goal、`thread/resume`、RocketX 生产
  `AppServerClient`、read-only sandbox、用户显式 continuation。
- **Adapt**：把 Town/OpenWorker 的 durable run 恢复语义落成 RocketX 的真实协议验收，不复制其
  Agent Loop 或持久化实现。
- **Drop**：异常退出后的自动 `turn/start`、对不确定 turn 的透明重放、第二套 router/sandbox、
  真实 Rocket.Chat/ADO 写入。

## 5. 假设

| 假设 | 置信度 |
| --- | --- |
| 本机 Codex CLI 已有可用认证，可完成一个无工具 turn | medium；必须由实测确认 |
| persistent thread 存在 Codex 自己的 home 中，临时 workspace 删除前可由第二进程恢复 | high |
| `thread/archive` 足以避免验收线程污染正常列表 | high |
| kill 后旧 turn 的最终服务端状态可能因时序不同而变化，验收不应硬编码一个未经协议保证的状态词 | high |

## 6. 偏离策略

- 边界不确定时选择：临时工作区、read-only、network disabled、禁止工具、保留诊断、无自动重放。
- 可以直接调整通知等待、超时和清理等测试机械细节，但必须记录在 implementation notes。
- 出现以下任一情况时停止补丁并重新评估：需要扩大 sandbox/网络权限；需要访问真实业务系统；
  需要删除非验收线程；协议无法区分同一 thread；三次以上实质偏离。

## 7. 实施阶段与可观察验收

1. **RED：验收合同测试**
   - 现有 transport 无法制造会触发 `onInterrupted` 的非预期退出；新增测试先锁定该差异。
   - lifecycle harness 在缺少 crash 能力或恢复断言时失败。
2. **GREEN：最小 harness**
   - 仅修改 `scripts/lib/codex-app-server-spike.ts`、新增 lifecycle 脚本和 package 入口；如无需
     生产代码改动，则不触碰 Web store/UI。
3. **独立审查**
   - ChatGPT Pro 审查源码包与候选补丁；对 blocker 反馈证据并最小修正。
4. **门禁**
   - 定向 transport 回归；
   - `pnpm smoke:codex-lifecycle`；
   - `pnpm codex:protocol:check`；
   - `pnpm typecheck`；
   - `pnpm test:pure`；
   - `pnpm test:regression`；
   - `pnpm build`；
   - `git diff --check`。

验收输出必须包含 runtime source/version、第一/第二进程 ID、同一 thread ID、Goal 恢复结果、
中断事件、显式 continuation 次数、旧 turn 与新 turn 数量、清理结果。任何断言失败都以非零
退出码结束。

## 8. 明确不能声称

- 不能把该脚本声称为完整 RocketX 桌面进程重启、UI 或 IndexedDB 连续性验证。
- 不能声称所有 Codex 版本兼容；默认只证明实际运行的固定版本。
- 不能把模型输出文本本身当作唯一生命周期证据。
- 不能声称真实 Rocket.Chat、ADO 或外部写操作经过验证。
- 不能用该门禁掩盖已知的 session/routine/memory 损坏覆写风险；那是下一独立切片。

## 9. Handoff

实现过程记录在 `docs/implementation-notes-codex-real-lifecycle-acceptance.md`。每次偏离、竞态、
运行时版本或未验证边界必须即时记录，不得事后补写成过程证据。

