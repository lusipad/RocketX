# `PERM` 权限、审批与用户输入

> 当前状态：`已实现`（交互式管家与共享 Agent）；已安排任务采用无人值守限制
> 基线：工作树 `2026-08-16`
> 平台：桌面端；Codex 与 DSH 使用各自原生权限语义

## 1. 目标

让用户在发送任务前看懂当前后端的默认权限，在执行越界或需要业务决策时，把审批/输入准确送回原生 Thread 或 Session。Codex 的“替我审批”与 DSH 的 permission preset 是两套不同合同，界面不能假装它们等价。

## 2. 范围

### 包含

- 三档权限：询问审批、替我审批、完全访问；
- 命令/文件/额外权限等 Host approval；
- 允许一次、本次任务允许和拒绝；
- `request_user_input` 与 MCP elicitation 结构化输入；
- 请求按 Thread/会话隔离；
- 已安排任务的自动拒绝/失败策略。
- DSH 原生 permission preset、approval/requested 与 question/requested；

### 不包含

- RocketX 自行绕过 Codex 沙箱；
- 在“完全访问”下继续承诺每个危险动作都会弹窗；
- 自动化任务静默接受需要人的审批；
- 把权限选择同步成所有设备的组织政策。
- 把 Codex Profile 与 DSH permission preset 互相映射。

## 3. 入口与前置条件

- 管家输入框下方权限选择器在任务开始前可见。
- 当前默认档为“替我审批”。
- 运行中出现审批或输入时，卡片插入发起请求的 Thread/共享 Agent 面板。

## 4. 主流程

### 4.1 权限档语义

| UI 档位 | Runtime 映射 | 当前语义 |
| --- | --- | --- |
| 询问审批 | `:workspace` + `on-request` + `user` reviewer | 工作区外文件或网络等请求由用户决定 |
| 替我审批 | `:workspace` + `on-request` + `guardian_subagent` reviewer | 低风险请求由 Codex 守护审查，检测到潜在危险时再问用户 |
| 完全访问 | `:danger-full-access` + `never` | 可访问网络和电脑上的任意文件；不会依赖常规审批弹窗 |

“替我审批”是权限审查方式，不是取消沙箱；“完全访问”才是广泛放开文件与网络边界。

### 4.2 审批与输入流程

1. 用户选择权限档并发送任务；RocketX 把对应 profile 传给 Thread/Turn。
2. Runtime 需要 Host approval 时，RocketX校验请求类型和路径，生成摘要卡片。
3. 用户选择拒绝、允许一次或本次任务允许；结果只返回给该请求。
4. Runtime 需要普通问题或 MCP 表单时，RocketX按字段呈现并把答案结构化返回。
5. Turn 继续、失败或被用户停止后，请求卡片关闭并清理等待器。
6. 已安排任务如果产生人工输入则失败；Host approval 自动拒绝，不能无限等待。

### 4.3 DSH 原生权限与请求

- RocketX 在开启共享托管时从 DSH `settings.describe` 读取 permission schema 和当前默认 preset，不维护固定枚举。
- “沿用 DSH 默认”不写任何设置；显式选择只在新建 Session 后通过原生 `commands/execute` 执行 `/permission <preset>`，不调用 `settings.update` 或 `settings.mutate`。
- DSH 发出 `approval/requested` 或 `question/requested` 时，RocketX 保留原始 `rpcId`，在所属 Session 显示卡片，并把用户结果经 `/api/respond` 返回。
- DSH 进程退出、Session 结束或用户取消后，待审批、待提问与排队输入全部失效并清理，不能继续点击旧卡片。
- DSH preset 的名称、说明和实际能力由当前固定 DSH 运行时定义；RocketX 不把它翻译成 Codex 的“询问审批 / 替我审批 / 完全访问”。

## 5. 状态与交互

- `可发送`：权限档在输入框旁可见，变更只影响后续选择/运行配置。
- `运行中`：普通进度可折叠，新的审批或输入请求必须保持可见。
- `等待审批`：显示操作摘要及拒绝、允许一次、本次任务允许。
- `等待输入`：按问题或 MCP 字段呈现，提交后回到原 Turn。
- `已拒绝/已取消`：请求关闭，Runtime 收到明确拒绝或取消结果。
- `任务结束/中断`：清理所有尚未回答的请求，卡片不能继续操作。

## 6. 平台与依赖

| 场景 | 当前状态 | 行为 |
| --- | --- | --- |
| 交互式管家 | 已实现 | 在所属 Thread 显示审批和输入 |
| 共享 Agent | 已实现 | 在所属房间/Discussion 面板处理 |
| DeepSeek 管家/AI 托管 | 已实现 | 在所属 DSH Session 处理原生 approval 与 question |
| 已安排任务 | 受限可用 | 无人值守，不接受人工输入，审批默认拒绝 |
| 网页版 | 不适用 | 当前没有本地 Codex Turn 或 DSH Session，也不会产生这些请求 |

