# RocketChat X

以**原版 Rocket.Chat 为内核**、体验对标**飞书**的团队协作客户端。

核心主旨：**团队版 GTD 可信系统**——GTD 管"承诺怎么处理"，注意力保护管"信息怎么到达"，
AI 管家承担理清与回顾，Agent 延伸执行（详见 [`docs/blueprint.md`](docs/blueprint.md)）。

Rocket.Chat 服务端一行不改：本项目只通过其公开 REST API 与实时 WebSocket API 通信，
官方服务端可独立升级（升级前对照下方「兼容性承诺」的已验证版本矩阵），原生客户端可共存
登录，数据完全兼容。

```
┌─────────────────────────────────────┐
│   RocketChat X 客户端（本仓库）        │
│ 消息 │ 管家 │ 待办 │ 日历 │ 工作台 │ 通讯录 │
└────────┬───────────────┬────────────┘
         │ REST / WS     │ Webhook
┌────────▼──────┐  ┌─────▼──────────────┐
│  Rocket.Chat  │  │  ado-bridge        │
│  （原版不改）  │◄─┤  Azure DevOps      │
└───────────────┘  │  Server 2022 事件  │
                   └────────────────────┘
```

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/web` | 飞书风格 Web 客户端（React + Vite + Tailwind） |
| `apps/desktop` | 桌面客户端（Tauri 2 壳，复用 web 构建产物） |
| `packages/rc-client` | Rocket.Chat API SDK（REST + 实时 WebSocket，零依赖） |
| `services/ado-bridge` | Azure DevOps Server 2022 Service Hooks → 消息卡片桥接服务 |
| `docker/` | 本地 Rocket.Chat 开发环境（原版镜像 + MongoDB 副本集） |
| `docs/` | 架构决策记录 |

项目资料：[`CHANGELOG.md`](CHANGELOG.md) · [`架构决策`](docs/architecture.md) ·
[`实施记录`](docs/implementation-notes.md) · [`后续蓝图`](docs/blueprint.md) ·
[`质量审查`](docs/quality-audit.md) · [`MIT License`](LICENSE)

## 快速开始

```bash
# 1. 启动 Rocket.Chat（已有服务器可跳过，改配 RC_URL 即可）
docker compose -f docker/docker-compose.yml up -d
# 开发实例跑在 http://localhost:3300，已自动创建管理员 admin / rcxdev123

# 2. 安装依赖
pnpm install

# 3. 启动客户端（默认代理到 http://localhost:3300，
#    连接其他服务器：在 apps/web/.env 里设置 RC_URL）
pnpm dev
# 打开 http://localhost:5173，用 Rocket.Chat 账号登录
```

接入 Azure DevOps Server 2022 通知见 [`services/ado-bridge/README.md`](services/ado-bridge/README.md)。

桌面端全新安装会先显示「加入团队」：可从本地文件或无需登录的 HTTP(S) / Git Raw URL
导入不含凭据的 `rcx.workspace.json`，确认 Rocket.Chat、ADO、AI、模板和更新源等默认值后，
再在本机填写密码、PAT 与 API key。URL 团队配置每 24 小时检查一次，有变化时先展示差异，
不会静默覆盖。可直接复制 [`配置示例`](docs/examples/rcx.workspace.sample.json)，字段与安全规则见
[`团队配置说明`](docs/proposal-config-provisioning.md)。

登录后可从左侧进入「管家」，用自然语言搜索消息与工作数据、查询 ADO 工作项/PR/构建、
生成工作项草案或运行例行复盘；所有创建操作仍需在现有创建窗口中确认。桌面端可让管家使用
本机 Codex CLI，也可把管家或群托管对话转进 Codex App / CLI 的原生线程列表继续处理。
管家与 AI 托管可在「设置 → AI」分别选择 Codex 模型和推理强度；DeepSeek 等 Provider
与密钥也在这里配置，密钥只进入操作系统凭据库。托管会话中被 `@ai` 请求引用到的图片会
下载到会话隔离缓存，并作为图片输入交给 Codex。

随 Windows 发布包提供的「飞鸽 / IPMSG」官方插件默认关闭，可随时禁用。协议、GBK 编码、UDP/TCP `2425`、消息和普通文件传输都在插件自己的 Rust Sidecar 中，RocketX 核心只提供通用进程桥。标准 IPMSG/飞鸽支持消息与文件；原版内网通仅支持 `1@shiyeline` 的 2425 发现和文本，不实现私有 `9011`。该旧协议能力不等同于 RocketX 的认证 LAN 通道。

## 测试

界面上手点测不出来的东西（Vite HMR 会让 store 模块分叉，浏览器里断言状态不可靠），
一律靠脚本：

```bash
pnpm smoke          # 53 项，打真实 RC：认证/会话/消息/引用/线程/讨论卡片/
                    # 文件上传下载/中文搜索/置顶免打扰/通讯录/实时推送/
                    # 斜杠命令/群管理（踢人·角色·禁言·归档·只读）/
                    # 文件与提及面板/改昵称与头像
