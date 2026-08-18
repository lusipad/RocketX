# RocketX

[English](README.en.md)

以**原版 Rocket.Chat 为内核**、体验对标**飞书**的团队协作客户端。

核心主旨：**团队版 GTD 可信系统**——GTD 管“承诺怎么处理”，注意力保护管“信息怎么到达”。消息、工作台、待办和日历承载确定性事实；管家使用启动时选定的单一 AI 运行时执行与协助。

Rocket.Chat 服务端一行不改：本项目只通过其公开 REST API 与实时 WebSocket API 通信，官方服务端可独立升级，原生客户端可共存登录，数据完全兼容。

```text
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

## 什么是 RocketChat X

- **团队消息**：基于现有 Rocket.Chat 服务器，提供飞书风格三栏布局、话题、表情回应、@提及、文件共享和讨论卡片。
- **GTD 工作界面**：收件箱、待办、日历、通讯录，以及可直连 Azure DevOps Server 2022 的工作台。
- **本地 AI 运行时**：启动时三选一——OpenAI Codex、DeepSeek Harness（DSH）或无 AI。选择全局生效、重启后生效，不会同时启动两个后端。
- **共享 Agent 托管**：在房间和讨论中开启共享 AI 托管，使用同一启动级运行时；Web 版和无 AI 客户端可查看有效远端托管并使用 `@ai`，但无法本地开启或恢复。
- **LAN 连续性**：通过认证点对点链路和可选的 Windows IPMSG/内网通 Sidecar 插件保持局域网连通。

当前用户可见行为以[`功能规格`](docs/specs/README.md)为准；[`产品原则`](docs/specs/product-principles.md)解释 GTD、注意力保护和 AI 边界；[`终局设想`](docs/vision.md)与[`产品蓝图`](docs/blueprint.md)仅保留方向和历史演进，不是当前路线图或交付承诺。项目资料：[`CHANGELOG.md`](CHANGELOG.md) · [`架构决策`](docs/architecture.md) · [`兼容性承诺`](docs/compatibility.md)。

## 快速开始

开发环境使用 Node.js **22.19+** 与 **pnpm 11.12.0**。桌面开发还需要 Rust 稳定工具链和 [Tauri 前置条件](https://tauri.app/start/prerequisites/)。

```bash
# 1. 安装依赖
corepack enable
pnpm install --frozen-lockfile

# 2.（可选）启动本仓库绑定的 Rocket.Chat 开发服务器
docker compose -f docker/docker-compose.yml up -d
# 开发实例跑在 http://localhost:3300，已自动创建管理员 admin / rcxdev123

