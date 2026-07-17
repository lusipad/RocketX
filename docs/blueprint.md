# RocketX 蓝图 · 一个人的团队版 GTD 可信系统

> 状态：v2，2026-07-17（取代 2026-07-14 的草案 v1；M6~M11 全部重定义，v1 的 M12 取消）
> 前置：M1–M10 已完成；M11 代码、文档、自动 clean-room 门禁和三平台 CI 干跑已完成，当前发布目标按 2026-07-17 决策保持为 v0.20.0；G3/G4 两位外部开发者真人计时与 README 真实截图/GIF 后置为未来 1.0 成熟度门禁，v0.20.0 仍需 npm scope 权限与三平台标签产物核验；Ollama 零外网与两周注意力指标继续做时序验收
> 定位决策：**自用 + 开源作品**（2026-07-17 确认）——政企向投入（信创/等保/应用市场/集中管控）全部冻结，见 §11

---

## 1. 核心主旨与目标

### 1.1 双支柱

工具要有核心思路，功能取舍才有判据。RocketX 的核心主旨由两个互补的理论构成，分工在**个人/团队**这条轴上：

- **支柱一 · GTD（David Allen《Getting Things Done》）——管"承诺进来之后，个人怎么处理"。**
  大脑用来产生想法，不是存放想法。一切承诺（消息、@我、群讨论、ADO 事件、日程）进入同一个可信系统，
  经 **捕获 → 理清 → 组织 → 回顾 → 执行** 五阶段流转。
- **支柱二 · 注意力保护（Cal Newport《没有电子邮件的世界》）——管"信息以什么方式到达你"。**
  拒绝"过度活跃蜂巢思维"的持续中断，代之以异步优先、批处理、拉取式消化。

**两者的连接不是拼贴，是承接的批判关系。** Newport 本人指出（《The Rise and Fall of
Getting Things Done》）：GTD 在个人维度正确，但管不了社交性输入的洪流——你的收件箱是别人以
任意速率填满的，个人系统再精良也会被冲垮，解药必须发生在团队协作方式这一层。由此推出
RocketX 的两个存在理由：

1. **GTD 工具必须自带 IM**——只有掌控消息入口，才能实施流量治理（批处理、摘要、降噪、拉取式
   消化）；治理不了入口，个人 GTD 系统必然被冲垮。这是纯 GTD 工具（Todoist/OmniFocus）结构性
   做不到的事。
2. **AI 管家是必需品而非点缀**——GTD 最反人性的理清与回顾（每周回顾坚持不下来是 GTD 实践崩溃
   的头号原因）、Newport 要求的批处理消化（把 200 条未读浓缩成 5 行），都由 AI 承担。
   **Agent 是执行的延伸**：不止提醒你做，还能替你做。

注意力支柱落到具体产品取舍：通知默认聚合降噪（紧急才穿透）、未读摘要代替实时跟读、
「今日」收件箱作为唯一拉取入口、agent 线程把"帮我看看"的打断变成结构化异步任务。

**对外定位一句话**：个人与小团队的开源飞书替代。但功能取舍以双支柱为判据，不对标飞书功能清单。

### 1.2 GTD 五阶段 ↔ 产品映射

每个**产品能力**里程碑必须能回溯到下表至少一格，否则它不该在路线图上；支撑性/交付性
里程碑（M6 内核底座、M9 的可用性保障、M11 发布工程）不受此约束，但必须写明各自服务于
哪条支柱或哪个目标：

| GTD 阶段 | RocketX 对应 | 状态 |
|---|---|---|
| **捕获** | IM 收所有输入：消息、@我、ADO 事件卡片、文件（M1~M5 建成的正是团队信息捕获层） | 已完成 |
| **理清** | AI 管家：未读摘要、消息→待办/工作项一键转化、智能分类 | M7 |
| **组织** | 待办、日历、工作台、分组规则 | 已完成 |
| **回顾** | 统一收件箱「今日」+ AI 晨报/晚间回顾、语义搜索 | M7 |
| **执行** | 共享 Agent 会话（$codex）、快速评论写回 ADO | M8 |

### 1.3 可判定目标

分"自用"与"开源作品"两个维度，什么算做成了：

- **自用 G1**：自己 + 小团队连续 ≥1 个月把 RocketX 当日常主力 IM，不切回官方客户端。
  每个里程碑收尾做一次 dogfooding 检验。
- **自用 G2**：AI 管家进入真实工作流——「今日」收件箱 / 晨报 / 未读摘要每周至少被自然使用一次
  （不是演示）。
- **开源 G3**：陌生开发者只看 README，30 分钟内 docker-compose 拉起 RC + 跑起 dev 环境。
- **开源 G4**：外部开发者只看文档，30 分钟内写出第一个能装载的应用。

### 1.4 三个约束（2026-07-17 更新）

| 约束 | 取值 | 影响 |
|---|---|---|
| 网络环境 | **内网为主，可受控出网** | AI 走 Provider 抽象，内网模型（Ollama/vLLM）与外网模型都支持；第三方应用出网必须走域名白名单 |
| 服务端 | **纯客户端**（v1 的可选服务端 `rcx-hub` 冻结，见 §11） | 每个能力都必须在纯 Tauri 客户端内跑通，没有"装了服务端才有"的分支 |
| 优先级 | **内核 → AI 管家 → Agent → 内网 → 开源发布** | 关键路径 M6 → M7 → M8；M9 与 M11 的生态工具部分只依赖 M6 可并行插队；M10 依赖 M9；v1.0 发布另有门禁（见 §6） |

> 关于 `architecture.md` 决策 1（「Rocket.Chat 服务端一行不改」）：本蓝图不违反它。
> 所有扩展能力都在客户端或旁挂进程实现，不改 RC 源码、不装 RC App。

---

## 2. 现状盘点：我们手里有什么

### 2.1 被低估的资产：桌面壳是 Tauri 2（Rust），不是 Electron

**这是整个蓝图能成立的技术前提。** 三条主线里最硬的部分，恰好是当前架构最擅长的：

| 需求 | Tauri/Rust | 如果是 Electron |
|---|---|---|
| UDP 组播发现 / TCP 直传 | `tokio::net`，原生 | Node dgram/net，和沙箱、`nodeIntegration` 打架 |
| IPMSG 协议栈 | Rust 写二进制协议，天然合适 | 可行但难看 |
| 托管 codex 子进程 + stdio JSON-RPC | `tokio::process`，原生 | `child_process`，需关沙箱 |
| 分发体积 | ~10 MB | ~150 MB（内网分发是真实成本） |

而且 **`apps/desktop/src-tauri/src/winauth.rs`（307 行，WinHTTP NTLM 集成认证）已经把
「自定义 Rust 命令 + capabilities 白名单 + 前端 invoke」这条路完整跑通过一次**。
后面所有 Rust 侧能力都照抄它的形状。

