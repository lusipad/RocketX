# RocketChat X

以**原版 Rocket.Chat 为内核**、体验对标**飞书**的团队协作客户端。

Rocket.Chat 服务端一行不改：本项目只通过其公开 REST API 与实时 WebSocket API 通信，
官方版本可随时升级，原生客户端可共存登录，数据完全兼容。

```
┌─────────────────────────────────────┐
│   RocketChat X 客户端（本仓库）        │
│   消息 │ 日历 │ 云文档 │ 工作台 │ …    │
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

## 桌面客户端

GitHub Actions 自动构建 Windows（msi/nsis）、macOS（dmg，universal）、Linux（deb/rpm/AppImage）安装包：

- **打标签发版**：`git tag v0.1.0 && git push --tags` → 自动构建并创建草稿 Release；
- **手动构建**：Actions 页面运行 `Desktop Build` workflow → 从 Artifacts 下载安装包；
- **本地开发**：`pnpm --filter @rcx/desktop dev`（需要 [Rust 工具链](https://tauri.app/start/prerequisites/)）。

桌面端在登录页填写 Rocket.Chat 服务器地址直连。服务器需开启 CORS：
`API_Enable_CORS = true`、`API_CORS_Origin = *`（本仓库 docker-compose 已内置）。
头像若显示为首字块，可关闭服务器的 `Accounts_AvatarBlockUnauthenticatedAccess`。

## 已实现

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
- 表情选择器（回应 + 输入插入），50 个常用 emoji 与 RC 短代码互通
- 话题（线程）面板：查看根消息与全部回复、面板内回复、主消息流回复数入口
- @提及自动补全（成员缓存 + @all/@here，键盘上下选择）
- 图片 / 文件上传（rooms.media），图片缩略图与文件卡片渲染
- 轻量 Markdown：粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 提及与频道高亮
- 历史消息向上翻页（滚动到顶自动加载，保持视口位置）
- 桌面通知（非活跃会话新消息）+ 标题栏未读总数 + 回到底部按钮

**M3 · 工作台（Azure DevOps Server 2022）**

- 工作台模块：我的工作项（类型色点/优先级/状态，WIQL 查询）、待我评审的 PR、
  我创建的 PR，点击直达 ADO；ado-bridge 作查询代理，PAT 不进客户端
- 消息里的 `#工作项号` 自动链接到 ADO 工作项
- 本地联调 mock ADO 服务（`services/ado-bridge/mock/`）

**M2.7 · 飞书网页版框架与会话管理**

- 整体布局对齐飞书网页版：深色宽导航栏（头像、发起会话 ➕、全局搜索入口、
  模块行 + 未读角标）→「分组」过滤栏（消息/未读/@我/单聊/群组）→ 深色会话列表 → 浅色内容区
- 会话右键菜单：置顶会话（列表置顶排序 + 图钉标识）、消息免打扰（不弹通知、
  角标转灰、铃铛标识）、标为已读、隐藏会话
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
- **M3.5 · 工作台进阶**：工作项卡片悬停预览、聊天内评论工作项、构建/发布状态面板
- **M4 · 桌面端**（基础已完成：Tauri 壳 + CI 构建三平台安装包 + 服务器地址配置）：
  后续补系统托盘、原生通知、自动更新
- **M5 · 套件扩展**：日历、云文档（评估 CRDT 方案）、音视频会议（对接 RC 会议能力）

## 兼容性承诺

- 只使用 Rocket.Chat 公开 API（`/api/v1/*`、`/websocket`），目标版本 6.x/7.x；
- 不改动服务端、不私建数据表；扩展能力（如 ADO 桥）全部以外围服务实现；
- 任何时候都可以用官方客户端登录同一服务器，数据互通。
