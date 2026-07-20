# Implementation notes — 工作项讨论与多本地环境

Plan: 当前 Codex 任务中的验收计划

## Summary

已完成：用户可以配置多个真实本地目录，从 ADO 工作项创建 Rocket.Chat 原生 Discussion，并为每个活动讨论独占绑定一个目录。Discussion 使用房间级共享 Agent；原版 Rocket.Chat 成员以结构化 `@ai` 提问，本机宿主负责代码上下文、命令执行和审批。首次获准修改前，Agent 必须检查脏目录并创建计划分支。

第二轮打磨取消了额外约定：已绑定 Discussion 接受开头的字面量 `@ai`，不再依赖客户端生成结构化 mention；共享 Agent 把环境的基础分支传给 Codex。Discussion 的前序房间消息会作为不可信上下文完整带入。自 v0.25.4 起，AI 托管改用独立的 Codex 模型和推理强度设置。

## Decisions

- `apps/web/src/agent/session.ts`: 复用现有共享 Agent 会话，以合成键 `room:<rid>` 支持 Discussion 顶层会话；原有消息线程继续使用真实 `tmid`。
- `apps/web/src/stores/agentEnvironments.ts`: 本地环境和讨论绑定仅保存在当前 Rocket.Chat 账号的本机存储中，群消息只公开环境别名。
- 分支由 Codex 在第一次获批写入前创建；应用不直接执行 Git，也不自动处理脏目录。
- 同一工作项只保留一个活动讨论，同一本地环境只允许一个活动写入讨论；结束 Agent 会释放绑定。
- 创建讨论时可选将原生 Discussion 链接写回 ADO；真实目录不会写入 Rocket.Chat 或 ADO。
- `apps/web/src/agent/context.ts`: 线程会话继续按线程选上下文，工作项 Discussion 则使用同一房间最近消息，避免再次要求成员引用或复述讨论。
- `apps/web/src/stores/sharedAgent.ts`: 模型与推理强度读取 AI 托管专用设置；升级时仅首次继承既有管家设置，之后互不影响。
- `apps/web/src/components/ChatArea.tsx`: 活动房间头部直接展示“谁的 AI + 当前状态”；本机读取完整运行状态，其他客户端读取公开租约卡，不新增状态协议。
- `apps/web/src/components/AiSettings.tsx`: AI 配置默认只突出代码目录；模型、Provider、能力路由、自动化接口和专用 Bot 统一折叠到高级设置。单个目录的项目映射与分支细节也按需展开。
- `apps/web/src/components/ChatArea.tsx`: 每个普通会话只保留一个“AI 托管”入口，可在讨论进行到一半时直接开启，不再要求先进入消息话题。标题包含 `#工作项编号` 时自动加载 ADO 工作项并注入目标、约束和验收提示；无法识别时仍按普通会话托管。
- 托管成功只发布一条 Rocket.Chat 标准 Markdown 状态消息，明确主持人、状态、环境和 `@ai` 用法；RocketChat X 将同一消息提升为头部状态标记，原版客户端直接显示消息内容。用户还可在托管面板设置“进入本房间时自动开启”，该设置仅在本机生效且不会抢占其他宿主。

## Deviations

- 没有引入 worktree、目录复制或自动 stash/reset；不同任务并行依赖用户预先配置的不同真实目录。
- 没有让应用进程直接创建 Git 分支；分支创建由 Codex 在原生沙箱和审批流内执行。

## Surprises

- `apps/web/src/components/Composer.tsx:246`: 现有编辑器已经会把从全局人员搜索中选中的群外用户在发送前邀请进房间，不需要另做 AI 邀请链路。
- `apps/web/src/stores/sharedAgent.ts:585`: 现有共享 Agent 严格要求 `message.tmid`，Discussion 顶层消息此前不会触发。
- 工作项卡片的创建弹窗必须延迟加载共享 Agent store，否则纯 Node Markdown/滚动回归会被桌面 IndexedDB 运行时污染。
- 房间级租约卡的消息没有 `tmid`，必须用 `room:<rid>` 与卡片会话键对应；沿用线程比较会让另一宿主看不到租约。

## Questions for review

- 无。