### 2.2 本机已有 codex CLI（M7/M8 的直接资产）

本机已验证 **codex-cli 0.144.4**，含 `codex app-server` 子命令（长会话 JSON-RPC over stdio，
会话管理 / 工具执行与沙箱 / 审批协议 / 流式事件 / 持久化恢复 / MCP 工具接入全部内置），
并自带 `generate-ts` / `generate-json-schema` 生成协议类型绑定——**Agent 运行时不需要自研**，
协议**类型**也不用手写。但要诚实：app-server 目前仍标记 experimental，适配层（初始化握手、
请求关联、崩溃恢复、server-initiated 请求响应）是 M8 的真实工作量，且需锁定 CLI 版本
（见 §4.4 复用原则与决策 9）。

### 2.3 扩展基建目前是零，但有五处"准扩展点"

仓库目前没有任何应用扩展框架（搜 `plugin` 命中的只有 Tauri 官方插件依赖），所有功能都是
硬编码的 React 组件。但恰好有五处**硬编码的分发结构**，它们就是内核的天然切口
（按「文件 + 符号」定位，行号会漂移不再标注）：

| 现有硬编码 | 文件（符号） | 改成什么 |
|---|---|---|
| `ModuleKey` 联合类型（6 个）+ `MODULES` 常量数组 | `stores/ui.ts`（`ModuleKey`）、`components/NavRail.tsx`（`MODULES`） | 一级导航模块注册表 |
| `RightPanel` 联合类型（8 个 `kind`）+ `ChatArea.tsx` 里 8 个 `rightPanel?.kind === 'xxx'` 分支 | `stores/chat.ts`（`RightPanel`）、`components/ChatArea.tsx` | 右侧上下文栏注册表 |
| `menuItems: MenuItem[]` 数组 | `components/MessageItem.tsx`（`menuItems`） | 消息动作注册表 |
| `AttachmentCard` 的 if/else 分发链 + `MessageList` 按 `msg.t` 分发 | `components/MessageItem.tsx`（`AttachmentCard`）、`MessageList.tsx` | 消息渲染器注册表 |
| `slashCommands`（纯服务端）+ `COMMAND_ZH` 手写表 | `stores/chat.ts`（`slashCommands`）、`lib/slash.ts`（`COMMAND_ZH`） | 命令注册表（本地 + 服务端合并） |

**顺带一个必须先还的债**：`Composer.tsx`（`doSend` 内的斜杠分支）和 `ThreadPanel.tsx` 各维护了
**一份重复的斜杠派发逻辑**。内核改造第一步就是把它们收敛成一个 `dispatchInput()`，
否则以后每加一个触发符（`$`、`@app`）都要改两个地方，必然漏。

### 2.4 斜杠命令目前没有本地注入口子

`stores/chat.ts` 的 `runSlash()` 的逻辑是：`findCommand(slashCommands)` 查不到 → toast「没有 /xxx
这个命令」→ **直接 return**。`slashCommands` 全部来自 `rest.listCommands()`（RC 服务端的
27 个）。也就是说 `/ai`、`$codex` 这类客户端本地命令**现在根本发不出去，会被自己拦下**。
这是 M6 必须开的第一个口。

### 2.5 桌面壳权限现在开得过宽（安全债）

`apps/desktop/src-tauri/capabilities/default.json`：

```json
{ "identifier": "http:default", "allow": [{"url": "http://**:*"}, {"url": "https://**:*"}] },
"fs:allow-write-file",
{ "identifier": "fs:scope", "allow": [{"path": "**"}] }
```

任意 http/https + 全盘写。`tauri.conf.json` 的 `"csp": null`。

在**没有第三方代码**的今天这只是"不优雅"；**一旦引入第三方应用，这是 P0 漏洞**——任何被
嵌入的页面都可能拿到全盘写权限。何况开源软件会被人审视，全盘写权限本身就是声誉问题。
M6 必须收紧，详见 §3.8。

### 2.6 其他要知道的

- 本地状态**全部**在 `localStorage`（`rcx-folders` / `rcx-todos` / `rcx-drafts` / `rcx-auth` …），
  无 IndexedDB。应用数据、向量索引、离线消息队列都塞不进去 → M6 要引入 IndexedDB 层。
- `packages/rc-client/src/realtime.ts` 的手写 DDP 客户端**已经是一条通用事件总线**
  （`call` / `subscribe` / `onStream` + 断线重订阅）。内核的事件系统直接架在它上面，不用碰协议层。
- **零 AI 代码、零 LLM 依赖。** 完全从头开始。
- 硬性约定（`architecture.md`「客户端自己的坑」）：**zustand 选择器必须返回稳定引用，
  否则整页白屏。** 内核所有新 store 必须遵守，这是已经踩过的坑。

---

## 3. 第一部分 · 扩展内核（M6）

内核的意义：让 AI 管家、Agent、内网能力全部以「应用可调用的能力」形态挂上去，而不是
三个孤立特性。管家的卡片、命令、面板全长在扩展点上——先拿到内核，后面才有复利。

### 3.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ 应用层   官方应用 │ 第三方应用 │ MCP Server │ Agent(codex)    │
├────────────────────────────────────────────────────────────┤
│ RCX Kernel        apps/web/src/kernel/                      │
│   registry   扩展点注册表（12 类）                            │
│   manifest   应用声明、安装、生命周期                          │
│   permission 权限 scope + 授权 UI                            │
│   sandbox    iframe 容器 / Worker 容器                       │
│   bridge     postMessage + JSON-RPC（MCP Apps 兼容）          │
│   storage    IndexedDB（应用数据 / 向量索引 / 离线队列）        │
├────────────────────────────────────────────────────────────┤
│ 能力总线 Capability Bus —— 内核暴露给应用的唯一 API 面          │
│   chat.*  rooms.*  users.*  files.*  ui.*  storage.*        │
│   ai.*     ← M7                                             │
│   agent.*  ← M8                                             │
│   lan.*    ← M9/M10   ★ 飞书结构性做不到的部分                 │
├────────────────────────────────────────────────────────────┤
│ 宿主运行时  @rcx/web (React 18 / zustand 5)                  │
│            @rcx/rc-client (REST + 手写 DDP)                  │
├────────────────────────────────────────────────────────────┤
│ Tauri 2 / Rust    winauth.rs(已有) │ proc.rs │ lan.rs │ ipmsg.rs │
├────────────────────────────────────────────────────────────┤
│ 旁挂服务（可选）  services/ado-bridge（已有）                   │
└────────────────────────────────────────────────────────────┘
```

### 3.2 协议底座：自研内核 + MCP 兼容层

**不是二选一。**

2026-01 发布的 **MCP Apps**（第一个官方 MCP 扩展）把"工具返回交互式 UI"标准化了，机制是：
工具在 `_meta.ui.resourceUri` 声明一个 `ui://` 资源（打包好的 HTML/JS）→ 宿主取回 → 沙箱
iframe 渲染 → **postMessage 上跑 JSON-RPC 双向通信** → UI 发起的工具调用需用户显式授权。
Claude 桌面版/网页版、Goose、VS Code 已支持。

