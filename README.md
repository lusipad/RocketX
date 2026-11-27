# RocketX

[English](README.en.md)

[![GitHub Release](https://img.shields.io/github/v/release/lusipad/RocketX)](https://github.com/lusipad/RocketX/releases)
[![CI](https://github.com/lusipad/RocketX/actions/workflows/ci.yml/badge.svg)](https://github.com/lusipad/RocketX/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/lusipad/RocketX)](LICENSE)

基于原版 Rocket.Chat、体验对齐飞书的团队协作客户端。

RocketX 不改 Rocket.Chat 服务端，只通过公开 API 通信。你可以在现有 Rocket.Chat 服务器上直接部署，官方客户端与 RocketX 数据互通、同时登录。

```text
┌─────────────────────────────────────┐
│   RocketX 客户端                     │
│ 消息 │ 管家 │ 待办 │ 日历 │ 工作台 │ 通讯录 │
└────────┬───────────────┬────────────┘
         │ REST / WS     │ Webhook
┌────────▼──────┐  ┌─────▼──────────────┐
│  Rocket.Chat  │  │  ado-bridge        │
│  （原版不改）  │◄─┤  Azure DevOps      │
└───────────────┘  │  Server 2022 事件  │
                   └────────────────────┘
```

## 下载

从 [GitHub Releases](https://github.com/lusipad/RocketX/releases) 下载最新版本：

- **Windows**：slim 安装包（探测系统 Codex / DSH）或 full 安装包（内置固定版本运行时）
- **macOS**：universal DMG（ad-hoc 签名，未经 Apple 公证）
- **Linux**：AppImage / DEB / RPM
- **Web**：直接用浏览器访问部署地址，无需安装

> 当前版本：**v0.51.0**

## 主要功能

- **飞书式团队消息**：三栏布局、话题、表情回应、@ 提及、文件共享、讨论卡片、消息搜索。
- **完整斜杠命令**：30 个命令全量中文说明、参数提示条与命令帮助（`/help` 或 `Ctrl+/`）；参数化命令一律弹出图形界面（选人、选频道、确认框），不再要求手打 `@用户名` 语法。
- **原生团队功能**：`/poll` 投票（点数字表情计票）、`/kanban` 频道看板（消息一键收纳成卡片）、`/oncall` 值班表——数据全部存服务端实时共享，**官方 Rocket.Chat 客户端也能阅读和参与**（例如用表情参与投票）。
- **GTD 工作区**：收件箱、待办、日历、通讯录，以及可直连 Azure DevOps Server 2022 的工作台。
- **AI 多角色圆桌与 GitHub Issue 闭环交付**：在群聊或讨论组创建多角色圆桌讨论（产品设计 / 架构工程 / 挑刺官 / 主理人 + `@` 角色追问），支持一键拍板落地改码跑测试、挑刺官独立验收并记入证据账本，以及直接导入 GitHub Issue、创建 `fix/issue-N` 分支、提交推送、创建关联 PR 并回写 Issue 评论（支持普通群拖拽/凝练决策交接）。
- **高阶 AI 管家（Grok Bot + T3 Code 能力级）**：
  - **Pi / ACP 多执行器协同**：内置统一 Pi Agent 主运行时与 Claude Code / Codex / Antigravity ACP 子执行器，支持实时模型切换、Steer/Queue、幕僚长按角色并发委派与 Delegation Tree 视图。
  - **结构化技能与主动助理**：Skills 工坊（Markdown 导入导出、内置模板、`/` 快速触发与「存为技能」）、事件触发与静默/免打扰规则驱动的自动化例程（含试运行预演）、可点击简报与主动哨兵、长记忆自动召回与内联治理。
  - **编码工作区工具链**：Unified/Split Diff 查看、零污染回合检查点与安全回滚、Git Worktree 4 层防爆炸生命周期管理、Commit/Push/PR、集成终端抽屉（`Ctrl+J`）、统一 `@file` / `/` / Plan / 拖拽附件输入框，以及项目策略护栏（`.rocketx/policy.json`）、自定义 MCP 注册表、GitHub 连接器和防 SSRF 本地浏览器只读检查器。
- **房间共享 AI 托管**：在房间或讨论里开启共享 AI，Web 和无 AI 客户端也能看到状态、用 `@ai` 提问。
- **局域网连续可用**：认证点对点链路，Windows 上可选配 IPMSG / 内网通 Sidecar 插件。

## 快速上手

1. 启动 RocketX 桌面端或打开 Web 端。
2. 在本地工作台与 AI 管家中直接创建待办、圆桌讨论或配置模型服务与凭据；原生桌面端支持全量中英文即时切换（`zh-CN` / `en-US`）。
3. 要收发团队消息，从「连接 Rocket.Chat」进入首次引导或导入 `rcx.workspace.json` / 填写服务器地址。
4. 登录后即可使用消息、工作台、待办、日历与群内共享 AI 协作；在设置 → AI 中可选择或切换运行时。

> 团队配置文件示例见 [`docs/examples/rcx.workspace.sample.json`](docs/examples/rcx.workspace.sample.json)。它只包含非敏感默认值，不会存放密码或 PAT。

## 截图

| | |
| --- | --- |
| ![斜杠命令补全](docs/images/slash-commands.png) | ![命令帮助](docs/images/command-help.png) |
| *斜杠命令补全：30 个命令全量中文说明与参数提示* | *命令帮助（`/help` 或 `Ctrl+/`）：可搜索、点击插入* |
| ![投票](docs/images/poll.png) | ![消息看板](docs/images/kanban.png) |
| *投票：聊天内点数字表情计票，官方客户端用表情也能参与* | *频道消息看板：消息一键收纳成卡片，成员实时共享* |
| ![值班表](docs/images/oncall.png) | ![加入频道](docs/images/join-channels.png) |
| *团队值班表：排班实时共享，可发布文本快照到频道* | *加入频道：无需命令语法，浏览或搜索公开频道* |

**与官方 Rocket.Chat 客户端互通**——投票在官方网页端显示为可读文本 + 表情回应，官方客户端投下的票实时计入 RocketX 的投票卡片：

| 官方 Rocket.Chat 网页端 | RocketX 实时计票 |
| --- | --- |
| ![官方客户端投票](docs/images/official-client-interop.png) | ![跨客户端计票](docs/images/cross-client-vote.png) |

欢迎在 issue 中分享你使用 RocketX 的界面截图。

## 文档

- [功能规格](docs/specs/README.md)：当前能力、平台限制和失败语义
- [能力矩阵](docs/specs/capability-matrix.md)：桌面端、Web、无 Runtime、性能模式下的可用性对照
- [团队配置说明](docs/proposal-config-provisioning.md)：`rcx.workspace.json` 字段与安全规则
- [应用开发指南](docs/app-development.md)：如何开发 RocketX 应用
- [架构决策](docs/architecture.md)、[兼容性说明](docs/compatibility.md)、[CHANGELOG.md](CHANGELOG.md)

## 安全与兼容性

- 只使用 Rocket.Chat 公开 API（`/api/v1/*`、`/websocket`），不改服务端、不私建数据表。
- 已验证服务端版本：**Rocket.Chat 8.6.x**（docker 镜像已固定为 8.6.1）。
- 原生集成的密钥停留在本地密钥边界；DSH `0.2.1-rc.2` 使用私有 `DSH_HOME/.credentials.yaml`，不会回显给 RocketX。

完整安全政策见 [SECURITY.md](SECURITY.md)。

## 参与开发

如果你想参与开发或本地调试，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。开发环境需要 Node.js 22.19+、pnpm 11.12.0；桌面端开发还需要 Rust 和 Tauri 前置依赖。

## 许可

本项目使用 [MIT License](LICENSE)。

---

RocketX 是独立项目，与 Rocket.Chat Technologies Corp. 没有关联，也未获得其背书。
