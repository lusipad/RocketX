# 架构决策记录

> 文档状态：**当前架构说明**。用户可见能力、平台边界和验收以 [功能规格](specs/README.md) 为准；本文件只记录稳定架构决策与实现陷阱。

首次记录：2026-07-13；最近校准：2026-08-14

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
文档/日历等套件模块当时推后；日历已在后续里程碑落地，云文档入口已移除。

## 决策 3：Web 优先，后套桌面壳

React + Vite + Tailwind v4 + zustand。验证体验后用 Tauri 打包桌面端（M4）。

## 决策 4：定位自用 + 开源作品，核心主旨 GTD + 注意力保护（2026-07-17）

产品定位为个人与小团队自用 + 开源作品，不面向政企市场：信创适配、等保、应用市场、
rcx-hub 集中管控等平台级投入全部冻结。功能取舍以「GTD 五阶段 + 注意力保护」双支柱
为判据，详见 [产品原则](specs/product-principles.md)。`docs/blueprint.md` 保留愿景与历史规划，
不再作为当前功能清单。

## 关键技术点

### 确定性界面与原生 AI 后端边界

- 消息、工作台、待办、日历和通讯录保存可查询、可编辑的权威事实；AI 回答不构成第二套业务数据。
- 管家提供 Codex 与 DSH 两条独立纵切。Codex 视图直接使用本机 `app-server` 的 Thread、Skills/Plugins/Apps、Memory 和审批；DeepSeek 视图直接使用 DSH Web Host API 的 Session、模型/提供方、Agent preset、权限、审批、提问和凭据语义。
- AI 托管只共用 Rocket.Chat 租约、消息上下文、状态与回帖；每个会话固定一个后端并保存其原生 ID，不建立通用 Runtime registry，也不把不同能力压成最小公共集合。已安排任务仍由 Codex 执行。
- 桌面端通过 Tauri 发现并管理用户已安装、已登录且通过版本门禁的 Codex。精简包和全量包都不捆绑 Codex。
- 正式安装包通过 lockfile 固定并携带 `@deepseek-ai/dsh@0.1.0-rc.6` 生产运行树，运行时由 Tauri 管理 Node bridge；用户无需另装 DSH 或保留源码仓库，但当前仍需系统 Node.js 22.19+ 或 24+。
- 网页版保留 Rocket.Chat 与确定性工作界面，但当前没有本地 Codex 或 DSH Transport。详细降级行为见 [能力矩阵](specs/capability-matrix.md)。
- 交互式请求按原生 Thread/Session 隔离。Codex 的三档快捷权限与 DSH 的原生 permission preset 分别处理，不能互相映射后假装等价。

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
| `chat.getMessageReadReceipts` 返回 400 | 已读回执是**企业版**功能（错误信息就是 `This is an enterprise feature`）。别靠「打过去挨一个 400 再降级」——那样每次刷新都白打一个请求、控制台留一条红字。启动时读公开设置 `Message_Read_Receipt_Enabled` 就知道支不支持（社区版返回 `false, enterprise: true`）。失败熔断作为兜底保留 |
| 置顶/星标后消息不刷新 | 服务端不推送这两类变更事件，需本地乐观更新。补充（8.6 实测）：**置顶**会发一条 `t='message_pinned'` 系统消息（原消息不推更新），客户端以它为信号拉 `chat.getPinnedMessages` 同步 `pinned` 标志；**取消置顶**反而会推原消息更新（`pinned:false`），无系统消息 |
| 只有打开过的会话才收得到推送 | `stream-room-messages` 按房间订阅只覆盖 openRoom 过的房间，没点开过的会话来消息不进通知逻辑（表现为「有的人来消息会提醒、有的不会」）。订阅特殊事件名 **`__my_messages__`** 可收到自己所有房间的消息（8.6 实测有效）；房间级订阅保留兜底，重复送达靠 upsert 幂等 + 通知按消息 id 去重 |
| 文件面板图片打不开/下载报网络失败 | `*.files` 返回的 `url` 是按 **Site_Url** 拼的绝对地址（8.6 实测形如 `http://<Site_Url>/ufs/GridFS:Uploads/...`）。客户端实际连接地址和 Site_Url 不一致（桌面填 IP、Web 走反代）时这个地址根本到不了。凡站内文件端点一律取路径重拼到当前连接地址（`normalizeAssetPath`） |
| 频道未读数一直是 0 | RC 频道默认只有 @ 才累计 `unread`，普通新消息只置 `alert` 标志 |
| Tauri plugin-http 上传 FormData 失败 | 该通道对 FormData 支持不可靠，手工构造 multipart 字节流 |
| 打开任意会话，它就跳到列表最上面 | 会话排序**不能**把 `subscription._updatedAt` 当兜底时间：打开会话本身就会更新订阅（写 `ls`、清 `unread`/`alert`），`_updatedAt` 变成此刻。只取 `room.lm` / `room.lastMessage.ts` |
| 多人直聊混进「单聊」 | RC 里多人直聊的 `t` 仍是 `'d'`，靠 `room.uids.length > 2` 区分（订阅上没有 `uids`）。它的 `fname` 是「张三, 李四」这样拼出来的，也不该拿某个人的头像当会话头像 |
| 桌面端点「下载」没反应 | WebView2 / WKWebView 不认 blob URL 上的 `download` 属性。必须走 `tauri-plugin-dialog` 的「另存为」+ `tauri-plugin-fs` 写文件 |
| `/kick @张三` 被当成普通文本广播出去 | 斜杠命令**必须**由服务端执行（`commands.run`），客户端只负责认出来并转发。RC 提供 27 个命令（`commands.list`），一个都不接的话它们全会变成字面量消息 |
| 禁言找不到 REST 端点 | `channels.muteUser` / `groups.muteUser` 在 RC 8.6.1 **都是 404** —— 这两个端点根本不存在。服务端只在 `/mute` 斜杠命令里实现了禁言，所以只能走 `commands.run` |
| 命令面板显示 `Slash_Shrug_Description` | `commands.list` 返回的 `description` 多半是 **i18n 键名**（27 个里有 24 个），`/status` `/topic` 连 `params` 也是键。官方客户端自带词典去翻，我们没有 —— 得自己配中文表，翻不出来的宁可留空 |
| 对 DM 调 `groups.kick` / `groups.roles` 报 400 | 单聊和多人聊天都是 `t='d'`，**没有**频道那套管理能力（`/mute` 直接报 `d is not a valid room type`）。权限判断必须把房间类型算进去，否则全局 admin 会在多人聊天里看到一堆点了就报错的管理操作 |
| 改密码报 `TOTP Invalid` | `users.updateOwnBasicInfo` 的 `currentPassword` 要传 **SHA-256 十六进制**，传明文会被当成 2FA 校验失败。这个接口限流是**每分钟一次**，所以一次请求必须带齐所有字段 |
| 建了讨论，父频道里没有卡片 | RC 会发一条 `t='discussion-created'` 的消息，`msg` 是讨论名、**`drid`** 指向讨论房间。不认 `drid` 的话它会掉进系统消息的兜底分支，变成一行点不动的灰字 |
| 加入公开讨论报 `error-room-not-found` | 讨论不是普通频道，统一调用 `channels.join` 会失败。优先用 `rooms.join`；仅当旧版服务端返回 404 时回退 DDP `joinRoom`。公开讨论未加入时仍可查看和发言，但只有已加入订阅才参与通知与已读同步 |
| 私聊的永久链接是死链 | DM 的**房间文档没有 `name`/`fname`**（名字只在订阅上），照着 `room.name` 拼会得到 `/direct/?msg=xxx`。DM 要用 rid。另：RC 8.6.1 没有 `chat.getPermalink` 这个 REST（实测 404） |
| `:cowboy:` 这类 emoji 打不出来 | RC 用的是 JoyPixels/emojione 的 shortcode 体系（`chat.react` 的 key 就是 `:code:`）。手写表必然漏，由 `pnpm gen:emoji` 从 emoji-toolkit 生成全量 6198 个（含别名） |