**直接把它当作我们的应用 Bridge 协议。** 收益：
- 不用自己发明轮子、写规范、写文档
- 兼容生态：实现了 MCP Apps 扩展（自带 `ui://` UI 资源）的 server 能以最小成本接入
- codex 不再是特例——它本身就能作为 MCP server / app-server 暴露自己

**边界要诚实**：普通 MCP server（没有 UI 资源的）要装成应用，宿主还需要完整的 MCP Host
能力（连接管理、能力协商、`tools/call` / `resources/read` 代理）——**这不在 M6 范围内**。
agent 侧的 MCP 工具走 codex 自带的 Host（M8）；宿主自身的 MCP Host 列入远期候选（§11）。

**但纯 MCP 撑不住全部需求。** MCP 是 LLM 语义的协议，它没法表达"往左侧导航栏挂一个一级
模块""注册一个消息右键菜单项""在工作台放一张卡片"。所以宿主侧的**扩展点注册表、Manifest、
权限模型仍然自研**，MCP 是其中一种应用形态。

### 3.3 扩展点清单（12 类目标全集，M6 v0 实现 7 类）

| ID | 挂载位置 | 对应现有代码 | 首个用例 |
|---|---|---|---|
| `nav.module` | 左侧一级导航 | `NavRail.tsx` MODULES | 「今日」收件箱（M7） |
| `panel.right` | 右侧上下文栏 | `ChatArea.tsx` rightPanel | Agent 会话面板（M8） |
| `message.action` | 消息右键 / 悬浮操作 | `MessageItem.tsx` menuItems | "让 codex 看看这条" |
| `message.renderer` | 自定义消息类型 / 附件卡片 | `AttachmentCard` 分发链 | AI 卡片、Agent 会话卡片 |
| `composer.command` | 斜杠命令（**本地**） | `slash.ts` + `runSlash` | `/ai`、`/summary` |
| `composer.trigger` | 输入框触发符（`$` / `@app`） | `markdown.tsx` INLINE_RE | `$codex` |
| `composer.action` | 输入框工具栏按钮 | `Composer.tsx` 工具栏 | AI 润色（次优先） |
| `entity.link` | 正文富实体 + 悬停卡片 | `markdown.tsx` `WorkItemLink` | 内网 GitLab/禅道链接 |
| `home.widget` | 工作台卡片 | 工作台硬编码 | 值班表、日报 |
| `room.tab` | 会话内标签页 | 无 | 群公告、群看板 |
| `settings.page` | 设置页 | 无 | 应用配置页 |
| `background.task` | 后台事件订阅 | 无 | 自动归档、晨报定时生成 |

> 删掉会议/云文档后 `ModuleKey` 正好空出位置——`nav.module` 的第一个官方用例就是
> M7 的「今日」收件箱。
>
> **分期（承诺与验收对齐）**：M6 v0 实现 7 类——`nav.module`、`panel.right`、`message.action`、
> `message.renderer`、`composer.command`、`composer.trigger`、`entity.link`（M7/M8 与 T4 的
> 直接需求）。其余 5 类（`composer.action`、`home.widget`、`room.tab`、`settings.page`、
> `background.task`）只预留注册表结构，随真实用例落地——M7 的晨报定时先做成内置任务，
> 不走扩展点。

### 3.4 Manifest（`rcx.app.json`）

```jsonc
{
  "id": "com.corp.kanban",          // 反域名，全局唯一
  "version": "1.0.0",
  "name": "看板",
  "icon": "data:image/svg+xml;...",  // 或 bundle 内相对路径
  "publisher": "研发效能组",

  "runtime": "iframe",               // iframe | worker | native | mcp
  "entry": "https://kanban.corp.local/rcx",   // iframe: URL 或 ./index.html
                                              // worker: ./worker.js
                                              // native/mcp: { command, args, env }

  "permissions": [                   // 见 §3.5
    "chat:read", "chat:write", "net:fetch", "storage:local"
  ],
  "netAllow": ["https://kanban.corp.local"],  // net:fetch 的域名白名单，必填

  "contributes": {
    "nav.module":       [{ "id": "kanban", "label": "看板", "icon": "LayoutGrid" }],
    "composer.command": [{ "name": "kanban", "desc": "把这条消息建成卡片" }],
    "message.action":   [{ "id": "to-card", "label": "转成看板卡片" }],
    "home.widget":      [{ "id": "my-cards", "label": "我的卡片", "size": "md" }]
  }
}
```

安装来源：本地目录 / URL 安装包 + 包 hash 校验（应用市场与签名体系冻结，见 §11）。

### 3.5 权限模型

三档，授权时机不同：

| 档 | scope | 授权时机 |
|---|---|---|
| **基础**（安装时一次性告知） | `chat:read` 当前会话可见消息<br>`rooms:list` 会话列表<br>`users:read` 通讯录<br>`storage:local` 应用自己的存储<br>`ui:notify` 发通知 | 安装弹窗展示清单，装即授权 |
| **敏感**（安装时**显式勾选**） | `chat:write` 代发消息<br>`chat:history` 拉历史<br>`files:read` / `files:write`<br>`net:fetch` 出网（**必须配 `netAllow` 白名单**）<br>`ai:invoke` 调 AI 总线<br>`lan:discover` / `lan:transfer` 内网能力 | 安装弹窗逐条勾选，可事后在设置页撤销 |
| **危险**（每次调用二次确认） | `agent:spawn` 起 agent 会话<br>`process:spawn` 起任意本地进程 | **仅限用户在本机显式添加的本地应用**；每次调用弹审批卡片（允许一次 / 允许本会话 / 拒绝） |

`process:spawn` 是唯一能把任意代码跑在用户机器上的权限。它的存在只是为了 codex 这类
**本地可信 agent**。**第三方远程应用一律不得申请。** 内核在安装校验时硬性拒绝：
`runtime: "iframe"` + 远程 `entry` + `process:spawn` = 拒绝安装。

### 3.6 三种运行形态

