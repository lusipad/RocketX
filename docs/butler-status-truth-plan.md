# Butler 状态真相闭环计划

> 文档状态：**已废弃的历史计划**。旧 `ButlerErrandStatus` 和 Errand 投影不再是当前状态模型；共享 Agent 与独立委托现状见[聊天 AI 托管与委托](specs/delegation-and-shared-agent.md)。

## 1. 最可能需要调整的决策

### 决策 A：不新增第二套运行时状态机

沿用现有 `ButlerErrandStatus`：

```ts
type ButlerErrandStatus =
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'replied'
  | 'failed';
```

- `paused` 表示线程仍可恢复、但 RocketX 当前不能安全宣称仍在运行。
- “离线”与“结果未知”写入 `error` 和 warning trace，提供用户可读原因与下一步，不伪造成新的可执行状态。
- `failed` 只用于已知终态失败，或尚未取得可恢复 `threadId` 的启动失败。

**Confidence：high**

**What would flip it：** 如果后续出现必须按 `offline` / `unknown` 做不同持久化、自动化或统计行为的真实消费者，再提升为独立结构化 reason；仅为展示文案不扩 enum。

### 决策 B：`turn/completed` 后无法读取 Goal 时必须离开 `running`

当前 `thread/goal/get` 失败后直接 return，会留下“没有 active turn、也没有后续通知，却永久显示 running”的假状态。修复语义：

```text
turn/completed
  -> thread/goal/get 失败
  -> status = paused
  -> 明确“结果暂时无法确认，未自动重放”
  -> 停止本地 client，丢弃本地 runtime
  -> 用户显式继续时 thread/resume + 重新读取真实状态
```

**Confidence：high**

**What would flip it：** 只有 app-server 协议能证明失败后必定还会送达一个权威 Goal 终态通知，才允许继续保持 running；当前代码和测试没有这项保证。

### 决策 C：意外 app-server 中断按是否已有 threadId 分流

```text
已有 threadId  -> paused，保留线程与工作区，显式恢复
没有 threadId  -> failed，不能声称可恢复
```

不自动重启、不自动 `turn/start`，避免重复外部副作用。

**Confidence：high**

**What would flip it：** 若真实 Codex 协议提供具备幂等证明的透明 reconnect，可单独设计自动重连；本切片没有该证明。

### 决策 D：复用现有 UI 投影

当前 dirty worktree 已经把 `paused` errand 投影为 `needs-user`，并提供“继续”动作；本切片不重复改状态类型和任务分组，只补真实 runtime 进入该状态的路径及端到端证据。

**Confidence：high**

**What would flip it：** 如果 UI 不能显示具体未知/中断原因或恢复动作，才增加最小展示字段，不建立全局状态中心。

## 2. 假设

| 假设 | 置信度 | 来源 |
| --- | --- | --- |
| `threadId` 对已启动 errand 是持久且可 `thread/resume` 的 | high | `butlerErrandRuns.ts` 的恢复实现与现有回归 |
| `client.stop()` 只停止本地连接，不会重放或删除 Codex thread | high | `AppServerClient` 与现有 stop/resume 流程 |
| `turn/completed` 后 `thread/goal/get` 可能超时、断线或失败 | high | 网络/进程边界及当前 catch 分支 |
| 当前 `paused -> needs-user` 是本工作树的真实目标状态 | high | `butlerWorkspace.ts` 与 `butler-workspace.test.ts` |
| 真实 Rocket.Chat、真实 Codex 进程和 IndexedDB 仍未在本切片联机验证 | high | 当前验收边界 |

## 3. 偏离策略

- 遇到未知边界时选择可逆、最小爆炸半径、最接近“不重复副作用”的方案：保持或落到 `paused`，记录原因，要求显式恢复。
- 只有 destructive migration、新的安全权限面、自动重放外部动作，或发现 `threadId` 实际不可恢复时才停止并重新决策。
- 第三个实质偏离或任一前提被证伪时，停止继续打补丁并重新执行 kickoff。

## 4. 机械工作（低审阅价值）

1. 先补 runtime 回归：Goal 读取失败、app-server 意外退出、显式恢复无重放。
2. 最小修改 `settleCompletedTurn()` 与 `onInterrupted()`，复用现有 `paused` 持久化与 UI。
3. 补一条真实 UI 用例，验证未知/中断原因可见且“继续”只触发一次。
4. 记录实现中的决策、偏离与意外。
5. 交给 ChatGPT Pro 做 blocker 级审查，再跑仓库门禁。

## 5. 验证

- Goal 状态读取失败后，任务不再显示 running；必须为 paused、无 activity、有明确“暂时无法确认”及手动继续提示。
- app-server 意外退出且已有 threadId 时，任务为 paused；threadId/workspace 保留，审批清空，错误可诊断。
- 尚未取得 threadId 的启动中断不能伪装可恢复。
- 两种暂停都不得自动 `turn/start`；用户显式继续后只恢复同一 thread，并按真实状态决定下一步。
- workspace 投影落入“需要我”，任务卡显示原因与继续动作。
- 定向 regression、相关 Playwright、typecheck、pure、全 regression、协议检查、生产 build 与 `git diff --check` 全部通过。

## Handoff

实现过程使用 `docs/implementation-notes-butler-status-truth.md`，实时记录 Decisions、Deviations、Surprises 和 Questions for review；不得把事后总结冒充过程记录。
