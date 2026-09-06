# `SPEC-SLASH-01` 斜杠命令与团队功能（投票 / 看板 / 值班表）

> 当前状态：`已实现`
> 基线：v0.43.28 之后的命令引擎重构；对 Rocket.Chat 8.6.1 实测
> 平台：`网页版 | 桌面端`（两者同一套 web 代码）

## 1. 目标

用户在输入框打 `/` 能发现并可靠地使用全部命令；参数化命令不再要求手打
`@用户名` / `#频道` 语法，而是弹出对应的图形界面（参数只作预填值）。
投票、看板、值班表是真正的**团队功能**：状态存服务端、全员实时共享，
并且**未安装 RocketX 的官方 Rocket.Chat 客户端也能阅读和参与**。

## 2. 范围

### 包含

- 27 个服务端命令 + 3 个原生功能命令（/poll /kanban /oncall）的逐项实现策略；
- 命令说明的全量中文文案与兜底策略（永不显示 i18n 键名）；
- 每个功能的「斜杠命令 + GUI 常规入口」双入口；
- 与官方 RC 客户端的互通（投票双向计票、看板/值班表话题可读）。

### 不包含

- `/ban` 之外的**服务器级**管理（角色、权限编辑）——走官方管理界面；
- 官方客户端上的看板/值班表**图形化**界面（它们看到的是人话消息流）；
- 服务器端插件或应用（RocketX 不要求在服务器装任何东西）。

## 3. 入口与前置条件

- 斜杠命令：输入框打 `/`（补全面板）、工具栏「?」（命令帮助 `CommandHelpDialog`）、`Ctrl+/`。
- 投票：`/poll`、Composer 工具栏「发起投票」按钮。
- 看板：`/kanban`、聊天区头部「消息看板」按钮、消息右键「加入看板」。
- 值班表：`/oncall`、群信息面板「团队值班表」。
- 加入频道 / 状态：NavRail「+」菜单。
- 批量导入成员：成员面板「从其他频道导入成员」按钮。
- 权限：命令执行的成功与否由服务端 REST 权限决定，GUI 只是把失败讲成人话。

## 4. 命令逐项分析（现状 → 实现 → 双入口）

| 命令 | Rocket.Chat 参考语义 | RocketX 实现 | kind | GUI |
| --- | --- | --- | --- | --- |
| /me | 服务端生成动作消息 | 保持 `commands.run`（格式由服务端决定） | forward | 无 |
| /shrug /tableflip /unflip /lennyface /gimme | 服务端改写文本追加颜文字 | **客户端改写文本后直发**（与服务端输出一致，验证见 poll.test 同套 smoke） | text | 无（参数即消息本体） |
| /msg @user [text] | 打开私聊并发首条 | startDM + 草稿预填 | gui | StartDMDialog（预选用户） |
| /invite @users | 服务端拉人 | inviteMembers（复用成员面板同一动作） | gui | AddMembersDialog（预选） |
| /invite-all-from/-to #room | 服务端整批拉人 | getMembers 分页 + 批量邀请（显示影响人数） | gui | RoomPickerDialog |
| /kick /mute /unmute | 服务端成员管理 | kickMember / rest.muteUser（RC 8.6.1 仅此路） | gui | MemberActionDialog（选择+确认） |
| /ban /unban | 服务端封禁（无 REST 端点） | `commands.run` 转发 | gui | 确认框 |
| /create [name] [--private] | 建频道 | createGroup + 导航到新频道 | gui | CreateGroupDialog（预填） |
| /join #room | 加入公开频道 | spotlight 搜索 → joinRoom → 导航 | gui | JoinChannelDialog（搜索+加入） |
| /leave /part | 退出频道 | leaveConv（DM 自动转隐藏） | gui | 确认框（私有群警示） |
| /hide | 隐藏会话 | hideConv 直发（随时可恢复） | text | 无 |
| /archive /unarchive | 归档切换 | archiveConv（与房间信息面板同一动作） | gui | 确认框 |
| /topic | 设频道话题 | saveRoomSettings({topic})（与 EditableField 同路） | gui | TopicDialog（多行预填） |
| /status | 状态文案 | rest.setStatus(presence, 文案) | gui | StatusDialog（四态+文案） |
| /help | 服务端返回快捷键 | 客户端渲染全部合并命令，可搜索、点击插入 | gui | CommandHelpDialog |
| /sendEmailAttachment /slackbridge-import | 服务器应用提供 | `commands.run` 转发 | forward | 无 |
| /poll | （官方为 Apps 应用） | **原生功能**：附件存题目选项，票=数字表情回应 | gui | PollCreatorDialog + 聊天内投票卡片 |
| /kanban | （示例应用，本地存储） | **原生功能**：频道看板 = 根消息 + 话题事件流 | gui | KanbanPanel（右面板，拖拽/箭头移动） |
| /oncall | （示例应用，本地存储） | **原生功能**：值班表 = 根消息 + 话题事件流 + 文本快照发布 | gui | OncallPanel |
| /summary /ai /exit | — | kernel AI 命令（feature 门控），未改动 | — | 既有面板 |