| 形态 | 隔离手段 | 能力 | 用于 |
|---|---|---|---|
| **iframe** | 沙箱 iframe（`sandbox="allow-scripts"`，无 `allow-same-origin`）+ 严格 CSP + 域名白名单 | 全部 UI 扩展点；通过 Bridge 调能力总线 | 第三方在线服务（看板）、MCP Apps 的 `ui://` 资源 |
| **worker** | Web Worker，**无 DOM** | 逻辑扩展点（命令、后台任务、消息渲染的**数据**变换） | 轻量机器人、自动归档规则 |
| **native / mcp** | 独立 OS 进程，stdio JSON-RPC | 通过 MCP 协议暴露 tools / resources / prompts；可返回 MCP Apps UI | codex、内网能力、本地 CLI 工具 |

> **分期**：M6 实现 iframe 与 worker 两种形态；native/mcp 进程形态随 M8 的 `proc.rs` 一起落地。

### 3.7 Bridge 协议

postMessage + JSON-RPC 2.0，方法命名空间与 MCP 对齐。

```
宿主 → 应用   rcx/event      消息到达 / 房间切换 / 主题变化 / 应用被激活
应用 → 宿主   rcx/call       方法名 = 能力总线 API，如 chat.postMessage
应用 → 宿主   rcx/requestUI  申请打开面板 / 弹窗 / 通知
```

所有 `rcx/call` 都过一层**权限闸门**：检查 scope → 危险权限弹审批 → **写本地审计日志**
（IndexedDB `audit` 表——对调试和开源信任有价值；v1 的上报链路随 rcx-hub 冻结）。

### 3.8 安全收紧（P0，和内核同批做）

引入第三方代码的**同一个 PR** 里必须完成：

1. **CSP 从 `null` 收紧**。主窗口 `default-src 'self'`；iframe 应用单独一套，
   `connect-src` 只允许它 manifest 里声明的 `netAllow`。
2. **`fs:scope` 从 `**` 收窄**到应用沙箱目录 + 用户显式选择的路径（走 `dialog`）。
   当前的全盘写在没有第三方代码时只是不优雅，有了就是提权漏洞。
3. **`http:default` 的 `**` 白名单收窄**。宿主自己的请求走 RC 服务器域；应用的出网请求由
   内核代理，按 `netAllow` 逐条校验（**不能让应用直接拿到 `httpFetch`**）。
4. iframe 一律 `sandbox="allow-scripts"`，**不给 `allow-same-origin`**——否则沙箱形同虚设。

### 3.9 存储

引入 `packages/rcx-store`（IndexedDB 封装），localStorage 保留给现有的小配置不动：

| 数据 | 位置 |
|---|---|
| 应用注册表、manifest、授权记录 | IndexedDB `apps` |
| 应用私有存储（`storage:local`） | IndexedDB `app-data`，**按 appId 分区隔离** |
| 消息向量索引（M7 语义搜索） | IndexedDB `vectors` |
| 离线消息队列（M9 断网降级） | IndexedDB `outbox` |
| 本地审计日志 | IndexedDB `audit` |

### 3.10 M6 改动清单（文件级）

**新增**
```
apps/web/src/kernel/registry.ts       扩展点注册表（12 类）
apps/web/src/kernel/manifest.ts       manifest 解析 + 校验 + 安装/卸载
apps/web/src/kernel/permission.ts     scope 校验 + 审批 UI + 本地审计
apps/web/src/kernel/bridge.ts         postMessage JSON-RPC（宿主侧）
apps/web/src/kernel/sandbox/iframe.tsx
apps/web/src/kernel/sandbox/worker.ts
apps/web/src/kernel/capabilities/     chat / rooms / users / files / ui / storage
apps/web/src/kernel/dispatch.ts       ★ 统一输入派发器（收敛 Composer/ThreadPanel 重复逻辑）
packages/rcx-store/                   IndexedDB 封装
packages/app-sdk/                     @rcx/app-sdk —— 给第三方开发者的 Bridge 客户端
```

**改造**
```
stores/ui.ts            ModuleKey 联合类型 → string + 注册表校验
components/NavRail.tsx  MODULES 常量 → registry.get('nav.module')
stores/chat.ts          RightPanel 联合类型 → { kind: string; props?: unknown }
                        runSlash() → 先查本地命令注册表，再落回 rest.runCommand()  ★ 开口子
components/ChatArea.tsx 8 个 rightPanel.kind 分支 → 注册表查找渲染
components/MessageItem.tsx  menuItems 数组 → 内置项 + registry.get('message.action')
                            AttachmentCard 分发链 → renderer 注册表
components/MessageList.tsx  msg.t 分发 → renderer 注册表
components/Composer.tsx     doSend 里的斜杠逻辑 → kernel/dispatch.ts   ★ 去重
components/ThreadPanel.tsx  同上                                       ★ 去重
lib/slash.ts            filterCommands 支持本地+服务端合并
lib/markdown.tsx        INLINE_RE 支持注册的 entity/trigger 规则
src-tauri/capabilities/default.json   ★ 收紧（§3.8）
src-tauri/tauri.conf.json             ★ CSP 从 null 收紧
```

### 3.11 M6 验收

1. 一个 Hello World 应用（iframe），声明 `nav.module` + `composer.command`，装上后左侧出现
   新模块、`/hello` 能用。
2. **一个真·第三方看板嵌进来**（本地目录安装），能读当前会话、能把消息转成卡片。
3. 删掉应用 → 导航项、命令、渲染器全部干净消失，无残留。
4. 越权测试：一个只声明 `chat:read` 的应用调用 `chat.postMessage`，被闸门拒绝 + 本地审计
   日志有记录。
5. **CSP / fs / http 三处收紧全部落地**，`smoke.ts` 全绿。

---

## 4. 第二部分 · AI 管家（M7）与共享 Agent（M8）

### 4.1 为什么管家排在 Agent 前面

Provider 抽象、流式渲染、AI 卡片渲染器这三样基建，Agent 会**原样复用**。先做 Agent 就得把
它们临时搭一遍再重写。

**折中：M7 里塞一条快速通道**——复用本机 codex CLI 做一个可玩的 `$codex` MVP（单轮），
大约多花 3–5 天。完整的共享 Agent 会话留到 M8。这样 M7 结束时就能真的用上。

### 4.2 AI 总线（M7）

```ts
// apps/web/src/kernel/ai/provider.ts
interface AiProvider {
  id: string
  chat(req: { messages: Msg[]; tools?: Tool[]; stream?: boolean }): AsyncIterable<Chunk>
  embed?(texts: string[]): Promise<number[][]>
}
```

内置三个实现：
- `openai-compatible`——**一个实现覆盖绝大多数**：Ollama、vLLM、one-api、DeepSeek、Qwen、内网自建网关
- `anthropic`
- `azure-openai`

配置在设置页，支持**多 Provider + 按能力路由**（例：摘要用内网 7B 小模型省钱，agent 用云端强模型）。

> 这是 **LLM 调用层**的抽象（chat/embed），与 §4.4 的 Agent 运行时是两回事——后者薄适配
> codex app-server，不做预先抽象。