pnpm test:pure      # 221 项纯函数：拼音、日期、分组规则、待办、emoji、
                    # markdown、日历重复、ADO、斜杠命令、群管理与安全边界
pnpm test:regression # 585 项回归：搜索并发、目录/成员分页、讨论访问与初始滚动、
                     # ADO 链路、管家/Codex、团队配置、更新源、共享 Agent 与 LAN/outbox
pnpm test:ui        # 41 项浏览器流程：登录、消息、首次引导、AI 设置、分组栏、ADO 卡片、待办链接与插件 Bridge
pnpm test:ecosystem # SDK、CLI clean-room 脚手架与官方样例
pnpm test:classify  # 5 项，打真实 RC：单聊/多人直聊/群组分类、会话排序

# M9 两套独立设备身份的四流 TCP、续传与 BLAKE3；5 GiB 实测见 docs/m9-validation.md
ROCKETX_LAN_E2E_BYTES=5368709120 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked tcp_file_transfer_resumes_across_four_authenticated_streams -- --nocapture

# M10 插件 Sidecar 协议测试；官方 IP Messenger 5.8.3 真实验收步骤见 docs/m10-validation.md
cargo test --manifest-path plugins/intranet-link/native/Cargo.toml --locked --no-fail-fast

RC_BASE_URL=http://chat.example.com pnpm smoke   # 默认 localhost:3300，admin/rcxdev123
```

`smoke` 会做真的写操作（踢人、禁言、归档、改昵称、传头像），**跑完全部还原**：
改的名字改回去、头像 `resetAvatar`、建的房间删掉。

改动 rc-client 或服务端设置后跑一次 `pnpm smoke`。`test:pure`、`test:regression`、
`test:ui` 与 `test:ecosystem` 已接入 CI。

> **自动测试跑绿不代表所有界面都是好的。** `test:ui` 覆盖核心浏览器流程，但没覆盖到的
> 交互仍需真正在浏览器或桌面端点一遍。

## 桌面客户端

当前稳定化阶段，GitHub Actions 只构建 Windows x64（msi/nsis）正式安装包；macOS 与 Linux
源码目标继续保留，待平台验收稳定后再恢复官方安装包与自动更新：

- **正式发版**：推送 `release/vX.Y.Z` 临时分支 → workflow 自动创建同名标签、删除临时分支，
  并构建 Windows 安装包与草稿 Release；标签只接受最新 `main` 与一致版本，进入 1.0 及以上时
  还会强制核验两位外部开发者证据和真实 README 截图/GIF；
- **公开发布**：复核草稿后手动运行受保护的 `Publish GitHub Release`；公开工作流以非 Latest
  方式发布 `v0.29.1`，Windows 用户在公开后从 Release 页面手动下载，`v0.28.0` 暂时保留为跨平台 Latest；
- **npm 包（按需）**：公开 SDK/CLI 变更需要 npm 交付时，独立运行受保护的
  `Publish npm packages`，按 SDK → CLI 顺序发布；npm 不阻塞桌面安装包与 GitHub Release；
- **手动构建**：Actions 页面运行 `Desktop Build` workflow → 从 Artifacts 下载安装包；
- **本地开发**：`pnpm --filter @rcx/desktop dev`（需要 [Rust 工具链](https://tauri.app/start/prerequisites/)）。

共享 Agent 需要已安装并登录的兼容 Codex CLI。它直接使用用户选择的本地工作目录与 Codex
原生沙箱、审批和会话能力，不再构建或运行 Agent Runner Docker 镜像。

桌面端在登录页填写 Rocket.Chat 服务器地址直连。服务器需开启 CORS：
`API_Enable_CORS = true`、`API_CORS_Origin = *`（本仓库 docker-compose 已内置）。
头像若显示为首字块，可关闭服务器的 `Accounts_AvatarBlockUnauthenticatedAccess`。

完整发布证据格式与不可逆步骤见 [`docs/release/README.md`](docs/release/README.md)。

## 已实现

> 以下为已完成里程碑（M1~M5 及其子里程碑）的存档记录，仅作历史参考。
> 后续规划见 [`docs/blueprint.md`](docs/blueprint.md)。

**M5 · Rocket.Chat 原生能力补齐**

- **斜杠命令**：输入框识别 `/`，从服务器拉命令表做补全（27 个，可滚动），回车交给
  服务端执行。认不出的命令**拦下不发** —— 打错一个字母不该把 `/kick @张三` 广播成
  一条文本消息。`/usr/bin/env`、`/或者这样` 这类正常文本不会被误判成命令。
  话题里同样拦截
- **群管理**：重命名、踢人、设/撤群主与管理员、禁言、归档、设为只读、解散群。
  成员列表显示角色徽标并按角色排序。权限两层判断（全局 admin + 房间角色），
  管理员踢不了群主；单聊 / 多人聊天（RC 里都是 `t='d'`）没有这些能力，界面直接不给
  —— 服务端对 DM 调 `groups.kick` / `/mute` 一律报错
  <br>*禁言只能走斜杠命令：RC 8.6.1 的 `channels.muteUser` / `groups.muteUser`
  都是 404，这两个 REST 端点根本不存在，服务端只在 `/mute` 里实现了*
- **个人资料**：上传头像、改昵称、改密码（`currentPassword` 要传 SHA-256 十六进制，
  传明文会被当成 2FA 失败）
- **文件面板 / 提及我的面板**：右侧面板新增两项。「提及我的」列的是消息，跟侧栏那个
  会话级的「@我」筛选器不是一回事
- **讨论卡片**：群里建讨论后，父频道里出现可点的卡片（讨论名、发起人、消息数），
  而不是一行灰字
- **复制消息链接**：消息右键。RC 8.6.1 没有 `chat.getPermalink`（实测 404），
  按它的路由规则拼

**M1 · IM 核心**

- 登录 / token 续期，退出
- 飞书式三栏布局：模块导航栏 + 会话列表 + 聊天区
- 会话列表：头像、最新消息预览、时间、未读角标、本地搜索
- 消息：气泡分组（同人 5 分钟内合并）、日期分割线、系统消息
- 富文本附件卡片（承载 ADO 事件通知等集成消息）
- 实时收发：新消息 / 编辑 / 回应即时推送，断线自动重连并恢复订阅
- 已读同步（打开会话与收到消息时自动上报）
- Azure DevOps Server 2022 事件桥：工作项 / PR / 推送 / 构建 / 发布 → 消息卡片

**M2 · IM 进阶**

- 消息悬浮操作栏：表情回应 / 话题回复 / 复制 / 编辑（行内）/ 删除（两步确认）
- 表情选择器（回应 + 输入插入），全量 emoji 与 RC 短代码互通（见 M4）
- 话题（线程）面板：查看根消息与全部回复、面板内回复、主消息流回复数入口
- @提及自动补全（成员缓存 + @all/@here，键盘上下选择）
- 图片 / 文件上传（rooms.media），图片缩略图与文件卡片渲染
- 轻量 Markdown：粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 提及与频道高亮
- 历史消息向上翻页（滚动到顶自动加载，保持视口位置）
- 桌面通知（非活跃会话新消息）+ 标题栏未读总数 + Windows 任务栏/托盘未读提醒 + 回到底部按钮

**M4 · 待办、备注名、群信息、分组规则、文件预览**

- **待办模块**：消息右键「标记为待办」，可写说明、设截止日期；左栏按 待办/今天/
  逾期/已完成 分类，逾期标红并在导航栏出角标；点待办**跳回原消息**（脱离上下文
  的待办没人会做）
- **备注名**：给联系人和会话起备注（含多人直聊），会话列表 / 聊天头部 / 通讯录 /
  @补全全部生效，且能被拼音搜到
- **群信息面板**：头像、公告、话题、介绍（就地编辑，没有管理权限的人只读）、成员、
  收藏 / 免打扰 / 退出。聊天头部补上头像，点击即开
- **分组规则**：按名称前缀 / 包含 / 正则**自动归组**（如「WI」开头的工作项会话），
  写规则时实时预览命中哪些会话，与手工拖入并存
- **文件预览**：txt / md / json / 代码 / PDF 点击直接看，不必先下载。Markdown 走
  文档级渲染（标题、任务列表、表格）
- **拼音搜索**：`zs` / `zhangsan` 都能找到「张三」，覆盖 @补全、通讯录、Ctrl+K
- **全量 emoji**：6198 个 shortcode（与 RC 的 JoyPixels 体系一致），`:cowboy:` 不再打不出来

**M3.7 · IM 核心交互（P0）**

- **引用回复**：悬浮栏/右键「回复」→ 输入框上方引用条（可取消）→ 消息内引用卡片
  （走 RC 官方消息链接机制，官方客户端同样可见）
- **乐观发送**：消息秒上屏，发送中转圈、失败红色感叹号可重试/放弃
- **正在输入**：会话头部显示「xx 正在输入…」（user-activity 流，8 秒自动过期）
- **链接卡片预览**：URL 自动展开标题/描述/缩略图（服务端 OEmbed）
- **群加人**：成员面板 ➕ 搜索邀请
- **删除语义**：消息菜单统一显示「删除」，执行前二次确认
- 已读回执（已实现，需 RC 企业版服务器；社区版自动降级隐藏）

**M3.6 · 基础体验修复与补全**

- 桌面端图片/头像/文件认证加载（blob 通道），图片点击灯箱放大 + 下载
- 文件消息卡片（图标/大小/带认证下载）；上传改手工 multipart（桌面端稳定）
- 表情：消息内 `:emoji:` 直接渲染，RC 自定义表情（emoji-custom）以图片渲染，
  表情回应同步支持
- Markdown 补全：`[文字](链接)`、`> 引用`、`- 列表`、URL 中文标点截断修复
- 讨论（Discussion）与群组区分：列表「讨论」标签、头部「来自 xx」跳回主会话、
  消息右键「创建讨论」；未加入的公开讨论也可查看和发言，加入后才启用订阅通知
- 会话排序：分组栏设置 → 按时间 / 未读优先
- 全局搜索（Ctrl+K）：会话 / 消息（默认先查本机与当前会话，点击“搜索全部”后再用服务端
  全局搜索或逐会话渐进回退，消息结果滚动到底自动续页）/ 联系人与频道
  （未加入的公开频道可直接加入）
- 工作台支持**直连 Azure DevOps**（无需 ado-bridge）：桌面端走 Rust 通道开箱即用，
  PAT 仅存本机；网页端保留桥接模式

**M3 · 工作台（Azure DevOps Server 2022）**

- 工作台模块：我的工作项（类型色点/优先级/状态、父子层级折叠，WIQL 查询）、待我评审的 PR、
  我创建的 PR、最近构建（成功/失败/进行中状态），点击直达 ADO；
  ado-bridge 作查询代理，PAT 不进客户端
- 消息里的 `#工作项号`、ADO 工作项/PR/构建链接自动展开详情卡片；工作项卡片内可直接
  **快速评论**（写入 ADO 讨论区）