# 3. 启动客户端（默认代理到 http://localhost:3300）
pnpm dev
# 打开 http://127.0.0.1:1420，用 Rocket.Chat 账号登录
```

连接其他服务器：在 `apps/web/.env` 里设置 `RC_URL`。

桌面端开发：

```bash
pnpm --filter @rcx/desktop dev
```

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `apps/web` | 飞书风格 Web 客户端（React + Vite + Tailwind），桌面端复用同一构建产物。 |
| `apps/desktop` | 桌面客户端（Tauri 2 壳，原生集成与 Rust Sidecar 托管）。 |
| `apps/dsh-runtime` | Windows full 构建与发布验证使用的私有 DSH 运行时包，精确锁定官方发布版本。 |
| `packages/rc-client` | Rocket.Chat API SDK（REST + 实时 WebSocket，零依赖）。 |
| `packages/app-sdk` | 公共 `@lusipad/rocketx` JSON-RPC Bridge 与应用清单契约。 |
| `packages/create-rcx-app` | 应用脚手架、校验与本地预览 CLI。 |
| `services/ado-bridge` | Azure DevOps Server 2022 Service Hooks → 消息卡片桥接服务。 |
| `examples/` | RocketX 应用示例（`hello`、`kanban`、`poll`、`oncall`）。 |
| `docker/` | 本地 Rocket.Chat 开发环境（原版镜像 + MongoDB 副本集）。 |
| `docs/` | 功能规格、架构决策与发布证据。 |

## 开发

桌面端全新安装会先用 GTD 流程说明 RocketX 如何可靠捕获、理清下一步并保护注意力，再进入团队或个人设置。

### 加入团队

选择「加入团队」时，可从以下来源导入**不含凭据**的 `rcx.workspace.json`：

- 本地文件；
- UNC 共享路径；
- 无需登录的 HTTP(S) / Git Raw URL；
- 复用当前凭据的 Azure DevOps Git 文件链接。

文件提供 Rocket.Chat、ADO、工作项模板、层级布局和更新源等团队默认值。凭据永不进入配置文件或来源记录。URL 与 ADO 团队配置每 24 小时检查一次，有变化时先展示差异，不会静默覆盖。可直接复制 [`配置示例`](docs/examples/rcx.workspace.sample.json)，字段与安全规则见[`团队配置说明`](docs/proposal-config-provisioning.md)。

### AI 运行时选择

在**设置 → AI** 里只能在 Codex、DSH 和无 AI 之间三选一；保存后要重启 RocketX 才生效，当前进程不会热切换，也不会同时启动两个后端。这个全局选择会同时决定管家本地执行、私人房间 AI、新开或恢复 AI 托管、`/ai` 和消息交接使用哪一个后端。

- **Codex** 需要已安装并登录的兼容本地 Codex Runtime；继续复用原生 Thread、模型、权限、Skills、Plugins、Apps、本地 Memory 以及 Codex 专属的 routines / runtime probes。
- **DSH** 在 slim 安装中依赖系统里已安装且已被 RocketX 验证为 `0.1.0-rc.6` 的 DSH；Windows full 回退到安装包内固定的 DSH 与私有 Node。管家中启动官方 DSH Web 并以 iframe 嵌入；RocketX 只保留桌面外壳、房间侧栏和托管的 controller/host 路径以及 DSH 进程生命周期。官方 DSH Web 负责模型、Agent preset、权限、审批、提问和凭据配置。
- **无 AI** 不会启动本地执行器，但管家入口和既有共享托管记录仍保留；如果另一台设备正在托管，房间成员仍能看到状态并使用 `@ai`，本机的新开、恢复和执行动作保持禁用。

当前桌面官方包拆成 slim 与 Windows full：slim 只探测系统里已安装的 Codex / DSH，不随包携带这两个运行时；Windows full 会把固定的 Codex 0.144.4、DSH 0.1.0-rc.6、私有 Node 和 OCR 装到 `%LOCALAPPDATA%\RocketX\resources`，并由 full 安装包管理这些私有资源。已安排任务仍只走 Codex，且仅在 RocketX 运行且本设备在线时由本地计时器触发。具体边界见[`能力矩阵`](docs/specs/capability-matrix.md)。

### 用 Docker 自托管（可选）

前置：Docker Engine 或 Docker Desktop with Compose v2。

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
```

打开 <http://localhost:8080>。本地堆栈会创建开发账号 `admin` / `rcxdev123`；在暴露到本地以外之前请修改所有凭据。Rocket.Chat 管理后台和官方客户端仍可直接访问 <http://localhost:3300>。

Compose 文件固定了 Rocket.Chat、MongoDB、Node、pnpm 和 Nginx 版本，仅用于本地或评估基线，不是生产 TLS 或备份配置。升级服务端前先看[`兼容性说明`](docs/compatibility.md)。

停止堆栈但不删除 MongoDB 数据：

```bash
docker compose -f docker/docker-compose.yml down
```

## 测试

```bash
pnpm typecheck        # 全仓库类型检查
pnpm test:pure        # 237+ 项纯函数：拼音、日期、分组规则、待办、emoji、markdown、日历重复、ADO、斜杠命令、群管理与安全边界
pnpm test:regression  # 736+ 项回归：搜索并发、ADO 链路、管家/Codex、团队配置、更新源、共享 Agent 与 LAN/outbox
pnpm test:ui          # 83+ 项浏览器流程：登录、消息、管家、首次引导、AI 设置与插件 Bridge
pnpm test:ecosystem   # SDK、CLI clean-room 脚手架与官方样例
pnpm smoke            # 54 项，打真实 RC：认证/会话/消息/引用/线程/讨论卡片/文件上传下载/中文搜索/置顶免打扰/通讯录/实时推送/斜杠命令/群管理/文件与提及面板/改昵称与头像
pnpm test:classify    # 5 项，打真实 RC：单聊/多人直聊/群组分类、会话排序
```

`smoke` 和 `test:classify` 默认连接 `http://localhost:3300`、账号 `admin` / `rcxdev123`；可通过 `RC_BASE_URL` 指定其他服务器。`smoke` 会做真实写操作（踢人、禁言、归档、改昵称、传头像），**跑完会全部还原**。