**隐私开关（必做）**：每个 AI 能力可独立配置「仅本地模型」；所有 AI 请求写本地审计日志。
自用同样不想让一次总结把聊天记录发到外网去。

**密钥存放**：Tauri 的 OS keychain，仅本机。

### 4.3 AI 管家能力清单（M7）

全部走同一条总线，全部复用 M6 的 `message.renderer` 渲染。
**取舍原则：理清 / 回顾类优先（这是管家的本职），润色 / 翻译类次优先（那只是文本工具）。**

| 优先级 | 能力 | GTD 阶段 | 入口 | 备注 |
|---|---|---|---|---|
| ★ 旗舰 | **统一收件箱「今日」** | 回顾 | `nav.module` 新模块 | 见 §4.3a |
| P0 | 未读速览 / 会话总结 | 理清 | `/summary`、会话列表右键、「今日」内嵌 | "我不在的这两小时群里发生了什么" |
| P0 | 消息 → 待办 / 工作项一键转化 | 理清 | `message.action` + AI 预填标题/截止日 | 现有待办与 ADO 创建链路已通，AI 只做结构化提取 |
| P1 | AI 晨报 / 晚间回顾 | 回顾 | 「今日」内 + 定时生成（M7 先内置，`background.task` 扩展点随真实用例落地） | 晨报=今天要什么，晚回顾=今天欠什么 |
| P2 | 智能分类 | 理清 | 从零建设 | 仓库现有 classify（`test-classify.ts`）只是房间类型分类，**没有**可复用的语义分类管线——从零做，有余力再上 |
| P1 | 语义搜索 | 回顾 | Ctrl+K 升级 | 需 embedding + IndexedDB 向量索引；增量建索引 |
| P2 | 翻译 / 润色 / 改写 | —（文本工具） | Composer 工具栏（`composer.action`） | 次优先，有余力再做 |
| — | `$codex` MVP 快速通道 | 执行（先导） | `composer.trigger` | 见 §4.4 末尾 |

### 4.3a 旗舰：统一收件箱「今日」

AI 管家的主场景，双支柱的直接体现——**唯一的拉取式消化入口**：

- **聚合四源**：@我 的消息、待办（含今天到期/逾期）、今天的日程、分配给我的 ADO 工作项。
  四个数据源现有 store 全部已有，新工作是聚合视图 + 排序。
- **AI 晨报**：一屏说清"今天要什么"——待办优先级、日程冲突、未读里需要回应的事。
- **晚间回顾**：今天欠了什么——没回的 @、没动的到期待办，一键顺延或标完成。
- 挂载方式：`nav.module` 注册的新一级模块（M6 内核首个官方 nav 用例），
  各条目点击跳回原消息/待办/工作项（复用现有跳转链路）。

### 4.4 共享 Agent 会话（M8）——「线程即会话」

**v1 §4.4 的拦截式设计作废**，它有五个硬伤：需要 message-impersonate 权限（实测 admin 都
没有）；"路由给 agent 不发 RC"让线程对其他成员断片；流式 `chat.update` 写放大；群消息
（不可信输入）+ 执行能力构成注入的致命三角却无结构性防御；宿主进程生命周期未定义。

需求确认（2026-07-17）：**其他成员也要能指挥 agent**（让它查阅、分析）。据此改为：

#### 模型

- **不拦截任何消息**：所有人的消息照常发进 RC 线程（服务器记录完整，谁都看得到全部对话）；
  **宿主客户端**（触发者的机器——进程、仓库、凭证都在这里）订阅线程，把成员消息转发给本地 agent。
- **指令语义**：旁听全部——线程内所有消息进 agent 上下文（它能"听到"讨论背景）；
  **@codex 或 `$` 开头才触发回应**，成员之间可以正常聊天不被插话。
- **参与范围**：RC 没有"线程成员"这个授权主体（thread follow 只管通知）——实际主体是
  **房间成员**。默认房间成员皆可让 agent 查阅/分析（自用小团队可接受），宿主可在会话
  卡片切换「仅自己」；**非宿主成员首次指挥需宿主一次性放行**（每会话每人一次）。
  **任何执行命令 / 写文件的审批卡片只有宿主能点**，其他人视角是"等待宿主审批"。
- **身份**：默认方案——管理员一次性创建 **codex bot 账号**，宿主客户端持 bot token 代发
  agent 消息（真实身份，官方客户端同样显示为 bot，无需 message-impersonate）。
  无 bot 账号时降级为宿主账号发送 + 标记字段，但**标记只用于展示、不构成信任边界**——
  attachment 自定义字段任何用户都能伪造，且 RC 公共 schema 不承诺保留任意字段。
  审批权限判定不依赖消息标记（由宿主本地会话状态决定），伪造标记冒充不了审批通道。
- **输出粒度**：按完整回复为单位发消息、限流合并；逐 token 的 tool 调用 trace 只留在
  宿主本地的 **Agent 面板**（`panel.right` 扩展点）。线程承载对话，面板承载过程。
- **生命周期（会话状态机）**：每个会话有 sessionId 与**宿主租约**（会话卡片记录宿主设备
  与心跳时间戳，单写者）；活租约存在时另一台客户端触发 → 拒绝并提示接管流程；成员指令进
  单队列按序喂给 agent（并发不交错）；宿主 `/exit` 正常结束；宿主崩溃/下线 → 租约超时后
  卡片标注「已中断」，宿主重新上线可用 codex 自带 resume 恢复；孤儿会话超时自动标结束。
- **安全默认（注入与泄露双防线）**：只读不等于无害——agent 把宿主机器上的源码/配置/密钥
  读出来发回群聊同样是事故。因此：参与者指令默认只读工具集且**限定在会话工作区白名单内**；
  敏感路径默认拒绝（`.env`、密钥文件、`~/.ssh` 等黑名单）；agent 输出回帖前过密钥模式脱敏；
  有外部副作用的 MCP 工具仅宿主可触发；工作区默认每会话临时目录（固定目录须宿主显式配置）；
  来自聊天的上下文喂给 agent 时标注为不可信来源（这是提示不是边界，边界是前面几条）。

#### 复用原则：薄适配 codex app-server，不自研 agent 运行时（决策 9）

会话管理、工具执行与沙箱、审批协议、流式事件、会话持久化/恢复、MCP 工具接入
**全部复用 codex app-server 自带能力**（本机已验证 codex-cli 0.144.4）：

- 协议**类型**用 `codex app-server generate-ts` 生成、不手写；产物与生成它的 CLI 版本绑定——
  **锁定 CLI 版本并维护已验证版本矩阵**，升级时重新生成并跑适配层回归（app-server 仍是
  experimental，不锁版本就是把地基放在流沙上）；
