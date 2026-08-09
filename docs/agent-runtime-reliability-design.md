# RocketX Agent Runtime 可靠性与 Codex 兼容设计

> 文档状态：**已废弃**。当前架构不再保留旧 Agent Runtime 或 AI Provider 兼容层；以[管家任务](specs/butler-tasks.md)、[Codex Runtime](specs/codex-runtime.md)和[权限与审批](specs/approvals-and-permissions.md)为准。

日期：2026-07-26  
原记录状态：实施中
参考实现：`D:\Repos\openworker`（`db93d75`，MIT）  
关联决策：`docs/blueprint.md` 决策 9 / 13、`docs/butler-single-brain.md`、`docs/codex-system-first.md`

## 0. 结论与边界

RocketX 与 OpenWorker 采用不同的运行时所有权：

- **OpenWorker 自己拥有 Agent Runtime**：模型只是可替换的推理后端；会话、工具循环、
  审批、恢复、调度、连接器和持久化都由 OpenWorker 负责。
- **RocketX 复用 Codex Agent Runtime**：Codex app-server 负责模型循环、线程、原生审批和
  沙箱；RocketX 只负责 Codex 结构上做不到或不应知道的业务职责——**时机、呈现与闸门、
  可见记忆、Rocket.Chat / ADO 业务工具和任务状态**。

因此本设计不引入第二套 Agent Loop，也不复制 OpenWorker 的 Python sidecar。借鉴目标是：

1. 后台任务能可靠地暂停、等待、恢复和去重；
2. 所有待审批、待回答和失败重试都有统一入口；
3. 系统 Codex 的旧版本、新版本和线程迁移都有明确合同；
4. 失败时保留可恢复状态，不静默降级、不重复产生副作用。

## 1. 最可能调整的决定

### 1.1 运行时所有权保持 Codex 单大脑

```text
用户 / 例行事务 / watcher / 派活
                │
                ▼
      RocketX Task Runtime
  时机 · 状态 · 来源 · 闸门 · 恢复
                │
                ▼
       Codex app-server
  thread · turn · reasoning · tools · sandbox
                │
                ▼
        RocketX typed tools
  preflight · checkpoint · approval · audit
```

RocketX 不新增：

- 多 Provider Agent Loop；
- 通用 Persona Runtime；
- Python 本地 Agent Server；
- 自建 25+ Connector / OAuth Broker；
- 管家默认文件写入或 shell 权限。

`kernel/ai` 继续服务非管家消费者，但不重新成为管家第二大脑。

- **Confidence: high**
- **What would flip it**：Codex app-server 无法提供 RocketX 必需的持久线程、动态工具、
  审批或沙箱能力，且连续两个可用版本都无法通过兼容门禁；届时才重开第二运行时评估。

### 1.2 Codex 采用“开发基线固定、运行时能力兼容”

三个版本概念必须分开：

```ts
interface CodexCompatibilityContract {
  protocolBaseline: string;       // 生成并编译协议类型的版本，当前 0.144.4
  minimumCandidate: string;       // 当前代码声明的候选下限，当前 0.140.0
  verifiedVersions: string[];     // 完整语义门禁真正跑通过的版本
  runtimeVersion: string;         // 用户机器实际运行版本
  status: 'verified' | 'untested-newer' | 'blocked';
}
```

规则：

1. `protocolBaseline` 在仓库中精确锁定；升级时重新 `generate-ts`、审查协议 diff、跑全量门禁。
2. `minimumCandidate` 不是承诺。只有该版本完整通过 thread、turn、dynamic tools、审批、
   interrupt、resume 门禁后，才能成为公开的最低支持版本。
3. 低于已验证下限：阻止启动并给出升级指引。
4. 高于最高已验证版本：允许启动但标记“未验证的新版本”；先做轻量探测，运行中遇到必需
   协议缺口则明确阻止相关入口，不静默换脑。