- 本地联调 mock ADO 服务（`services/ado-bridge/mock/`）
- 直连模式可从聊天创建工作项；工作项类型与父子层级按项目过程动态加载，可选同时创建讨论组

**M2.7 · 飞书网页版框架与会话管理**

- 整体布局对齐飞书网页版：深色宽导航栏（头像、发起会话 ➕、全局搜索入口、
  模块行 + 未读角标）→「分组」过滤栏（消息/未读/@我/单聊/群组）→ 深色会话列表 → 浅色内容区
- 会话右键菜单：置顶会话（列表置顶排序 + 图钉标识）、消息免打扰（不弹通知、
  角标转灰、铃铛标识）、标为已读、隐藏会话；隐藏会话有独立分组，可恢复并打开
- 消息标记（星标）：右键消息「标记」，头部 ⋯ →「标记消息」面板集中查看

**M2.6 · 通讯录与会话发起**

- 通讯录模块：成员目录（搜索、总数）、我的群组（搜索、成员数、公开/私有标识）
- 个人卡片：点任意头像（消息流/成员面板/通讯录）弹出，一键「发消息」发起私聊
- 会话列表 ➕ 菜单：发起私聊（用户搜索）、创建群组（选成员、公开/私有）
- 中文群组名支持（需要服务端设置 `UTF8_Channel_Names_Validation` 放行 CJK，
  本仓库 docker-compose 已内置；连接已有服务器时需在管理后台调整）