- **适配层是真实工作量，不要按"转译"低估**：初始化握手、请求关联、turn 串行化、进程崩溃
  恢复、以及**全部** server-initiated 请求的响应（exec/patch 审批、permissions、elicitation
  等，未知请求安全拒绝）；审批卡片 = 这些 JSON-RPC 请求的 UI 映射，语义不自创；
- agent 侧的内网 MCP 工具走 codex 自身的 `mcp_servers` 配置，RocketX 不为 agent 重复实现 MCP Host；
- RocketX 只做四件事：**本地 codex 发现（PATH）、进程托管（`proc.rs`，或实测后改用
  app-server daemon+proxy 模式）、线程消息 ↔ app-server 协议转译、审批/状态卡片 UI**；
- **Agent 层不预先做多 Provider 抽象**——第一版直接绑定 app-server 协议；`$claude` 等第二个
  agent 真要接入时（如经 ACP / Agent Client Protocol）再抽象。

#### 上下文包（触发时由宿主收集，体验好坏的关键）

- 当前线程/会话最近 N 条消息（N 可配），标注不可信来源
- 被引用 / 选中的消息及其整条线程
- 附件：代码块、日志、图片 → 落到临时目录，把路径给 agent
- 房间元信息：名称、话题、**关联的 ADO 工作项**（工作台已有这层关联，直接复用）
- 触发者与参与者身份

#### M7 的 `$codex` MVP 与 M8 的衔接

M7 快速通道复用官方 CLI、零自研 agent 逻辑：优先实测 app-server 单会话直连
（Spike A 本就排在 M7 期间），`codex exec --json` 作为兜底；结果作为一条带标记字段的消息
发回线程——共享模型的最小雏形。长会话、多人交互、审批卡片留在 M8。

### 4.5 反向 MCP（M8，自研差异化点）

**RocketX 反向暴露一个 MCP server（`rcx-mcp`）**：让**外部** agent 读取聊天上下文。
意味着你在 IDE 里的 Codex/Claude 也能读到群里的讨论——**双向打通**，这是别人没有的。

### 4.6 M7 / M8 验收

- M7：内网 Ollama 跑通全部管家能力，**全程零外网请求**（抓包验证）；本地审计日志完整。
- M7：「今日」聚合四源数据正确，晨报真实可读；`/summary` 对 200+ 条未读的会话产出可用摘要。
- M7 注意力指标（支柱二的可判定验收）：通知默认聚合 + 紧急穿透规则可配；dogfooding 两周
  自测日通知弹出次数较基线下降 ≥50%；「今日」条目处理完成率可被统计。
- M7 快速通道：`$codex 解释一下这段报错` + 贴日志 → 线程里出结果。
- M8：群里 `$codex` 贴一段报错 → agent 读到上下文 → 提方案 → 请求执行命令 → 宿主在聊天里
  点「允许」→ 完成一轮修复，全程没离开聊天窗口。
- M8：**另一个成员**在同一线程 @codex 让它查阅代码 → agent 正常回应；该成员发起的执行请求
  显示"等待宿主审批"。
- M8：用官方 Rocket.Chat 客户端旁观整条线程 → 对话完整可读（降级渲染，无断片）。
- M8 适配层验收：CLI 版本锁定生效；kill agent 进程 → 会话卡片标注「已中断」、resume 恢复
  成功；全部 server-initiated 请求类型有响应路径，未知请求被安全拒绝。
- M8 泄露防线验收：让 agent 读取黑名单文件（如 `.env`）被拒；诱导 agent 输出密钥样式内容
  → 回帖前被脱敏。

---

## 5. 第三部分 · 内网能力（M9 / M10）

> 这部分是**飞书结构性做不到**的，是差异化的根。GTD 视角：可信系统必须**永远可用**、
> 数据不离开你的掌控——断网可聊、内网直传正是"可信"的字面要求。
> 它排在 AI 后面，因为它只依赖 M6 的能力总线，随时可以并行插队。

### 5.1 LAN 直传 + 断网降级（M9）

新增 Rust crate `apps/desktop/src-tauri/src/lan.rs`：

- **发现**：mDNS（`_rcx._tcp.local`）+ UDP 组播兜底。广播：RC userId、设备名、IP、端口、公钥。
- **身份绑定（安全关键）**：RC token 是各自持有的 bearer 凭证，两端没有共同验证材料，
  **不能拿来互验**。改为：在线期间通过已认证的 RC 通道（DM/私有频道）交换**设备公钥**并
  本地缓存（TOFU + 密钥固定）；此后（含 RC 离线时）握手用缓存公钥做挑战-应答签名互验；
  未交换过公钥的对端视为不可信、只提示不通行。**不能只信广播里的自称**。
- **传输**：TCP 直连，1 MB 分片、并发流、断点续传（offset）、BLAKE3 校验、可选 TLS
  （自签 + RC 身份绑定）。
- **自动路由**：发文件时内核判断——对方在线 + 同网段 → P2P；否则 → 走 RC 上传。
  UI 显示「局域网直传 · 112 MB/s」。
- **回退**：P2P 失败自动降级服务端上传，**用户无感**。
- **断网降级**（v1 排在 M10，与 IPMSG 无关、同依赖 `lan.rs` + `outbox`，提前并入本期）：
  RC 服务器不可达时，同网段用户之间仍可通过 LAN 通道聊天；消息进 IndexedDB `outbox`。
  **回灌规则（收缩后的诚实承诺）**：每条离线消息带稳定客户端 `_id`（`chat.sendMessage`
  支持自定义 `_id`，天然幂等）；**作者本人是唯一回灌者**（不存在双方重复提交）；服务端
  没有公开的"提交原始创建时间"契约，**不承诺服务器侧时间戳还原**——原始时间写进消息
  自定义字段，RocketX 客户端按原始时间展示，官方客户端降级显示回灌时间；回灌按原始时间
  排序尽力而为。开工前先做 **Spike C**（§8）实测 `_id`/`ts`/自定义字段的真实行为。
  内网机房抖动、跨楼层网络故障是真实高频场景——**"服务器挂了还能聊"是 SaaS IM 永远
  给不了的硬卖点**。
- **暴露给应用**：`lan.peers()` / `lan.send(userId, file)`（scope `lan:discover` / `lan:transfer`）。

价值：内网千兆环境传 GB 级设计图 / 代码包，速度差一个数量级，而且**不占服务器存储和带宽**。

### 5.2 IPMSG 共存模式（M10）

新增 `apps/desktop/src-tauri/src/ipmsg.rs`。协议：**UDP 2425**（发现/消息）+ **TCP 2425**（文件）。