桌面端 Rust 测试：

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

> **自动测试跑绿不代表所有界面都是好的。** `test:ui` 覆盖核心浏览器流程，但没覆盖到的交互仍需真正在浏览器或桌面端点一遍。

## 桌面客户端与发版

当前候选版本是 **v0.43.5**。`v0.34.5` 已恢复 Windows x64、macOS universal 与 Linux x64 三平台正式安装包，从 `v0.35.0` 起受保护工作流会在完整校验后将新版本设为 GitHub Latest。

- **正式发版**：推送 `release/vX.Y.Z` 临时分支 → workflow 自动创建同名标签、删除临时分支，并构建三平台安装包与草稿 Release；标签只接受最新 `main` 与一致版本，进入 1.0 及以上时还会强制核验两位外部开发者证据和真实 README 截图/GIF；
- **准备 Release**：`build` 成功后运行，负责打包插件、核验产物、生成 `SHA256SUMS.txt`、写入 CHANGELOG 生成的 release notes；
- **公开发布**：复核草稿后运行受保护的 `Publish GitHub Release`；工作流重新核验三平台产物、更新签名和 SHA256 后公开，并确认 GitHub Latest 指向新标签；
- **npm 包（按需）**：公开 SDK/CLI 变更需要 npm 交付时，独立运行受保护的 `Publish npm packages`，按 SDK → CLI 顺序发布；npm 不阻塞桌面安装包与 GitHub Release；
- **手动构建**：Actions 页面运行 `Desktop Build` workflow → 从 Artifacts 下载安装包；
- **本地开发**：`pnpm --filter @rcx/desktop dev`（需要 [Rust 工具链](https://tauri.app/start/prerequisites/)）。

macOS 包使用 Tauri 支持的 ad-hoc 签名身份（本仓库尚无 Apple Developer 签名与 notarization 凭据），因此 DMG 未经 Apple 公证，可能需要在 macOS 隐私与安全设置中手动允许。

完整发布证据格式与不可逆步骤见 [`docs/release/README.md`](docs/release/README.md)。

## 应用开发

RocketX 应用通过清单、权限门控和 JSON-RPC Bridge 运行。先从 [`docs/app-development.md`](docs/app-development.md) 和 `examples/` 下的示例开始。不要授予应用不需要的能力。

## 安全与兼容性

- 只使用 Rocket.Chat 公开 API（`/api/v1/*`、`/websocket`）；已验证版本 **8.6.x**（dev 环境 8.6.1，docker 镜像已固定），其他版本按「已验证版本矩阵」逐步扩充，升级服务端前先对照矩阵；
- 不改动服务端、不私建数据表；扩展能力（如 ADO 桥）全部以外围服务实现；
- 任何时候都可以用官方客户端登录同一服务器，数据互通；
- 可选 Windows「飞鸽 / IPMSG」插件使用 UDP/TCP `2425`，协议实现位于其 Rust Sidecar 中；标准 IPMSG 支持消息与普通文件，原版内网通仅支持 `1@shiyeline` 的 `2425` 发现和文本，不实现私有 `9011`，旧协议能力不等同于 RocketX 的认证 LAN 通道；
- 原生集成的密钥停留在各自的本地密钥边界。RocketX 在支持的集成中使用操作系统凭据存储；DSH `0.1.0-rc.6` 使用私有 `DSH_HOME/.credentials.yaml`，官方 DSH Web 流程把密钥保存在该本地存储中，不会回显给 RocketX。

报告漏洞前请先阅读 [`SECURITY.md`](SECURITY.md)。第三方许可证摘要见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 文档与后续方向

- 当前可用能力、平台限制和失败语义：[`docs/specs/`](docs/specs/README.md)；
- 已交付版本：[`CHANGELOG.md`](CHANGELOG.md) 与 Git tag；
- GTD、注意力保护和 AI 边界：[`产品原则`](docs/specs/product-principles.md)；
- [`终局设想`](docs/vision.md) 与 [`产品蓝图`](docs/blueprint.md) 仅保留方向和历史演进，不是当前路线图或交付承诺。

## 参与贡献

欢迎贡献。请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，保持改动范围紧凑，并附带验证证据。本项目使用 [`MIT License`](LICENSE)。
