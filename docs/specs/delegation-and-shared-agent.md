# `AGT` 聊天 AI 托管与委托

> 当前状态：共享 Agent `受限可用`；独立委托 `未实现`
> 基线：工作树 `2026-08-17`
> 平台：本地宿主仅桌面端；Web 与无 AI 客户端可查看有效远端托管并使用 `@ai`

## 1. 目标

在 Rocket.Chat 房间或工作项 Discussion 中开启一个可见、可停止、可追溯的共享 Agent，并继承当前启动级 AI 运行时。团队在原讨论中看到状态、输出和审批；不同后端保留各自原生能力，不为“可切换”制造一层虚假的统一配置。独立、异步“派出去”是另一种产品能力，当前不得用历史入口冒充已实现。

## 2. 范围

### 包含

- 在房间、话题或工作项 Discussion 中开启/恢复/结束 AI 托管；
- 读取当前讨论上下文并使用原生 Codex Thread 或 DSH Session 执行；
- 创建会话时使用当前启动级 AI 运行时，并持久化 `backend` 与该后端原生会话 ID；
- 开启时选择本次运行配置：Codex 的模型、推理和权限，或 DSH 原生目录中的模型、推理、Agent 与权限；
- 展示 Agent 状态、过程、审批和补充输入；
- Web、无 AI 或非宿主设备查看房间内有效远端托管状态，并由房间成员使用 `@ai` 向同一宿主会话提问；
- 在管家里的“托管项目”中配置本地 Agent 环境、项目映射、基础分支与分支前缀；设置页只保留 `rcx.workspace.json` 团队配置，不再提供第二个项目入口；
- 一个本地环境同时只绑定一个活动讨论；
- 房间进入时在本设备自动开启托管；
- Codex 后端可将托管记录作为新任务草稿交给 Codex App。

### 不包含

- 当前管家任务面中的独立“派出去”按钮、任务队列或交付卡片；
- 多设备同时托管同一 Discussion；
- 网页版运行本地共享 Agent；
- Agent 自动绕过 Rocket.Chat、Git 或 ADO 权限。

## 3. 入口与前置条件

- 会话标题/右侧 Agent 面板提供“AI 托管”。
- 工作项可先创建 Rocket.Chat 原生 Discussion，再选择一个空闲本地环境或托管项目。
- Codex 后端要求兼容且已登录的本地 Codex；DeepSeek 后端要求系统里已安装且可运行、且已被 RocketX 验证为 `0.1.0-rc.6` 的 DSH，或者 Windows full 私有运行时，再加已配置 DeepSeek API Key。
- 管家 → 托管项目中可添加、编辑、删除允许访问的本地环境；路径只保存在本机，模型不能自行添加。

## 4. 主流程

1. 任意能在当前房间正常发言的成员都可以在房间或话题点击“AI 托管”，使用当前启动级 AI 运行时，选择当前托管项目，并确认本次会话的模型、推理、Agent（如适用）与权限。
2. RocketX 获取托管租约，按所选后端创建/恢复原生 Codex Thread 或 DSH Session，并提供近期房间或话题消息上下文。
3. Agent 状态出现在会话标题和面板；运行过程、审批和输入保持在该讨论。
4. 用户可继续在原讨论提供信息，或批准/拒绝本次请求。
5. 用户结束托管后释放环境和租约；中断会话可显式恢复。
6. Codex 会话需要转到 Codex App 时，RocketX 复制托管记录并打开一个新任务草稿；DeepSeek 会话不显示这个 Codex 专属动作。

## 5. 状态与交互

- `starting`：正在获取租约和启动 Runtime。
- `ready/active/running`：Agent 已接管当前讨论并执行。
- `waiting-approval`：会话标题和面板显示需要人决策。
- `interrupted`：保留恢复和结束动作，不宣称完成。
- `ending/ended`：释放本机环境和远端托管标记。
- 远端其他设备正在托管时显示托管者和状态，本机不能抢占有效租约。

## 6. 平台与依赖

| 场景 | 当前状态 | 行为 |
| --- | --- | --- |
| 桌面端 + Codex + 可用环境 | 已实现 | 可开启共享 Agent |
| 桌面端 + DSH + Node + API Key | 已实现 | 可用 DSH 原生 Session 开启共享 Agent |
| 桌面端，环境被占用 | 受限可用 | 禁止重复绑定，选择其他环境或结束旧会话 |
| 另一设备已托管 | 受限可用 | 显示远端状态；房间成员仍可使用 `@ai`，本设备不抢占，等待租约释放/超时 |
| 网页版 | 受限可用 | 不能开启、恢复或承载本地执行；可查看有效远端托管状态，并由房间成员使用 `@ai` 向桌面宿主提问 |
| 独立委托 | 未实现 | 当前没有可验收的主流程 |

## 7. 数据与同步