报文格式：`Ver:PacketNo:SenderName:SenderHost:CommandNo:AdditionalSection`
命令字：`BR_ENTRY`（上线广播）/ `BR_EXIT` / `ANSENTRY` / `SENDMSG` / `RECVMSG` /
`GETFILEDATA` / `RELEASEFILES`

**只做共存模式（客户端内置，零部署）**：RocketX 同时以 IPMSG 身份上线，
**飞秋/内网通用户能在他们的列表里看到你、给你发消息和文件**。这些消息进入 RocketX 的
一个虚拟频道（「局域网」）——**同样进「今日」收件箱，是捕获层的扩展**。
（v1 的网关模式——rcx-hub 常驻双向桥——服务于"大规模过渡期"，随定位冻结，见 §11。）

价值：推广内网 IM 最大的阻力永远是"老王还在用飞秋，我发给他他收不到"。共存模式直接消灭
这个阻力——不需要全员同一天切换。

⚠️ **风险：飞秋 / 内网通对原版 IPMSG 有私有扩展**（加密、扩展字段、中文编码差异），
不完全兼容。**M10 开工前必须先做抓包 Spike**（§8），否则可能做出一个只能和"原版
IP Messenger"互通、和国产变种互不理睬的东西。若变种确实不互通，收缩承诺为原版互通。

### 5.3 其他内网候选（按性价比排序，择机插入）

1. **内网服务 unfurl**：GitLab / Jira / 禅道 / Confluence / SVN 链接预览。**高价值、低成本**——
   直接复用 `entity.link` 扩展点和现有 `WorkItemLink` 悬停卡片，几乎白送 → 已挂 T 轨道（§7）。
2. **局域网紧急广播**：全员喊话，IPMSG 协议本身就支持。
3. **共享盘路径解析**：粘贴 `\\nas\share\x.pdf` 直接预览。
4. **P2P 分发客户端更新包**：省内网带宽，顺带解决自动更新在隔离网的难题。

### 5.4 M9 / M10 验收

- M9：千兆内网传 5 GB 文件，**给出 P2P vs 服务端上传的实测对比数字**；中途拔网线 →
  重连后断点续传成功；文件 BLAKE3 校验通过。
- M9：冒充测试——伪造广播声称他人 userId 但没有对应私钥，挑战-应答失败、握手被拒。
- M9：拔掉 RC 服务器 → 同网段两个客户端仍能聊天 → 恢复后消息幂等回灌（无重复），
  RocketX 端按原始时间正确展示。
- M10：**飞秋 ↔ RocketX 双向收发消息 + 文件成功**（用真实飞秋客户端，不是自己写的测试桩）。

---

## 6. 第四部分 · 开源发布与应用生态 v0（M11）

内核是地基，作品要能被别人用起来、被别人扩展，才算开源作品（G3/G4）。

**开发者生态**：
- **`@rcx/app-sdk`**：发 npm，封装 Bridge JSON-RPC，TypeScript 类型完整。第三方开发者只面对它。
- **`create-rcx-app`** 脚手架 + `rcx-app dev`（本地热重载）+ `rcx-app validate`（manifest 校验）。
- **官方样板应用（3 个）**：看板、投票、值班表。样板应用的真正作用是**验证扩展点设计够不够用**
  ——如果官方应用还要"开后门"才能实现，说明内核设计有漏。
  （Agent 面板是 M8 产物，不占样板名额；免登 SSO 与应用市场冻结，见 §11。）

**开源发布工程**：
- **LICENSE（v1.0 硬门禁，已落地）**：已选 **MIT**，文件已在仓库根目录（2026-07-17）；
  SECURITY.md 与第三方依赖许可说明随 M11 补齐；
- 英文 README（含架构图与 GIF 演示）、贡献指南（CONTRIBUTING.md）、截图；
- 一键自部署：docker-compose 同时拉起 RC + RocketX，**镜像版本固定**（G3 的 30 分钟承诺
  必须可复现，`latest` 会漂移）；维护「已验证 RC 版本矩阵」（当前 8.6.x）与升级测试策略；
- Release 质量：三平台安装包、CHANGELOG 面向用户重写、当前 **v0.20.0**；完成真人 G3/G4 与真实视觉素材后再进入 1.0。

**M11 的两半与 v1.0 门禁**：生态工具（SDK/脚手架/样板应用）只依赖 M6，可随时并行插队；
但 **v1.0 发布门禁 = M6/M7/M8/M9 全部完成 + LICENSE 与版本矩阵落地**——核心主旨没兑现就打
1.0 是自欺（M10 IPMSG 视 Spike B 结果决定进 1.0 还是 1.x）。

**M11 / v0.20.0 验收**：自动 clean-room、三平台安装包、LICENSE / SECURITY.md 与应用生态交付通过。G3 与 G4 各找一位真实外部开发者实测计时，保留为未来 1.0 门禁，不阻塞 0.x 发布。

> 实施状态（2026-07-17）：SDK、CLI、三个正式样板、固定版本 Docker 栈、双语与开源文档、
> 三平台发布工作流和自动 clean-room 代理门禁均已落地。Docker 三服务首次拉取加构建至 healthy
> 约 2 分 44 秒，应用脚手架 clean-room 约 7.3 秒；两者都不是外部真人证据。当前先发布
> v0.20.0；G3/G4 真人计时与真实产品截图/GIF 在未来 1.0 标签前补齐。

---

## 7. 稳定化轨道 T（持续，不设独立里程碑）

**规则**：每个大里程碑预留 ~20% 时间给 T 轨道（**§9 总表估时已包含这 20%**，单维护者日历周口径）；里程碑验收含"本期认领的 T 项清零"。
独立的"稳定化里程碑"会变成垃圾抽屉并无限推迟主线——所以 IM 补全与主线并行。

| 项 | 内容 | 挂靠 |
|---|---|---|
| T1 | **桌面自动更新**（Tauri updater + GitHub Releases） | M6 期间 |
| T2 | **UI 渲染冒烟**（Playwright 最小集 5~10 条：登录/发消息/切会话/搜索/右键菜单）——补掉"脚本全绿但白屏测不到"的盲区，AI 大量上 UI 前先有安全网 | M7 期间 |
| T3 | **工作台再进阶**（原 M3.5：Release 状态、工作项看板视图） | M9 期间或按需 |
| T4 | **quality-audit 零星遗留**（如 #15 发送抖动）+ **内网服务 unfurl**（§5.3-1，复用 `entity.link`） | 滚动认领 |

`docs/quality-audit.md` 的未修项由本轨道统一认领，该文档继续滚动更新。

---

## 8. 必须提前做的 Spike

做晚了会推翻设计，每个 2–5 天：

