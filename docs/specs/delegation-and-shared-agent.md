# `AGT` 聊天 AI 托管与委托

> 当前状态：共享 Agent `受限可用`；独立委托 `未实现`
> 基线：工作树 `2026-08-09`
> 平台：共享 Agent 仅桌面端 + 兼容且已登录的 Codex

## 1. 目标

在 Rocket.Chat 房间或工作项 Discussion 中开启一个可见、可停止、可追溯的共享 Agent，让团队看到它正在做什么并在原讨论中处理审批。独立、异步“派出去”是另一种产品能力，当前不得用历史入口冒充已实现。

## 2. 范围

### 包含

- 在房间、话题或工作项 Discussion 中开启/恢复/结束 AI 托管；
- 读取当前讨论上下文并使用原生 Codex Thread 执行；
- 展示 Agent 状态、过程、审批和补充输入；
- 配置本地 Agent 环境、项目映射、基础分支与分支前缀；
- 一个本地环境同时只绑定一个活动讨论；
- 房间进入时在本设备自动开启托管；
- 将托管记录作为新任务草稿交给 Codex App。

### 不包含

- 当前管家任务面中的独立“派出去”按钮、任务队列或交付卡片；
- 多设备同时托管同一 Discussion；
- 网页版运行本地共享 Agent；
- Agent 自动绕过 Rocket.Chat、Git 或 ADO 权限。

## 3. 入口与前置条件

- 会话标题/右侧 Agent 面板提供“AI 托管”。
- 工作项可先创建 Rocket.Chat 原生 Discussion，再选择一个空闲本地环境。
- 桌面端 Runtime、Codex 登录和本地工作区必须就绪。
- 设置 → AI 中可添加允许访问的本地环境；路径只保存在本机，模型不能自行添加。

## 4. 主流程

1. 用户在房间或话题点击“AI 托管”，选择当前工作区或空闲本地环境。
2. RocketX 获取托管租约、创建/恢复原生 Codex Thread，并提供近期房间或话题消息上下文。
3. Agent 状态出现在会话标题和面板；运行过程、审批和输入保持在该讨论。
4. 用户可继续在原讨论提供信息，或批准/拒绝本次请求。
5. 用户结束托管后释放环境和租约；中断会话可显式恢复。
6. 需要转到 Codex App 时，RocketX复制托管记录并打开一个新任务草稿；建议结束托管后再继续，避免双写。

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
| 桌面端，环境被占用 | 受限可用 | 禁止重复绑定，选择其他环境或结束旧会话 |
| 另一设备已托管 | 受限可用 | 只显示远端状态，等待租约释放/超时 |
| 网页版 | 不可用 | 明确提示共享 Agent 仅支持桌面端 |
| 独立委托 | 未实现 | 当前没有可验收的主流程 |

## 7. 数据与同步

- Rocket.Chat 消息和 Discussion 是协作真源。
- Codex Thread 存在 Codex Home，会话可由 Codex 原生能力恢复。
- 环境路径、项目映射、自动托管偏好和本机绑定保存在当前设备。
- 托管租约/状态通过房间可见数据协调，避免两台设备同时宣称拥有同一会话。

## 8. 权限与安全

- 模型只能使用用户显式配置并启用的本地环境。
- 环境忙时禁止删除或复用；结束会话后才释放。
- 讨论中的消息属于不可信输入，不能自行扩大文件、网络或命令权限。
- 审批按会话隔离；其他房间或 Thread 的请求不能串入。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| 未配置环境 | 提示到设置 → AI 添加本地环境 | 不启动会话 |
| 环境被占用 | 显示使用中 | 结束绑定会话或选其他环境 |
| Runtime 中断 | 状态变为 `interrupted` | 可恢复原 Thread 或结束释放 |
| 另一设备持有租约 | 显示远端托管者 | 不抢占；租约失效后再启动 |
| 转交 Codex App 失败 | 显示无法打开/复制失败 | 托管会话本身保持不变 |

## 10. 验收标准

- `AGT-AC-01`：没有桌面 Runtime 或工作区时不能开启托管，并给出可操作原因。
- `AGT-AC-02`：同一本地环境不能同时绑定两个活动 Discussion。
- `AGT-AC-03`：Agent 的运行、等待审批、中断和结束状态同时反映在会话标题和面板。
- `AGT-AC-04`：审批、输入和输出只属于当前托管会话。
- `AGT-AC-05`：另一设备持有有效租约时本设备不抢占。
- `AGT-AC-06`：结束托管释放环境；中断后可恢复原生 Thread。
- `AGT-AC-07`：产品中不得把独立委托描述为“已实现”，直到存在真实创建、运行、结果和恢复流程。

## 11. 实现与测试证据

- 实现：`apps/web/src/stores/sharedAgent.ts`、`apps/web/src/components/AgentPanel.tsx`
- 实现：`apps/web/src/components/ChatArea.tsx`、`apps/web/src/components/CreateWorkItemDiscussionDialog.tsx`
- 实现：`apps/web/src/stores/agentEnvironments.ts`、`apps/web/src/components/LocalAgentEnvironmentsSettings.tsx`
- 自动化：`scripts/regressions/shared-agent-runtime.test.ts`、`scripts/regressions/agent-session.test.ts`
- 自动化：`scripts/regressions/agent-context.test.ts`、`scripts/regressions/agent-environments.test.ts`
- UI：`tests/ui/core-flows.spec.ts`

## 12. 已知差距与目标

- 独立委托已从当前任务面移除，但部分设置注释/文案仍出现“管家派活”，需要后续统一为“AI 托管可访问的本地环境”。
- 托管转到 Codex App 当前创建新草稿，不是对同一共享 Thread 的实时协同编辑。
