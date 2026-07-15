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

---

# Implementation notes — 统一搜索总览（3.2）

## Shipped vs planned

已将“全部”设为普通搜索和 Windows 全局指令中心的默认范围。输入关键词后按会话、消息、联系人/频道、工作分组预览，每组最多三条，并可查看该类型的当前全部结果；空输入仍只显示未读或最近会话。

## Decisions

- “全部”只组合现有四类结果和跳转动作，不建立第二套搜索状态或请求。
- 筛选标签在远端搜索完成后显示当前结果数量，避免加载过程中的数字跳动。
- 键盘上下键与 Enter 严格按总览的视觉顺序移动。

## Deviations

- 无。

## Verification limits

- 没有产品视觉稿或旧版“全部”页可作为截图参考，无法执行基于参考图的 visual-verdict 评分。
- Windows 官方界面控制入口本轮只返回空的非错误结果，未取得自动化截图；以类型检查、回归测试和生产构建覆盖功能正确性。

## Questions for review

- 无。

---

# Implementation notes — 有界文件搜索（3.3）

## Shipped vs planned

已增加按服务器和用户隔离的本机文件元数据索引，以及统一搜索中的“文件”范围。打开会话文件面板并成功加载后，最多索引最近 20 个房间、每房间 50 个文件；点击搜索结果会重新进入房间、刷新文件列表并定位目标文件。

## Decisions

- 只缓存文件 ID、名称、类型、大小、上传时间和上传者，不缓存文件内容、下载路径、认证信息。
- 搜索期间不发起任何文件 API 请求；文件权限和存在性在点击后通过房间及文件面板请求重新验证。
- 已离开的私有房间会从搜索结果中过滤，公开频道仍允许通过现有加入流程打开。
- 界面明确显示索引覆盖的房间数量，不将本机缓存描述成服务器全量搜索。

## Deviations

- 无。

## Verification limits

- 没有文件搜索视觉稿可供 visual-verdict 对照，未生成主观截图评分。

## Questions for review

- 无。

---

# Implementation notes — 搜索结果筛选（3.4）

## Shipped vs planned

已在统一搜索中增加可展开筛选栏。发送人和时间范围作用于当前命中的消息与文件，文件类型仅作用于文件；总览、分类计数、键盘导航和空状态统一使用筛选后的结果。

## Decisions

- 筛选是纯客户端后处理，不改变现有 Rocket.Chat 搜索请求。
- 界面明确说明筛选不会扩大服务器搜索范围；当前消息搜索最多 20 条，文件索引搜索最多 20 条。
- 时间范围提供不限、近 7 天、近 30 天、近一年；缺少时间戳的结果在启用时间筛选后排除。
- 文件类型同时识别 MIME 和常见扩展名，分为图片、文档、压缩包、其他。

## Deviations

- 无。

## Verification limits

- 没有高级筛选视觉稿可供 visual-verdict 对照，未生成主观截图评分。

## Questions for review

- 无。