| # | Spike | 为什么必须早做 | 什么时候 |
|---|---|---|---|
| A | **codex app-server 长会话实测**：在 Tauri 子进程里验证 stdio JSON-RPC 的长会话、审批回调、流式输出、`generate-ts` 产物可用性 | M8 的全部设计压在这个假设上；本机 codex-cli 0.144.4 已确认命令存在，但未实测长会话 | **M7 期间** |
| B | **飞秋 / 内网通的 IPMSG 私有扩展抓包** | 决定 M10 是"两周的事"还是"两个月的事"，也可能发现某变种根本无法互通、需收缩承诺 | M10 开工前 |
| C | **RC 离线回灌契约实测**：`chat.sendMessage` 自定义 `_id` 的幂等行为、`ts` 提交是否生效、消息自定义字段的保留策略（含相关服务端设置） | M9 断网降级的回灌规则与 M8 的消息标记都压在这些行为上 | M9 开工前 |

（v1 的 Spike 1「信创 WebKitGTK 兼容性」随信创冻结取消，见 §11。M6 不再有前置阻塞。）

---

## 9. 里程碑总表

| 里程碑 | 主题 | GTD 回溯 | 估时 | 依赖 |
|---|---|---|---|---|
| **M6** | 扩展内核（瘦身）+ IndexedDB + 安全收紧 + SDK v0 | 底座（管家的卡片/命令/面板全长在扩展点上） | 3~4 周 | 无 |
| **M7** | AI 管家 + 统一收件箱「今日」+ `$codex` MVP | 理清 + 回顾 | 4 周 | M6 |
| **M8** | 共享 Agent 会话（线程即会话，薄适配 codex app-server）+ 反向 MCP | 执行 | 4 周 | M7 |
| **M9** | LAN P2P 直传 + 断网降级 | 可信系统的"永远可用" | 3~4 周 | M6；发现/传输的 Rust 侧可与 M7/M8 并行，触及发送路径 / `outbox` / 能力总线的集成部分需串行排布 |
| **M10** | IPMSG 共存模式 | 捕获层扩展 | 2~3 周 | M9 |
| **M11** | 开源发布 & 应用生态 v0（v0.20.0 Release） | 开源作品交付 | 3~4 周 | 生态工具仅依赖 M6；未来 **v1.0 门禁 = M6~M9 + LICENSE + G3/G4 + 真实视觉素材**（§6） |

**关键路径**：M6 → M7 → M8（v1.0 发布门禁还含 M9）。M9 的 Rust 侧与 M11 的生态工具只依赖
M6、可并行插队（集成部分除外）；M10 依赖 M9。**估时为单维护者的日历周，已含 ~20% T 轨道时间。**

**近 1~2 个月的诚实预期**：串行主线下 = M6 全部 + M7 开头 + T1/T2；
M9 最早在 M7 期间并行插队。四个方向中"内核"与"IM 补全（T 轨道）"立即推进，
"AI 管家"紧随，"内网"排第三。

---

## 10. 技术决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 应用协议：自研 vs MCP | **自研内核 + MCP Apps 作为 Bridge 协议**。白拿生态，又不被 LLM 语义限制住 UI 扩展点 |
| 2 | 沙箱：iframe vs Tauri WebviewWindow | **先 iframe**（简单、和 MCP Apps 一致）；高危应用未来可升级到独立 WebviewWindow |
| 3 | 应用数据存哪 | **IndexedDB**。localStorage 装不下向量索引和离线队列 |
| 4 | 跨设备同步应用配置 | 先不做。真要做，用 RC 的 `users.setPreferences` 或一个私有频道当存储，**不改 RC 源码** |
| 5 | LAN P2P：Rust 原生 socket vs WebRTC | **Rust 原生 TCP**。有 Tauri 就别绕 WebRTC 的信令和 NAT 穿透——内网本来就通 |
| 6 | 第三方应用能否用远程 URL | **能，但必须走 `netAllow` 域名白名单 + CSP `connect-src` 双重限制** |
| 7 | AI 密钥存哪 | **OS keychain，仅本机**（v1 的 rcx-hub 服务端托管分支随冻结取消） |
| 8 | 定位与核心主旨（2026-07-17） | **自用 + 开源作品；GTD + 注意力保护双支柱**（§1）。政企向投入冻结（§11） |
| 9 | Agent 运行时（2026-07-17） | **薄适配 codex app-server，不自研**：协议类型用 `generate-ts` 生成、审批/会话/沙箱语义复用；适配层（握手/关联/恢复/server-initiated 请求）按真实工作量排入 M8，CLI 版本锁定 + 已验证版本矩阵；不预先做多 Provider 抽象 |

---

## 11. 远期候选（冻结区）

以下项随"自用 + 开源"定位冻结，**不再出现在里程碑里**。冻结不是否定——若定位变化
（如真要进政企内网市场）可重启：

| 冻结项 | 原因 | 重启条件 |
|---|---|---|
| 信创适配（麒麟/统信 + 龙芯/飞腾，WebKitGTK Spike） | 只对政企市场有意义 | 出现真实政企部署需求 |
| 等保三级相关（水印、防截屏、审计上报、三员管理） | 同上 | 同上 |
| `rcx-hub` 可选服务端（集中管控 / 密钥托管 / 审计上报 / IPMSG 网关常驻） | 自用没有管理员角色；"服务端可选"收敛为"纯客户端" | 多团队部署需要集中管控时 |
| 免登 JWT / SSO | 自用场景第三方在线服务极少；开源场景以本地包安装为主 | 生态出现真实的第三方在线服务接入需求 |
| 私有应用市场（index / 审核 / 强推） | 没有管理员，也没有被管理的用户；先用本地目录 / URL 安装 + hash 校验 | 同上 |
| IPMSG 网关模式（整网双向桥接） | 服务于大规模过渡期，自用不存在 | 真实的整团队迁移场景 |
| 应用包签名体系 | 开源分发先用包 hash 校验够用 | 应用生态形成规模 |
| 多 Agent Provider 抽象（`$claude` 等） | 不为假想的第二个 provider 造轮子（决策 9） | 第二个 agent 真要接入时（如经 ACP） |
| 宿主内置 MCP Host（把无 UI 资源的任意 MCP server 装成应用） | M6 只承诺 MCP Apps（`ui://`）兼容；agent 侧 MCP 走 codex 自带 Host | 出现"非 agent 场景直连 MCP server"的真实需求 |
| 云文档、音视频会议 | 沿用 v1 结论：不做，导航项已移除 | —— |

---

## 12. 一句话总结

**GTD 给骨架（捕获→理清→组织→回顾→执行），注意力保护给纪律（批处理、拉取、降噪），
AI 管家承担苦役，Agent 延伸执行，内网能力保证可信系统永远可用——全部长在一个扩展内核上，
规模控制在一个维护者扛得住的范围内，做成自己每天离不开、也拿得出手的开源作品。**