5. 版本号只用于路由和诊断；最终判断以能力和真实交互为准。

当前 `0.140.0` 仅视为**候选下限**。在它没有跑过完整矩阵前，不能在用户文档中声称
“RocketX 已支持 0.140.0 起的全部版本”。

- **Confidence: high**
- **What would flip it**：app-server 发布稳定协议版本并提供正式 capability negotiation；
  届时可用协议版本代替 CLI 版本矩阵。

### 1.3 兼容判断分成三层

#### 第一层：启动探测

不调用模型，启动前完成：

- 解析手动路径、PATH、标准安装路径；
- 读取 `codex --version`；
- 检查 `codex app-server --help`；
- 检查 `codex login status`；
- 根据 `--help` 选择仍存在的 CLI 参数；
- 启动 app-server 并验证 `initialize.userAgent` 与实际进程版本一致。

#### 第二层：语义认证

CI / 发布门禁对每个认证版本运行：

- `thread/start`；
- `turn/start` 与流式完成；
- `turn/interrupt`；
- `thread/resume`；
- dynamic tool 的请求、宿主响应和结果回灌；
- command / file / permission 审批请求；
- RocketX 必需的 sandbox 参数；
- 线程跨进程重启恢复。

#### 第三层：运行时降级

能力分为：

```ts
type CodexCapability =
  | 'thread.start'
  | 'thread.resume'
  | 'turn.start'
  | 'turn.interrupt'
  | 'dynamicTools'
  | 'approval'
  | 'sandbox'
  | 'thread.name'       // 可选
  | 'memoryMode';       // 可选
```

- 必需能力缺失：对应入口不可用，保留状态并显示修复指引。
- 可选能力缺失：局部降级并记录诊断，例如不再命名线程。
- 不允许因 capability 缺失而扩大文件、网络或命令权限。

- **Confidence: high**
- **What would flip it**：如果轻量探测本身需要真实模型调用，则移到显式“兼容性诊断”，
  启动路径只保留无费用探测。

### 1.4 所有后台工作统一为可持久化任务状态

```ts
type ButlerTaskStatus =
  | 'pending'
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'sleeping'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface ButlerWakeCondition {
  kind: 'timer' | 'job' | 'event';
  fireAt?: number;
  jobId?: string;
  eventKey?: string;
}

interface ButlerTaskRuntime {
  taskId: string;
  sessionId: string;
  status: ButlerTaskStatus;
  triggerReason: 'user' | 'schedule' | 'catchup' | 'watcher' | 'resume';
  codexThreadId?: string;
  createdWithCodexVersion?: string;
  lastResumedWithCodexVersion?: string;
  wake?: ButlerWakeCondition;
  pendingActionIds: string[];
  attempts: number;
  updatedAt: number;
}
```

交互管家、例行事务、watcher 和派活可以保留各自 UI，但共享这组生命周期语义。
第一阶段复用现有 Butler session registry、task state 和 tool checkpoint，不先建新数据库。

- **Confidence: medium**
- **What would flip it**：如果正在进行的 Butler 页面改造已经引入等价模型，应复用现有类型，
  不平行增加第二套状态。

### 1.5 「今日」成为统一待处理中心

```ts
type ButlerPendingActionKind =
  | 'approval'
  | 'question'
  | 'retry'
  | 'notification';

interface ButlerPendingAction {
  id: string;
  kind: ButlerPendingActionKind;
  taskId: string;
  sessionId: string;
  toolCallId?: string;
  checkpointId?: string;
  title: string;
  detail?: string;
  status: 'pending' | 'resolved' | 'expired';
  createdAt: number;
  resolvedAt?: number;
}
```

幂等键优先使用：

```text
taskId + sessionId + toolCallId
```

没有 `toolCallId` 时退化为稳定 checkpoint ID。一个动作只能被解决一次；应用重启、调度补跑、
Codex thread 重建都不能复制动作或重复执行副作用。