## 7. 数据与同步

- 当前权限档按 Rocket.Chat 服务器/用户的管家设置保存在本机。
- “允许一次”只作用于当前请求；“本次任务允许”只作用于当前任务生命周期。
- 审批卡片和待答输入是内存中的活动请求，不作为长期业务记录。
- Runtime 权限 profile 目录来自当前 Codex；RocketX 的三档映射是当前产品快捷项。
- DSH 默认 permission preset 与 schema 由 DSH Settings 保存；RocketX 只保存共享会话实际采用的快照，不建立第二份权限真源。

## 8. 权限与安全

- 对路径和额外权限请求做结构校验，拒绝把请求参数直接当可信路径。
- 未知 Server Request 使用安全拒绝策略，不默认接受。
- 一个 Thread 的请求不能在另一个 Thread 回答；过期请求不能复用。
- 一个 DSH Session 的 `rpcId` 不能在另一个 Session 回答；bridge 断开后旧请求必须失效。
- “完全访问”必须保留醒目描述，不能用“更少询问”等弱化文案掩盖风险。
- 上游 Permission Profiles 仍可能演进，升级 Codex 时必须重跑映射测试。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| 请求类型未知 | 请求被安全拒绝并记录错误 | 不执行未知动作 |
| 路径/权限参数非法 | 拒绝请求 | 不把非法范围传给 Runtime |
| 用户停止 Turn | 所有待处理请求取消 | 不保留可被误点的旧卡片 |
| 回答另一个 Thread 的请求 | 操作被隔离/拒绝 | 返回所属 Thread 处理 |
| 自动化需要人工输入 | 本次运行失败 | 修改计划/Skill 使输入固定后重试 |
| DSH bridge 断开 | 清理待审批/问题并标记会话中断 | 重连并从 DSH 原生历史恢复；旧 `rpcId` 不复用 |

## 10. 验收标准

- `PERM-AC-01`：三档 UI 文案与 Runtime 映射完全一致，默认档为“替我审批”。
- `PERM-AC-02`：“替我审批”仍使用 workspace 沙箱和 on-request，不等同于 `danger-full-access`。
- `PERM-AC-03`：命令审批支持拒绝、允许一次和本次任务允许，并返回给原请求。
- `PERM-AC-04`：`request_user_input` 和 MCP elicitation 的结构化值按字段回传。
- `PERM-AC-05`：其他 Thread 的请求不会出现在当前任务，也不能被当前任务处理。
- `PERM-AC-06`：停止或中断任务会清理待处理请求。
- `PERM-AC-07`：已安排任务不会因等待人类确认而永久挂起，也不会自动接受危险动作。
- `PERM-AC-08`：DSH permission preset 来自原生 schema；共享托管的显式选择只对新 Session 调用 `/permission`，沿用默认时不产生写入。
- `PERM-AC-09`：DSH approval/question 保留原始 `rpcId`，只在所属 Session 回答；bridge 退出会使待处理卡片失效。

## 11. 实现与测试证据

- 实现：`apps/web/src/agent/AppServerController.ts`、`apps/web/src/agent/protocol/serverRequests.ts`
- 实现：`apps/web/src/stores/codexWorkspace.ts`、`apps/web/src/components/ButlerErrandInputCard.tsx`
- 实现：`apps/web/src/components/ButlerConversation.tsx`、`apps/web/src/components/AgentPanel.tsx`
- 自动化：`tests/ui/butler-host-input.regression-1.spec.ts`
- 自动化：`scripts/regressions/codex-workspace.test.ts`、`scripts/regressions/shared-agent-runtime.test.ts`
- 实现：`apps/web/src/agent/dsh/protocol.ts`、`apps/web/src/agent/dsh/DshController.ts`、`apps/web/src/agent/dsh/HostedDshController.ts`
- 自动化：`scripts/regressions/dsh-controller-runtime.test.ts`、`scripts/regressions/hosted-dsh-controller.test.ts`、`scripts/regressions/dsh-bridge-script.test.ts`
- 上游参考：[Codex permissions](https://learn.chatgpt.com/docs/permissions)

## 12. 已知差距与目标

- RocketX 当前用三个固定快捷档映射上游 Profiles；尚未提供完整原生 Profile 细节比较界面。
- “完全访问”的风险提示需要持续做真实 UI 可见性和键盘操作验证。
- DSH 权限描述由上游 schema 提供；新增或更名 preset 时需重新验证文案、默认值和当前 Session 同步。
