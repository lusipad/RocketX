# Implementation notes — 普通员工首次上手

Plan: 当前任务对话中的《第一项：普通员工首次上手》

## Shipped vs planned

已交付 Rocket.Chat 登录预检、可跳过的 Azure DevOps 第二步，以及按服务器和账号隔离的首用清单。通知授权改为用户主动触发，工作台未配置时直接进入连接设置。既有 ADO 配置会跳过第二步，未新增服务端接口或依赖。

## Decisions

- 首次引导状态按 Rocket.Chat 服务器和用户 ID 组合隔离，不复用账号数据归档机制。
- 已有有效 ADO 配置的用户直接视为第二步已完成，避免升级后强制重复配置。
- 首用清单只在会话创建、消息服务端确认和通知实际授权三个成功点写入完成状态。
- Web 首次引导默认选择 ado-bridge；Windows 桌面端默认直连并优先尝试集成认证。
- 登录页始终使用中性“连接 Rocket.Chat”文案；只有登录后读取到当前服务器和账号的待处理状态，才显示首次设置，避免普通重新登录被误判为首次使用。

## Deviations

- ADO 连接成功后直接进入主界面，不额外停留在成功确认页；失败信息留在当前步骤供修改和重试。

## Surprises

- `SettingsPage` 已经包含完整 ADO 探测 UI，但连接编排仍在页面内部；首次引导直接复用底层 `probeAdo` / `directGetIdentity`，不复制探测算法。
- 真实 smoke 首次运行时本地 `admin` 密码与仓库声明的开发凭据漂移；恢复 Meteor 的 SHA-256 后 bcrypt 哈希后，50 项全部通过。

## Questions for review

- 无。

---

# Implementation notes — 日常高频 IM 易用性（2.1 + 2.3）

## Shipped vs planned

已交付共享模块顺序、按当前可见列表切换会话、搜索结果切回消息模块、连续处理未读、可调会话列表宽度、可收起分组栏和快捷键帮助。2.2 富草稿迁移按决定未实施。

## Decisions

- 会话列表宽度限制为 220–480px，拖动后按服务器和账号保存，双击分隔线恢复 280px。
- 窄窗口只约束实际显示宽度并临时收起分组栏，不覆盖用户在宽窗口保存的布局。
- 当前未读会话读完后暂留在未读列表；打开下一条未读时替换暂留项，避免列表在阅读过程中跳动。
- 会话快捷键复用列表的过滤、分组、折叠与排序计算，不再另建一套排序规则。

## Deviations

- “下一条未读”同时提供聊天标题栏按钮和 `Ctrl+Shift+↓`，没有新增遮罩式引导。

## Surprises

- 引导状态的存储键已包含服务器，但内存中的 hydrate 去重此前只比较用户 ID；本次补齐服务器比较，避免同 ID 用户切服后沿用旧状态。布局状态采用同一隔离方式。

## Questions for review

- 无。

---

# Implementation notes — Windows 全局指令中心（2.4）

## Shipped vs planned

已交付：Windows 桌面端使用系统全局快捷键唤起未读优先的统一指令中心；Web 只保留原有应用内搜索。设置页支持启停、三个预设组合和注册冲突提示。

## Decisions

- 使用官方 Tauri 2 `global-shortcut` 插件，不自建 Win32 消息循环。
- 默认 `Ctrl+Alt+K`，设置页提供三个预设组合和关闭开关；首轮不支持任意按键录制。
- 空输入优先显示未读会话；没有未读时退回最近会话，避免唤起空面板。
- 配置是设备级本地状态，不按 Rocket.Chat 服务器或账号隔离。

## Deviations

- 桌面 Release `--no-bundle` 已完成 Web 构建并进入 Rust LTO 链接，但用户切换到下一项后停止等待；以 `cargo check` 和真实 `tauri dev` 验收作为本轮桌面证据。

## Surprises

- 现有托盘代码已经完整封装显示、取消最小化和聚焦，新增命令只需复用 `show_main()`。

## Questions for review

- 无。

---

# Implementation notes — 统一搜索（3.1）

## Shipped vs planned

已在现有全局指令中心增加“工作”范围，统一搜索本机待办、日历事件和当前 ADO 连接已加载的工作项。待办可跳回来源消息，日程定位到对应日期的日视图，工作项进入工作台并打开 ADO 原项。

## Decisions

- 工作数据搜索只读取现有 store，不在用户输入时新增网络请求。
- 标题前缀、标题包含、详情包含依次降权，最多显示 20 条结果。
- 继续复用 `Ctrl/Cmd+K` 和 Windows 全局快捷键入口，不新增第二套搜索页面。

## Deferred

- Rocket.Chat 目前仅封装单房间 `channels.files` / `groups.files` / `im.files`。全局文件搜索若逐房间扇出，会随会话数放大请求，因此留到后续设计服务端索引或有界缓存方案。
- 高级筛选、结果分组总览和语义搜索不在本切片内。

## Questions for review

- 无。