### 客户端自己的坑

| 现象 | 原因与对策 |
| --- | --- |
| 打开某个面板整个页面白屏 | zustand 的选择器里写 `s.foo[id] ?? []` —— 那个 `[]` 每次调用都是新数组，`useSyncExternalStore` 认为状态一直在变，无限循环把组件搞崩（React 报 `The result of getSnapshot should be cached`）。选择器必须返回**稳定引用**，`?? EMPTY` 挪到选择器外面 |
| 界面永远停在「加载中…」，控制台还干干净净 | 开发服务器上 Vite 可能把同一个模块以多个 `?t=` 版本发出来，store 被实例化成好几份：调 `load()` 的是一份，界面读的是另一份。**别让加载只发生在某个组件挂载时**——谁依赖 `loaded`，谁就负责触发加载（配合 in-flight 去重，重复调用不会多打请求）。再加超时 + 可见的错误 + 重试，静默卡死是最难查的 |
| 冒烟测试全绿但界面是坏的 | 冒烟只打 API，测不到渲染。改完 UI 要真在浏览器里点一遍 |

### 本地数据（Rocket.Chat 没有对应模型）

这几项 RC 服务端没有存储位置，只能存在本机存储，换设备不同步——这是刻意的取舍，
换成「存到服务端」就得改 RC，违背兼容性前提。