- 中文消息搜索（需要服务端开启 `Message_AlwaysSearchRegExp`，用正则子串匹配
  替代 Mongo 文本索引——中文没有空格分词，默认索引搜不到子串；compose 已内置）

**M2.5 · 飞书式交互**

- 消息右键菜单（回复 / 转发 / 复制 / 置顶 / 编辑 / 删除）
- 悬浮栏快捷表情（👍 ✅ 🎉 直达）+ 转发 + 更多菜单
- 消息置顶 + Pin 列表面板（头部图钉入口）
- 转发弹窗：搜索、多选会话、内容预览（飞书同款交互）
- 群成员面板（点头部成员数打开，支持搜索、在线状态）
- 聊天记录搜索面板（中文子串搜索已支持，依赖服务端开启正则搜索，见下）
- 会话草稿：自动保存/恢复，列表显示红色 [草稿] 前缀
- 未读体验：@/私聊显示数字角标、频道新消息显示红点、
  打开会话显示「以下为新消息」分割线
- Ctrl/Cmd + K 快速切换会话
- 粘贴 / 拖拽 / 按钮上传统一走「发送给 xx」确认预览弹窗
- Esc 关闭面板、拖拽悬浮提示、删除二次确认弹窗

## 路线图

唯一路线图入口：[`docs/blueprint.md`](docs/blueprint.md)（v2，2026-07-17）——核心主旨
（GTD + 注意力保护双支柱）、可判定目标、M6~M11 里程碑定义与稳定化轨道都在那里。概览：

- **M6** 扩展内核 → **M7** AI 管家 + 统一收件箱「今日」 → **M8** 共享 Agent 会话（$codex）
  → **M9（v0.18.0）** LAN 直传 / 断网降级 → **M10（v0.19.0）** IPMSG 共存 → **M11（v0.20.0）** 开源发布与应用生态 v0；1.0 成熟度验收后置
- 工作台再进阶（原 M3.5）与桌面自动更新已并入蓝图的稳定化轨道 T
- 云文档、音视频会议不开发（导航项已移除）

## 兼容性承诺

- 只使用 Rocket.Chat 公开 API（`/api/v1/*`、`/websocket`）；已验证版本 **8.6.x**（dev 环境
  8.6.1，docker 镜像已固定），其他版本按「已验证版本矩阵」逐步扩充，升级服务端前先对照矩阵；
- 不改动服务端、不私建数据表；扩展能力（如 ADO 桥）全部以外围服务实现；
- 任何时候都可以用官方客户端登录同一服务器，数据互通。