第一阶段只汇总 RocketX 已有的 typed checkpoint、例行事务和派活审批，不新增外部写工具。

- **Confidence: high**
- **What would flip it**：如果「今日」页面的当前改造明确禁止承载操作项，则退到管家页的
  “待处理”分区，但底层 pending-action 索引不变。

### 1.6 调度采用补跑一次、防重叠和互不阻塞

借鉴 OpenWorker 的语义，但落在 RocketX 现有 Tauri / Butler runtime 中：

1. 应用启动后，对错过的任务最多补跑一次，`triggerReason = 'catchup'`；
2. 同一个任务仍在运行、等待审批或等待输入时，不叠加第二次运行；
3. 一个任务等待用户不能阻塞其他到期任务；
4. 调度器只负责入场，副作用仍必须经过 typed tool checkpoint；
5. 每次运行记录计划时间、实际时间、触发原因和最终状态。

是否补跑必须是任务级策略，默认：

- 日报、周报：补跑一次；
- 高频轮询：不补历史次数，只执行一次当前检查；
- 一次性提醒：未过期则补跑，过期则进入待处理通知；
- 外部写操作：永不因 catch-up 自动越过审批。

- **Confidence: medium**
- **What would flip it**：若产品要求应用完全退出后仍运行，则需要独立 OS service / scheduled
  task 设计；当前只承诺 RocketX 在运行或驻留托盘时可靠调度。

### 1.7 Codex 线程恢复失败时重建，但必须显式记录

统一恢复顺序：

```text
原生 thread/resume
        │
        ├─成功──► 继续原线程
        │
        └─失败──► 保存失败原因
                    │
                    ▼
             用 RocketX transcript
             创建新的 Codex thread
                    │
                    ▼
      标记 compatibility = transcript-rebuilt
```

重建后必须说明：

- 已保留 RocketX 可见对话、任务状态、来源和 checkpoint；
- Codex 原生隐藏上下文、压缩摘要或未完成内部状态可能没有恢复；
- 任何 `running` 写 checkpoint 必须先转为可审查状态，不能直接重放。

该合同应用到管家、共享 Agent、执行间和派活，不允许各自维护不同的失败语义。

- **Confidence: high**
- **What would flip it**：Codex 提供稳定的跨版本线程导出/导入合同；届时可替代 transcript 重建。

### 1.8 会话存储先不拆，达到阈值再迁移

当前 session registry 单 blob 已有明确长度上限，第一阶段不为假想规模迁移数据。满足任一条件后，
再改为“小 registry 索引 + per-session 存储”：

- 同一 scope 经常超过 50 个真实 session；
- registry 序列化或写入出现可感知卡顿；
- durable workflow 使单 blob 接近 IndexedDB 单记录风险；
- 并发后台任务造成整 blob 写竞争。

迁移必须双读单写、可回滚，不能删除旧键直到独立回归证明完成。

- **Confidence: high**
- **What would flip it**：第一阶段实现 pending-action 索引时发现单 blob 已经发生丢写或竞争；
  那么存储拆分前置。

## 2. OpenWorker 参考语义清单

只借语义，不复制代码。OpenWorker 为 MIT，但实现仍按 RocketX 的 TypeScript / Rust 架构重写。