| 功能 | key | 说明 |
| --- | --- | --- |
| 自定义分组 | `rcx-folders` | 含规则（前缀/包含/正则自动归组）。订阅变化时会 `prune` 掉已失效的 rid，否则计数虚高 |
| 备注名 | `rcx-aliases` | `u:<username>` 跟人走，`r:<rid>` 跟会话走（多人直聊主要靠它） |
| 待办 | `rcx-todos` | 锚定 `rid + mid`，可跳回原消息；存了消息快照，原消息删了也看得懂 |
| 最近表情 | `rcx-recent-emojis` | |
| ADO 工作台配置 | `rcx-workbench` / `rcx-ado-web` | 跟 Rocket.Chat 账号与服务器隔离；直连 PAT 只留在当前设备 |
| ADO 自定义查询 | `rcx-custom-queries` | 跟 Rocket.Chat 账号隔离，再按稳定的 ADO 基址与认证方式分区；旧查询只在匹配连接后认领 |
| 管家 Codex 工作区设置 | `rcx-codex-workspace-v1:<scope>` | 按 Rocket.Chat 服务器与账号保存工作区、模型、推理强度、权限档和后续消息模式；Thread/Turn 正文由 Codex Home 管理，不写入该 key |
| AI 托管 Codex 设置 | `rcx-agent-hosting-v1:codex-*` | 共享 Agent 独立保存模型、推理强度和权限档；权限默认“替我审批” |
| AI 托管后端与 DSH 会话 | `rcx-agent-hosting-v1:*` + DSH Home | RocketX 保存会话所选后端和原生 ID；DSH 自己保存 Session、默认模型/Agent/权限，并把托管密钥写入私有 `.credentials.yaml`，RocketX 不复制密钥或配置正文 |
| 已安排任务 | `rcx-codex-automations-v1:*` | 保存本机计划、版本、触发游标与最近结果；只在 RocketX 进程存活且 Codex 可用时执行，不跨设备同步 |
| 本地 Agent 环境 | `rcx-agent-environments` | 保存用户明确允许共享 Agent 使用的目录、项目映射和活动绑定；一个环境不能同时绑定两个活动 Discussion |
| Codex Memory | Codex Home（例如 `~/.codex/memories`） | 由 Codex 原生管理；RocketX 在 Thread 启动前请求启用，不维护独立用户画像库，也不与 ChatGPT Web Memory 混用 |
| LAN 设备信任 | IndexedDB `appData` + OS keychain | 公钥按服务器/用户/设备固定；Ed25519 私钥只进系统凭据库，mDNS/UDP 广播永远不直接建立信任 |
| LAN 离线消息 | IndexedDB `outbox` | 作者保存稳定 `_id` 并负责回灌；接收方只保存本地副本，避免代发造成身份错误和重复消息 |

