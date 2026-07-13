# 架构决策记录

日期：2026-07-13

## 决策 1：自研客户端 + 原版 Rocket.Chat 后端

**背景**：需求是「以 Rocket.Chat 为底子（保证兼容），外面做成和飞书一样的软件」。

**备选**：
1. 自研客户端，只走 RC 公开 API（选定）
2. Fork Rocket.Chat monorepo 深度改造前端
3. Apps Engine 插件 + 主题浅定制

**选定理由**：方案 2 与上游强耦合，Meteor 技术栈老旧，每次官方升级都要手工合并，
「兼容」会逐渐失守；方案 3 天花板太低做不出飞书级交互。方案 1 服务端零改动，
兼容性由 API 契约保证，前端技术栈完全自主。

**代价**：前端从零写，所有 UI 功能都要自己实现。

## 决策 2：MVP 聚焦 IM + Azure DevOps Server 2022 集成

用户环境中另一个核心平台是 Azure DevOps Server 2022（本地部署）。
因此第一期 = 飞书级 IM 体验 + ADO 事件进聊天（ado-bridge），
文档/日历等套件模块推后（导航栏保留入口占位）。

## 决策 3：Web 优先，后套桌面壳

React + Vite + Tailwind v4 + zustand。验证体验后用 Tauri 打包桌面端（M4）。

## 关键技术点

### 与 Rocket.Chat 的通信

- **REST**（`/api/v1/*`）：登录、会话列表（`subscriptions.get` + `rooms.get`）、
  历史消息（`channels|groups|im.history` 按房间类型分流）、发消息、表情回应、已读上报。
- **实时**（`/websocket`，Meteor DDP 协议）：
  - `connect` → `connected`，`ping`/`pong` 心跳；
  - `method: login`（用 REST 的 authToken resume）；
  - 订阅 `stream-room-messages`（房间新消息/编辑/回应）、
    `stream-notify-user` 的 `<uid>/rooms-changed` 与 `<uid>/subscriptions-changed`
    （会话列表与未读数实时更新）；
  - 断线指数退避重连，重连后自动恢复登录与全部订阅（见 `rc-client/src/realtime.ts`）。
- **时间字段陷阱**：REST 返回 ISO 字符串，实时 API 返回 `{ $date: ms }`，
  统一经 `tsMs()` 归一化。

### 开发期跨域

Vite dev server 把 `/api`、`/websocket`、`/avatar`、`/file-upload` 代理到 RC 服务
（目标由 `RC_URL` 环境变量控制），前端一律同源相对路径，无 CORS 问题。
生产部署采用同样思路：由 Nginx/Caddy 反向代理统一域名。

### ado-bridge 设计

无状态 HTTP 服务。ADO Service Hooks 每种事件都自带 `message`/`detailedMessage`
文本，所以对未识别的 eventType 也能兜底投递；已识别的事件类型附加
emoji/颜色/中文标签，构建失败自动转红。投递走 RC 的 `chat.postMessage`
（机器人账号 + 个人访问令牌），支持 `?channel=` 按订阅路由到不同频道。

### 认证的关键实现细节

- REST 认证从 localStorage **实时读取**（`authProvider` 回调），不依赖登录时序或
  模块单例状态——Vite HMR 可能造成模块图分叉（带 `?t=` 时间戳的双实例），
  内存注入式认证会在其中一份实例上丢失；
- 登录/续期后同步种 `rc_uid`/`rc_token` cookie：`<img>` 头像和 `/file-upload`
  文件请求不走 fetch 头，靠 cookie 通过 RC 认证。

### Rocket.Chat 兼容性坑（踩过并已绕过）

| 现象 | 原因与对策 |
| --- | --- |
| 引用回复的 `message_link` 附件被服务端清空 | REST 层会清洗附件里的外站链接；相对路径又被 400 拒绝。**正确姿势**：消息文本以 `[ ](<Site_Url>/channel/xx?msg=<id>) ` 开头，由服务端自动展开为引用附件（官方客户端同样机制）。客户端渲染与会话预览需隐藏该前缀 |
| 中文文件名上传后变成 `%E9%9C%80...` | multipart 的 `filename` 不能 `encodeURIComponent`，直接用 UTF-8 原文 |
| 桌面端图片/头像/文件 403 | `<img>` 带不上认证头，桌面端 cookie 又不生效 → 改为带头 fetch 成 blob 再显示 |
| 桌面端登录 Failed to fetch | webview 的 CORS。改走 tauri-plugin-http（Rust 通道），并注意权限模式要写 `http://**:*`（`http://**` 不匹配自定义端口） |
| `chat.getMessageReadReceipts` 返回 400 | 已读回执是**企业版**功能，社区版拒绝。客户端首次失败后停止请求并隐藏该 UI |
| 置顶/星标后消息不刷新 | 服务端不推送这两类变更事件，需本地乐观更新 |
| 频道未读数一直是 0 | RC 频道默认只有 @ 才累计 `unread`，普通新消息只置 `alert` 标志 |
| Tauri plugin-http 上传 FormData 失败 | 该通道对 FormData 支持不可靠，手工构造 multipart 字节流 |

### 中文环境必须的服务端设置

连接已有 Rocket.Chat 服务器时，请在管理后台调整（本仓库 dev compose 已内置）：

| 设置 | 值 | 原因 |
| --- | --- | --- |
| `UTF8_Channel_Names_Validation` | `[0-9a-zA-Z-_.一-龥぀-ヿ]+` | 默认不允许中文群组/频道名 |
| `Message_AlwaysSearchRegExp` | `true` | Mongo 文本索引不切分中文，默认搜索搜不到子串（如搜「你」找不到「你好」）；改用正则子串匹配。大数据量下正则搜索无索引、较慢，重度使用可后续接 ElasticSearch 类搜索服务 |
| `Accounts_TwoFactorAuthentication_By_Email_Enabled` | 按需 `false` | 新用户默认邮箱验证码拦截登录（无邮件服务的内网环境无法收码） |

### 已知限制（M2 后）

- 登录不支持双因素认证（2FA）账号；
- 消息置顶/收藏/转发、全局搜索、群成员面板未实现（排入 M2.5）。