| OpenWorker 行为 | 计划 | 原因 |
| --- | --- | --- |
| 审批、问题和通知进入统一 Inbox | **adapt** → RocketX「今日」待处理 | 与 GTD 捕获/理清一致 |
| `(session_id, tool_call_id)` 幂等恢复 | **keep** | 防止重启后重复问题和副作用 |
| 未回答工具调用持久化后继续 Agent Loop | **adapt** → Codex resume，失败则 transcript 重建 | RocketX 不拥有 Agent Loop |
| 启动时 run-once catch-up | **keep**，改成任务级策略 | 补漏但不补历史洪峰 |
| 同任务 skip-on-overlap | **keep** | 防止重复运行 |
| 等待审批的任务不阻塞调度器 | **keep** | 后台工作必须互不阻塞 |
| timer / job / event self-wake | **adapt** → Butler wake condition | 支持“等一会儿再查” |
| 只读工具并行，写和 shell 串行 | **adapt** → 优先复用 Codex 编排 | 不再实现一层 TurnEngine |
| `tool + exact target` standing approval | **adapt，后置** | 未来外部写能力可安全复用 |
| append-only JSONL 会话 | **adapt** → IndexedDB per-session/event log | Web/Tauri 栈不需要 JSONL 主存储 |
| Python FastAPI sidecar | **drop** | 增加进程、鉴权、打包和安全面 |
| 多 Provider Agent Runtime | **drop** | 与 Codex 单大脑冲突 |
| Persona Gallery | **drop** | 与一个管家的人设原则冲突 |
| 25+ 自建 Connector / OAuth Broker | **drop** | 优先复用 Codex MCP / Apps / Skills |
| 管家默认文件和 terminal 权限 | **drop** | 继续由显式派活/执行间承接 |

## 3. Assumptions

1. Codex app-server 仍是 experimental，上游可能发生兼容变化。**Confidence: high**，
   来源：仓库蓝图与生成协议。
2. 当前协议生成基线为 `0.144.4`。**Confidence: high**，来源：
   `apps/web/src/agent/protocol/compatibility.ts` 与根依赖。
3. 当前运行时候选下限为 `0.140.0`，但完整最低版本矩阵尚未形成。**Confidence: high**，
   来源：`proc.rs`；“尚未形成”来自当前仓库缺少多版本语义门禁。
4. RocketX 只承诺应用运行或驻留托盘时执行后台工作，不承诺完全退出后运行。
   **Confidence: medium**，需要产品确认后才能扩大。
5. 当前 typed tool runtime 的 validation、preflight、checkpoint、approval、audit 是后续工作的
   基础，不重写。**Confidence: high**，来源：现有代码。
6. 正在进行的 Butler 页面改动归用户或其他任务所有，本设计不要求回退或重排这些改动。
   **Confidence: high**，来源：当前工作树。

## 4. Deviation policy

边角问题默认采用保守方案：**可逆、最小影响、保留旧数据、失败关闭权限、明确提示**。

可直接决定并记录：

- 可选 Codex 方法不存在时局部降级；
- 新版本超出已验证范围时显示警告；
- 复用已有 Butler 类型而不是新增等价类型；
- catch-up 策略不明确时选择不自动执行副作用；
- resume 不可靠时保留 transcript 并新建线程。

必须停止重新确认：

- 引入第二 Agent Runtime 或 Python sidecar；
- 扩大管家文件、网络或命令权限；
- 删除旧 session / checkpoint / transcript 数据；
- 自动批准外部写操作；
- 让 RocketX 完全退出后仍常驻为 OS service；
- 发现 app-server 连续多个可用版本都无法满足必需能力；
- 实现中出现三次以上偏离，说明计划与代码现实已经失配。

## 5. 实施阶段

### Phase 0：Codex 兼容合同收口

交付：

- 把“协议基线、候选下限、已验证版本、实际运行版本”分开建模；
- 保存并展示 runtime source、路径、版本和兼容状态；
- 建最小 / 基线 / 最新三版本门禁；
- 把 `0.140.0` 跑成真实证据，失败则提高最低版本；
- 统一新版未验证警告和必需能力失败提示；
- 每个 session 记录创建与最后恢复时的 Codex 版本。

验收：

- 过旧版本启动前被阻止；
- 基线版本全绿；
- 最新版本要么全绿，要么产生明确、可定位的兼容失败；
- 新旧版本切换后能区分原生 resume 与 transcript 重建；
- 不因版本漂移放宽 sandbox 或 approval。