### M9 LAN 数据面

- `_rcx._tcp.local` mDNS 为主发现，`239.255.82.67:45826`、TTL 1 的 UDP 组播为兜底；两者只产生不可信候选。
- TCP 连接先用双方随机 nonce、服务器指纹、用户/设备 ID 和公钥组成摘要，再做 Ed25519 双向签名；只有与 Rocket.Chat 认证通道固定值完全一致的公钥可通过。
- 文件固定 1 MiB 分片、最多四路 TCP；接收端在应用数据目录保存 `.part` 与缺块清单，断线重连只请求缺失索引。每片 BLAKE3 通过才写入，整文件 BLAKE3 通过才发布。
- 普通消息使用稳定 `_id`。服务器恢复后只有作者回灌；重复请求即使返回 500，也会按 `_id` 回查确认是否已落库。

### 中文环境必须的服务端设置

连接已有 Rocket.Chat 服务器时，请在管理后台调整（本仓库 dev compose 已内置）：

| 设置 | 值 | 原因 |
| --- | --- | --- |
| `UTF8_Channel_Names_Validation` | `[0-9a-zA-Z-_.一-龥぀-ヿ]+` | 默认不允许中文群组/频道名 |
| `Message_AlwaysSearchRegExp` | `true` | Mongo 文本索引不切分中文，默认搜索搜不到子串（如搜「你」找不到「你好」）；改用正则子串匹配。大数据量下正则搜索无索引、较慢，重度使用可后续接 ElasticSearch 类搜索服务 |
| `Accounts_TwoFactorAuthentication_By_Email_Enabled` | 按需 `false` | 新用户默认邮箱验证码拦截登录（无邮件服务的内网环境无法收码） |

### 验证手段

界面上手点测不出的东西，靠这几个跑：

| 命令 | 覆盖 |
| --- | --- |
| `pnpm smoke` | 打真实 Rocket.Chat 的读写主流程；会修改测试数据并在结束时尝试还原 |
| `pnpm test:pure` | 纯函数、数据转换与安全边界 |
| `pnpm test:regression` | 消息、搜索、工作台、Codex Runtime、管家、Skills、Memory、已安排、共享 Agent 与桌面桥接回归 |
| `pnpm test:ui` | 核心浏览器交互；mock 通过不能替代真实 Rocket.Chat、ADO 或 Codex 集成 |
| `pnpm smoke:codex-lifecycle` | 使用真实 Codex 验证 `app-server`、Thread、Turn、恢复和停止生命周期 |
| `pnpm test:classify` | 打真实 Rocket.Chat 的房间分类与排序检查 |

**自动测试跑绿不等于所有界面都是好的。** `test:ui` 覆盖核心浏览器流程；没有进入这些
流程的界面仍要真正在浏览器或桌面端点一遍。

Vite HMR 会导致 store 模块分叉（`window.__chat` 与界面里的 store 可能不是同一个实例），
所以状态断言一律走上面这些脚本，不在浏览器控制台里验。

### 已知限制

- 登录不支持双因素认证（2FA）账号；
- 不做会议与云文档（占位页与导航项已移除）；日历是自研的本地日历，不接外部日历服务；
- 已读回执依赖企业版 API，社区版不可用（启动时读设置，直接不请求）；
- 没做：语音消息、消息翻译、端到端加密 / OTR、音视频通话、
  客服（Omnichannel）、管理后台、邀请链接、批量清理消息（prune）；
- 单聊 / 多人聊天没有群管理能力（这是 RC 的模型限制：它们都是 `t='d'`）；
- 分组、备注名、待办只存本机（见上方「本地数据」）。
- 管家与共享 Agent 当前只在桌面端运行；Codex 路径要求兼容且已登录的本机 Codex，DeepSeek 路径要求系统 Node.js、随包 DSH 和已配置密钥。原生 Memory、Skills/Plugins/Apps、已安排执行仍只属于 Codex；网页版没有远端执行面。
- 已安排任务不是操作系统或云端常驻调度，RocketX 真正退出、电脑关机或休眠时不执行。
