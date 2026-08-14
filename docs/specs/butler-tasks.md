# `BUT` 管家任务

> 当前状态：`受限可用`
> 基线：工作树 `2026-08-14`
> 平台：仅桌面端；Codex 与 DeepSeek 条件分别判断

## 1. 目标

把管家做成 RocketX 内的本地 AI 任务面：用户明确选择 Codex 或 DeepSeek 视图，再直接使用该后端的原生会话、配置和交互能力。RocketX 保留消息、工作台和个人效率等确定性界面，不自建 Agent 内核，也不增加抹平后端差异的通用 Runtime 层。

## 2. 范围

### 包含

- 在管家里的“托管项目”中新增、编辑、删除项目，并连接 Codex `app-server`；
- 创建、恢复、重命名和归档原生 Codex Thread；
- 发送文本与图片，流式展示回答、活动和工具过程；
- 选择模型、推理强度与权限档；
- 任务运行时停止、立即调整（Steer）或排队后续消息；
- 在所属任务中处理审批、普通用户输入和 MCP 结构化输入；
- 在 RocketX 与 Codex App 之间顺序接续同一线程。
- 切换到独立 DeepSeek 视图，创建、恢复和查看 DSH 原生 Session；
- 读取并选择 DSH 提供的模型/提供方、推理强度、Agent preset 与 permission preset；
- 在所属 DSH Session 中处理原生 approval 与 question，并通过 DSH credentials 写入或清除 DeepSeek API Key。

### 不包含

- RocketX 自建模型对话协议、技能路由器或影子会话库；
- 把 Codex 的 Skills/Plugins/Apps/Memory 映射成 DSH 能力，或把 DSH 配置映射成 Codex Profile；
- 在 RocketX 中编辑 DSH provider endpoint、创建 Agent preset，或重做 DSH 管理台；
- 网页版直接启动本机 Codex 或 DSH；
- RocketX 与 Codex App 同时向同一 Thread 写入；
- 把工作台确定性表格改造成 AI 生成列表。

## 3. 入口与前置条件

- 顶部/左侧 RocketX 导航中的“管家”进入任务面；RocketX 全局导航不能因进入管家而消失。
- Codex 视图要求先配置真实本地目录作为托管项目，桌面端发现通过门禁且已登录的 Codex。
- DeepSeek 视图使用当前托管项目目录；正式安装版使用随包 DSH，系统需有 Node.js 22.19+ 或 24+，发送前需在该视图配置 DeepSeek API Key。
- 性能模式关闭时才提供 AI 任务执行。

## 4. 主流程

1. 用户进入管家、选择托管项目，并在 Codex / DeepSeek 两个视图中选择一个后端。
2. Codex 视图探测 Runtime、启动 `app-server`，加载模型、权限、Skills、Apps、Plugins 和 Thread 列表。
3. DeepSeek 视图由 Tauri 启动随包 DSH bridge，加载 Session、credentials、模型、Agent preset 与权限设置；缺少 API Key 时先完成凭据配置。
4. 用户在当前后端创建或恢复原生 Thread/Session，并发送目标；后续状态、输出、审批和提问只回到该原生会话。

Codex 视图的完整任务流程：

1. 用户新建或恢复一个 Thread，输入目标，可附加图片。
2. RocketX 使用当前模型、推理强度和权限档启动 Turn，并流式展示回答和过程。
3. 运行中需要审批或补充信息时，请求卡片出现在当前 Thread；用户处理后继续。
4. 运行中用户可停止，或选择“立即调整”把后续消息 Steer 到当前 Turn，或“排队”在当前 Turn 完成后发送。
5. 用户可以重命名、归档 Thread，或在 Codex App 中打开它。
6. 若已在 Codex App 顺序继续，回到 RocketX 后点击“从 Codex 刷新”；RocketX 取消目标 Thread 的订阅，在共享 Runtime 中恢复同一 Thread 并读取新增 Turns，不中断其他并行任务。

DeepSeek 视图不复制上述 Codex 专属动作。模型可切当前 Session；Agent preset 更新后续默认且只应用到空白 Session；permission preset 更新后续默认，并用 DSH 原生命令同步当前 Session。审批、问题、取消和历史恢复都沿用 DSH Host API 语义。

## 5. 状态与交互

- `idle`：尚未选择托管项目或尚未连接。
- `connecting`：Runtime/目录/Thread 正在加载，禁用重复连接。
- `ready`：可以创建/恢复 Thread 和发送。
- `running`：流式执行；显示停止与后续消息模式。
- `waiting-input`：Codex 或 DSH 当前会话在等审批/输入，只允许处理当前请求或停止，不能伪装成普通完成状态。
- `unavailable`：展示可操作原因，例如无 Runtime、版本受阻、未登录或 Web 环境。
- 过程详情默认可折叠；失败、审批、来源和最终结果保持可发现。

## 6. 平台与依赖

| 场景 | 当前状态 | 行为 |
| --- | --- | --- |
| 桌面端 + 兼容且已登录 Codex | 已实现 | 完整任务流程 |
| 桌面端 + 可用 DSH | 已实现 | 原生 Session、配置、审批、提问与凭据流程 |
| 桌面端，无 Codex/未登录/版本受阻 | 不可用 | 显示诊断和设置入口；其他 RocketX 功能继续可用 |
| 桌面端，DSH 缺 Node/API Key/资源 | 受限可用 | 显示对应诊断；缺 Key 时可先配置，资源或 Node 不满足时不启动 |
| 网页版 | 不可用 | 当前无生产可用的 Web Codex/DSH 传输 |
| 性能模式 | 不适用 | 管家执行入口停用 |

## 7. 数据与同步