未知命令：不发、不落地成消息，toast 提示并附最近似命令（编辑距离 ≤2）。

## 5. 团队功能的共享状态设计（跨客户端互通的关键）

服务器是未改造的 RC：没有应用存储，`chat.update` 对附件做严格 schema
校验（自定义字段被拒收，实测）。因此只用三条验证过的通道：

1. **消息附件**：`sendMessageRaw` 携带自定义 type 附件（`rcx-poll` /
   `rcx-kanban-board` / `rcx-kanban` / `rcx-oncall-board` / `rcx-oncall`），
   完整往返（smoke 断言）。官方客户端把附件 `text` 渲染成可读文本。
2. **表情回应**：投票的票 = 投票消息上的 `:one:`..`:nine:` 回应计数，
   结束投票 = 创建者加 `:lock:` 回应。官方客户端加同样表情即参与同一套计票，
   双向实时（走既有消息更新流）。
3. **追加消息（事件流）**：看板/值班表 = 频道内一条根消息 + 话题里的
   create/move/remove 事件回复，面板按时间重放聚合。**永不编辑**已发消息，
   官方客户端在话题里看到的是人话（「把卡片「xx」移到 进行中」）。

## 6. 主流程（用户视角）

- `/poll` → 填问题与 2-9 个选项（可多选）→ 发布 → 频道出现投票卡片 →
  成员点数字表情计票（官方客户端用表情同样计票）→ 发起人可「结束」。
- 消息右键「加入看板」→ 卡片进待办列（引用原消息，可跳回）→
  拖拽/箭头移动列 → 所有成员实时同步。
- `/oncall` → 选日期/班次/值班人 → 排班实时共享 → 「发布到频道」发文本快照。

## 7. 验证

- 回归：`scripts/regressions/slash-commands.test.ts`（分发策略、文案覆盖、
  最近似建议）、`poll.test.ts`、`kanban-oncall.test.ts`（事件重放）。
- smoke：`pnpm smoke` 对真实服务端断言——命令表全覆盖（缺一条即失败）、
  commands.run 不落地成字面量、投票附件往返 + 双账号表情计票 + 结束标记。
- 双客户端实测（2026-09-06，RC 8.6.1）：RocketX(admin) 创建投票 →
  官方网页端(zhangsan) 阅读并以 1️⃣ 回应投票 → RocketX 卡片实时显示 2 票
  （reactions `:one: [admin, zhangsan]`）；值班表快照与看板话题在官方端可读。

## 8. 已知限制

- `/ban` 依赖服务端命令可用；服务端没装 banning 包时会收到服务端错误提示。
- 官方客户端上投票参与依赖其表情面板（点 1️⃣-9️⃣），无按钮式界面。
- 看板/值班表面板在极窄视口下第三列需横向滚动。