### Phase 1：「今日」待处理与 durable continuation

交付：

- 汇总 typed checkpoint、workflow、例行事务和派活的待处理动作；
- 幂等解决 approval / question / retry；
- 重启后动作只出现一次；
- 审批后优先恢复原 Codex thread，失败则按统一合同重建。

验收：

- 后台任务停在审批点，重启 RocketX，今日仍显示一张卡；
- 批准一次只执行一次；
- 拒绝后任务进入明确终态；
- 一个等待审批的任务不阻塞其他任务。

### Phase 2：可靠调度与 self-wake

交付：

- 任务级 catch-up 策略；
- skip-on-overlap；
- timer / job-completion wake；
- 运行原因、计划时间、实际时间和结果审计；
- watcher event wake 仅在前两种稳定后接入。

验收：

- 错过一次日报后启动只补跑一次；
- 高频任务不补历史次数；
- 同任务长时间运行时不会叠加；
- 等待派活完成不消耗循环轮询上下文。

### Phase 3：存储与产物

触发阈值达到后才实施：

- registry 拆为索引 + per-session 持久化；
- pending action 独立索引；
- 派活结果增加产物、来源、验证和打开位置；
- 迁移保持双读、可回滚。

## 6. Mechanical work（低审阅价值，信任实现者）

1. 为新增兼容状态补齐序列化、归一化和旧值 fallback。
2. 复用当前 `CodexRuntimeProbe`，不再创建平行探测接口。
3. 将版本矩阵脚本接入现有 `codex:protocol:check` 与 app-server smoke。
4. 将 pending action 从现有 checkpoint 投影生成，第一阶段不复制业务数据。
5. 为 scheduler 和 wake store 提供可注入时钟。
6. 更新对应设计文档和用户可见错误文案。
7. 不格式化或重构当前 Butler UI 改动的相邻代码。

## 7. Verification

### 7.1 可观察行为

1. 安装旧 Codex：RocketX 在启动 Agent 前说明最低版本和升级方法。
2. 安装未认证的新 Codex：显示“未验证的新版本”，轻量探测通过后允许使用。
3. 新版本破坏必需协议：只阻止受影响入口，保留对话和 checkpoint，不出现空白失败。
4. 升级 Codex 后恢复旧管家线程：成功时标记原生恢复；失败时重建并明确提示。
5. 例行任务等待审批：重启后今日仍存在唯一待处理项。
6. 多个任务同时到期：等待审批的任务不阻塞其他只读任务。
7. catch-up：每个任务按自身策略补跑，任何外部写操作仍经过审批。

### 7.2 自动化门禁

- `pnpm codex:protocol:check`
- `pnpm smoke:codex-app-server`
- `pnpm --filter @rcx/web typecheck`
- 相关纯逻辑与 regression 测试
- `cargo test --locked`（触及 `proc.rs` / Tauri runtime 时）
- `git diff --check`

多版本 CI 必须报告每个版本的独立结果，不能把“最新版本失败”淹没在允许失败的矩阵中。

## 8. Handoff

第一实施切片固定为 **Phase 0：Codex 兼容合同收口**，之后才进入待处理中心。

开工时创建：

```text
docs/implementation-notes-agent-runtime-reliability.md
```

内容：

```markdown
# Implementation notes — Agent Runtime 可靠性与 Codex 兼容
Plan: docs/agent-runtime-reliability-design.md

## Decisions
## Deviations
## Surprises
## Questions for review
```

实施中即时记录文件/行号。边角偏差选择可逆、最小影响方案继续；第三次偏差，或任何发现推翻
“Codex 单大脑仍可满足必需能力”的前提时，停止补丁并重新评估。

Phase 0 完成前，不得：

- 宣称所有 `>=0.140.0` Codex 都已兼容；
- 删除 transcript 重建 fallback；
- 扩大管家权限；
- 开始复制 OpenWorker Agent Runtime。
