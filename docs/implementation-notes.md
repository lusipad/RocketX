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

# Implementation notes — GitHub Issues #36–#39

## Decisions

- #36 的界面字段实际是 ADO 项目；最近选择按 Rocket.Chat 账号隔离，并在同一 ADO 连接内优先恢复。Issue 要求的 Feature/User Story/开发与测试 Task 模板已存在，不重复增加。
- #39 在直连请求源头把“我提的”限制为 active，避免下载后再过滤已完成 PR；bridge 原本就只请求 active。
- #37 只展示 ADO 返回的 `isRequired` / `isContainer` 和 vote，不从名称猜测必审组或策略要求。
- #38 同时统计 RocketX 及其 WebView2 子进程的工作集和私有内存，避免只测壳进程或把共享页重复计入后直接下结论。

## Deviations

- #21 缺少失败请求 URL 和响应体，本轮不猜测 404 根因，也不改认证或 API 路径。

## Surprises

- #36 描述的层级模板与现有 `Feature 全套` 完全一致，缺口只是项目选择未持久化。
- 直连“我提的 PR”仍显式请求全部状态，而 bridge 已经只取 active，两个模式行为不一致。
- Windows release 客户端在已登录并连接状态启动 10 秒后共 7 个进程，合计工作集 476.5 MB、私有内存 271.8 MB；这是当前机器的首个基线，不是跨机器的产品阈值。

## Questions for review

- #38 尚无目标内存阈值；本轮交付 `pnpm measure:memory` 和实测基线，不做无数据支撑的缓存重构。后续应在相同账号、页面和采样时刻比较私有内存趋势。

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

---

# Implementation notes — 桌面端开机自启（4.1）

## Shipped vs planned

已接入 Tauri 官方 autostart 插件。桌面端设置页可读取操作系统中的真实注册状态，并显式开启或关闭开机自启；Web 端保持可用且不会尝试修改系统设置。

## Decisions

- 默认保持关闭，不在升级或登录时替用户开启。
- 由官方插件管理各平台的系统启动项，不直接写 Windows 注册表。
- 每次切换后重新读取系统状态，只有实际状态与用户选择一致才提示成功。
- 本轮保持正常显示窗口的启动行为；静默驻留和单实例另行设计，避免用户登录系统后找不到应用。

## Deviations

- 无。

## Verification limits

- 自动化测试不切换开发机的真实系统启动项，避免留下机器级副作用；以插件权限、Rust 编译、Web 降级回归和生产构建验证集成边界。
- 没有桌面设置页视觉稿可供 visual-verdict 对照，界面复用现有 Row 与 Toggle 组件保持一致。

## Questions for review

- 无。

---

# Implementation notes — 桌面端单实例（4.2）

## Shipped vs planned

已接入 Tauri 官方 single-instance 插件。再次启动 RocketX 时，新进程立即退出，已有进程的主窗口会显示、取消最小化并获得焦点。

## Decisions

- single-instance 作为第一个 Tauri 插件注册，遵循官方插件的初始化顺序要求。
- 复用托盘与全局快捷键已经使用的 `show_main()`，避免出现三套不同的窗口恢复行为。
- 当前忽略第二实例传入的参数和工作目录；通知深链或协议链接落地时再定义参数契约。
- 单实例属于桌面可靠性约束，不增加允许用户关闭的设置项。

## Deviations

- 无。

## Surprises

- 无。

## Questions for review

- 无。

---

# Implementation notes — Windows 通知点击跳转（4.3）

## Shipped vs planned

Windows 消息通知现在保留原生通知句柄；用户点击通知正文后，RocketX 会显示并聚焦主窗口、切回消息模块并打开对应会话。Web 继续使用浏览器 `Notification.onclick`，其他桌面平台保持原有通知行为。

## Decisions

- 官方 Tauri notification 的 Actions API 仅支持移动端；Windows 改为直接复用插件已依赖的 `notify-rust` 后端，不伪用无效的 `onAction()`。
- 通知只携带当前账号内的房间 ID，不携带服务器地址、令牌、消息正文以外的认证数据。
- 页面端在已登录且聊天初始化完成后才接受导航事件，并再次校验房间 ID。
- 点击关闭或通知自然过期不触发跳转，只有点击通知正文才执行。

## Deviations

- Windows 的通知发送从官方插件的无句柄封装下沉到同一底层 `notify-rust`，因为官方桌面封装会丢弃响应句柄，无法观察正文点击。

## Surprises

- `@tauri-apps/plugin-notification` 暴露了 `onAction()` 类型，但官方平台说明和 Rust 实现都表明桌面端没有注册该监听器；仅按 TypeScript API 推断会得到一个永远不触发的实现。

## Verification limits

- 当前官方 Windows 界面控制入口返回空的非错误结果，无法自动点击系统通知；已验证响应分支、事件载荷、导航校验、Rust/TypeScript 编译与完整桌面链接，但最终通知中心点击仍需安装版手工验收。

## Questions for review

- 无。