- Thread、Turn 和 Codex Memory 由 Codex Home 会话库管理；RocketX 读取原生对象，不复制为独立真源。
- DSH Session、默认模型/Agent/权限和凭据由 RocketX 私有 `DSH_HOME` 中的 DSH 管理；API Key 由 DSH `credentials-local` 写入 `.credentials.yaml`，RocketX 只投影是否已配置，不把密钥或配置正文写入浏览器存储。
- 托管项目、模型、推理强度、权限档和后续消息模式按 Rocket.Chat 服务器/用户作用域保存在本机。`agentEnvironments` 是托管项目真源；`codexWorkspace` 只保留系统/current/runtime 工作区与 Runtime 生命周期，不再混放项目元数据。
- 输入图片先物化为受管本地附件，再交给当前 Runtime；不能把浏览器临时 URL 当持久来源。
- “从 Codex 刷新”是显式重新读取，不是实时双向协同编辑。

## 8. 权限与安全

- 权限行为以 [权限、审批与用户输入](approvals-and-permissions.md) 为准。
- 托管项目是默认文件作用域；额外目录或网络能力必须由权限档和 Runtime 沙箱决定。
- 来自工具、仓库、消息和网页的内容均是不可信输入，不能改变系统级权限规则。
- 所有请求按原生 Thread/Session 隔离，不能在另一个任务中批准。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| 托管项目未选择/不存在 | 提示选择有效目录 | 不启动进程；重新选择 |
| Runtime 不可用 | 显示探测原因 | Rocket.Chat/工作台仍可用；安装、登录或改路径后重连 |
| DSH Node/资源不满足 | 显示精确运行时原因 | 不在线下载或降级到未知 DSH；修复系统 Node 或安装资源后重连 |
| DeepSeek API Key 未配置 | 发送前提示配置 | 不发送 prompt；在当前 DSH 视图配置后重试 |
| DSH bridge 退出 | 当前运行 Session 标为中断并清理旧审批/问题/队列 | 重连后读取原生 Session 历史，不把旧卡片继续当成可操作请求 |
| `app-server` 退出 | 当前任务标为中断 | 重连并恢复 Thread；不伪造完成 |
| Codex App 与 RocketX 同时写 | 产品不支持并提示顺序使用 | 先结束一端执行，再显式刷新 |
| 运行中点击刷新 | 拒绝刷新并说明任务仍在运行/等待输入 | 停止或完成后再刷新 |
| Thread 恢复失败 | 保留列表和错误 | 不创建影子会话；修复 Runtime 后重试 |

## 10. 验收标准

- `BUT-AC-01`：只有托管项目和 Runtime 就绪后才能创建或恢复 Thread。
- `BUT-AC-02`：Thread 列表来自 Codex；新建、重命名、归档后重新连接仍保持一致。
- `BUT-AC-03`：文本、图片、模型、推理强度和权限选择被传给实际 Turn，而非只改变 UI。
- `BUT-AC-04`：运行中可停止；Steer 与 Queue 产生不同、可验证的后续消息顺序。
- `BUT-AC-05`：审批和输入只出现在发起请求的 Thread，并在回答后继续原 Turn。
- `BUT-AC-06`：“在 Codex 中打开”与“从 Codex 刷新”支持顺序接续；刷新前拒绝活动 Turn。
- `BUT-AC-07`：网页版和无 Runtime 场景明确显示不可用，不进入无限连接或伪运行状态。
- `BUT-AC-08`：Codex 与 DeepSeek 是两个明确视图；切换后只展示该后端真实提供的配置和动作。
- `BUT-AC-09`：DSH 模型/提供方、推理强度、Agent preset、permission preset、approval、question 与 credentials 都经过原生 RPC，而非只改变 UI。
- `BUT-AC-10`：缺少 DeepSeek API Key 时发送 fail-closed；bridge 退出会中断运行态并清理失效交互。

## 11. 实现与测试证据

- 实现：`apps/web/src/agent/AppServerController.ts`、`apps/web/src/stores/codexWorkspace.ts`
- 实现：`apps/web/src/components/ButlerConversation.tsx`、`apps/web/src/components/ButlerConversationHistory.tsx`
- 实现：`apps/web/src/agent/codexTransfer.ts`、`apps/web/src/agent/attachments.ts`
- 实现：`apps/web/src/agent/dsh/`、`apps/web/src/stores/dshWorkspace.ts`、`apps/web/src/components/DshConversation.tsx`
- 实现：`apps/desktop/src-tauri/src/dsh.rs`、`apps/desktop/src-tauri/src/dsh_bridge.mjs`
- 实现：`apps/web/src/components/ButlerProjectConfigDialog.tsx`、`apps/web/src/stores/agentEnvironments.ts`
- 自动化：`scripts/regressions/app-server-controller.test.ts`、`scripts/regressions/codex-workspace.test.ts`
- 自动化：`scripts/regressions/codex-transfer.test.ts`、`scripts/regressions/butler-stop-process.test.ts`
- 自动化：`scripts/regressions/dsh-web-core.test.ts`、`dsh-workspace-actions.test.ts`、`dsh-bridge-script.test.ts`、`dsh-controller-runtime.test.ts`
- UI：`tests/ui/butler-workspace.spec.ts`、`tests/ui/butler-host-input.regression-1.spec.ts`

## 12. 已知差距与目标

- 网页版尚无可生产部署的远程执行面；见 [Codex Runtime](codex-runtime.md)。
- 跨 App 只有“打开 + 显式刷新”，没有实时并发同步或冲突合并。
- DeepSeek 视图开放的是 DSH 已有模型/Provider、Agent 与权限的选择，不包含 provider endpoint CRUD 或 Agent preset 编辑器。
- 发布前应继续以真实 Codex 做模型目录、图片、审批、停止和跨 App 接续的端到端验证。