- Rocket.Chat 消息和 Discussion 是协作真源。
- Codex Thread 存在 Codex Home；DSH Session 存在 RocketX 私有 `DSH_HOME`，两者都由各自原生能力恢复。
- 会话记录保存 `backend` 与对应的 `threadId` / `dshSessionId`；旧记录缺少 `backend` 时按 Codex 读取，活动会话不跨后端迁移。
- 会话同时保存实际运行配置快照；恢复时沿用该快照，不用管家的后续默认值改写既有会话。
- 环境路径、项目映射、自动托管偏好和本机绑定保存在当前设备。`agentEnvironments` 是用户项目真源；`codexWorkspace` 只保留系统/current/runtime 工作区和 Runtime 生命周期，不混放项目元数据。
- 托管租约/状态通过房间可见数据协调，避免两台设备同时宣称拥有同一会话。

## 8. 权限与安全

- 模型只能使用用户显式配置并启用的本地环境。
- 任何能通过 Rocket.Chat 正常向当前房间发送消息的成员都可以通过 RocketX 控件开启托管；新租约不会再为正式开启动作额外查询全局角色、房间角色或成员目录。
- 可读状态正文和历史 marker 都属于不可信房间输入；新租约只有带 RocketX 正式开启流程生成的 lease metadata 或 lease message id，且消息作者、房间/话题和短期时间窗口都匹配时，才参与跨设备宿主仲裁。普通成员手工复制相同正文不会占用托管。
- 混合版本升级期间，`v0.43.1` 形态的旧租约只在服务端仍能确认其发布者具备旧版允许的管理员、机器人或房间管理角色时临时参与仲裁；查询失败时按不可信处理，不影响 `v0.43.2` 普通成员创建新租约。
- 环境忙时禁止删除或复用；结束会话后才释放。
- 讨论中的消息属于不可信输入，不能自行扩大文件、网络或命令权限。
- 审批按会话隔离；其他房间或 Thread 的请求不能串入。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| 未配置环境 | 提示到设置 → AI 添加本地环境 | 不启动会话 |
| 环境被占用 | 显示使用中 | 结束绑定会话或选其他环境 |
| Runtime 中断 | 状态变为 `interrupted` | 可恢复原 Thread 或结束释放 |
| DSH bridge 中断 | 状态变为 `interrupted`，清理失效审批/问题 | 可恢复原 Session 或结束释放 |
| 另一设备持有租约 | 显示远端托管者 | 不抢占；租约失效后再启动 |
| 转交 Codex App 失败 | 显示无法打开/复制失败 | 托管会话本身保持不变 |

## 10. 验收标准

- `AGT-AC-01`：没有桌面 Runtime 或托管项目时不能开启托管，并给出可操作原因。
- `AGT-AC-02`：同一本地环境不能同时绑定两个活动 Discussion。
- `AGT-AC-03`：Agent 的运行、等待审批、中断和结束状态同时反映在会话标题和面板。
- `AGT-AC-04`：审批、输入和输出只属于当前托管会话。
- `AGT-AC-05`：另一设备持有有效租约时本设备不抢占。
- `AGT-AC-06`：结束托管释放环境；中断后可恢复原生 Thread。
- `AGT-AC-07`：产品中不得把独立委托描述为“已实现”，直到存在真实创建、运行、结果和恢复流程。
- `AGT-AC-08`：创建托管会话时继承全局启动级 AI 运行时并明确选择本次运行配置；运行中不切换，恢复时使用保存的原生 Thread/Session ID 与配置快照。
- `AGT-AC-09`：Codex 与 DeepSeek 面板只展示各自真实配置和动作，审批/输入/output 不跨后端或会话串入。
- `AGT-AC-10`：普通成员通过 RocketX 正式开启流程发布的有效托管租约可以进入权威远端状态；手工复制的可见正文、未经旧版角色验证的历史 marker、作者/房间/话题不匹配或超出消息时间窗口的声明必须拒绝。
- `AGT-AC-11`：Web、无 AI 和非宿主设备保留管家与共享托管信息架构；有效远端托管可见且可通过 `@ai` 使用，但本地开启、恢复与执行动作保持禁用。

## 11. 实现与测试证据

- 实现：`apps/web/src/stores/sharedAgent.ts`、`apps/web/src/components/AgentPanel.tsx`
- 实现：`apps/web/src/components/ChatArea.tsx`、`apps/web/src/components/CreateWorkItemDiscussionDialog.tsx`
- 实现：`apps/web/src/stores/agentEnvironments.ts`、`apps/web/src/components/ButlerProjectConfigDialog.tsx`
- 自动化：`scripts/regressions/shared-agent-runtime.test.ts`、`scripts/regressions/agent-session.test.ts`
- 自动化：`scripts/regressions/agent-hosting-backend.test.ts`、`hosted-dsh-controller.test.ts`
- 自动化：`scripts/regressions/agent-context.test.ts`、`scripts/regressions/agent-environments.test.ts`
- UI：`tests/ui/core-flows.spec.ts`

## 12. 已知差距与目标

- 独立委托已从当前任务面移除，但部分设置注释/文案仍出现“管家派活”，需要后续统一为“AI 托管可访问的本地环境”。
- 托管转到 Codex App 当前创建新草稿，不是对同一共享 Thread 的实时协同编辑。
- DeepSeek 托管首版按活动会话启动隔离连接；没有在缺少性能数据前预建常驻 sidecar 池。
