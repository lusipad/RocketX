# RocketX 蓝图 · 从 IM 客户端到内网协作平台

> 状态:草案 v1,2026-07-14
> 前置:M1–M5 已完成(IM 核心 / 进阶 / 工作台 / 待办日历通讯录 / RC 原生能力补齐),当前 v0.14.9
> 本文覆盖 M6–M12

---

## 1. 战略主张

飞书的护城河从来不是 IM 本身,而是**应用容器 + 开放能力 + 数据打通**。IM 只是这个容器的默认首页。

所以接下来三个方向 —— 内网能力、AI、应用扩展 —— **不是三个并列的功能,而是「一个扩展内核 + 三种能力供给」**。

这个区分是本蓝图最重要的一句话,它决定了做法:

- 如果**不先做内核**:内网 P2P 就只是一个"传文件更快"的按钮,AI 就只是一个"总结"按钮,codex 就只是一个 hack。三个孤立特性,任何竞品一个季度就能抄完。
- 如果**先做内核**:这三样都变成**平台能力**——第三方应用能调用局域网直传、能调用 AI 总线、能唤起本地 agent。这才是复利。

而且要注意一个不对称优势:**飞书永远碰不到你的内网。** 局域网 P2P 直传、和存量飞秋/内网通互通、断网降级 —— 这些是 SaaS IM 结构性做不到的事。把它们做成**开放给应用调用的能力**,而不是内置功能,是这个蓝图里最有杠杆的一步。

### 三个已确认的约束(2026-07-14 确认)

| 约束 | 取值 | 影响 |
|---|---|---|
| 网络环境 | **内网为主,可受控出网** | AI 走 Provider 抽象,内网模型(Ollama/vLLM)与外网模型(OpenAI/Anthropic)都支持,由管理员配置;第三方应用允许远程 URL,但必须走域名白名单 |
| 服务端 | **客户端优先,服务端可选** | 每个能力都必须能在纯 Tauri 客户端内跑通;`rcx-hub` 是可选增强(装了才有集中管控/免登/审计) |
| 优先级 | **内核 → Agent/AI → 内网** | M6 内核 → M7 AI 总线 → M8 Agent → M9/M10 内网 → M11 生态 |

> 关于 `architecture.md` 决策 1(「Rocket.Chat 服务端一行不改」):本蓝图**不违反**它。`rcx-hub` 走的是 `ado-bridge` 已经验证过的**旁挂服务**模式 —— 不改 RC 源码、不装 RC App,只是一个独立进程通过公开 API 和 RC 对话。

---

## 2. 现状盘点:我们手里有什么

### 2.1 被低估的资产:桌面壳是 Tauri 2(Rust),不是 Electron

**这是整个蓝图能成立的技术前提。** 三条主线里最硬的部分,恰好是当前架构最擅长的:

| 需求 | Tauri/Rust | 如果是 Electron |
|---|---|---|
| UDP 组播发现 / TCP 直传 | `tokio::net`,原生 | Node dgram/net,和沙箱、`nodeIntegration` 打架 |
| IPMSG 协议栈 | Rust 写二进制协议,天然合适 | 可行但难看 |
| 托管 codex 子进程 + stdio JSON-RPC | `tokio::process`,原生 | `child_process`,需关沙箱 |
| 分发体积 | ~10 MB | ~150 MB(内网分发是真实成本) |

而且 **`apps/desktop/src-tauri/src/winauth.rs`(307 行,WinHTTP NTLM 集成认证)已经把「自定义 Rust 命令 + capabilities 白名单 + 前端 invoke」这条路完整跑通过一次**。后面所有 Rust 侧能力都照抄它的形状。

### 2.2 扩展基建目前是零,但有五处"准扩展点"

全仓库搜 `plugin|extension|插件` 零命中。所有功能都是硬编码的 React 组件。但恰好有五处**硬编码的分发结构**,它们就是内核的天然切口:

| 现有硬编码 | 文件 | 改成什么 |
|---|---|---|
| `ModuleKey` 联合类型(6 个) + `MODULES` 常量数组 | `stores/ui.ts:3`、`components/NavRail.tsx:26` | 一级导航模块注册表 |
| `RightPanel` 联合类型(8 个 `kind`) + `ChatArea.tsx` 里 8 个 `rightPanel?.kind === 'xxx'` 分支 | `stores/chat.ts:77`、`components/ChatArea.tsx` | 右侧上下文栏注册表 |
| `menuItems: MenuItem[]` 数组 | `components/MessageItem.tsx` | 消息动作注册表 |
| `AttachmentCard` 的 if/else 分发链 + `MessageList` 按 `msg.t` 分发 | `components/MessageItem.tsx`、`MessageList.tsx` | 消息渲染器注册表 |
| `slashCommands`(纯服务端)+ `COMMAND_ZH` 手写表 | `stores/chat.ts:392`、`lib/slash.ts:47` | 命令注册表(本地 + 服务端合并) |

**顺带一个必须先还的债**:`Composer.tsx:212-223` 和 `ThreadPanel.tsx:64-71` 各维护了**一份重复的斜杠派发逻辑**。内核改造第一步就是把它们收敛成一个 `dispatchInput()`,否则以后每加一个触发符(`$`、`@app`)都要改两个地方,必然漏。

### 2.3 斜杠命令目前**没有本地注入口子**

`chat.ts:660 runSlash()` 的逻辑是:`findCommand(slashCommands)` 查不到 → toast「没有 /xxx 这个命令」→ **直接 return**。`slashCommands` 全部来自 `rest.listCommands()`(RC 服务端的 27 个)。

也就是说 `/ai`、`$codex` 这类客户端本地命令**现在根本发不出去,会被自己拦下**。这是 M6 必须开的第一个口。

### 2.4 桌面壳权限现在开得过宽(安全债)

`apps/desktop/src-tauri/capabilities/default.json`:

```json
{ "identifier": "http:default", "allow": [{"url": "http://**:*"}, {"url": "https://**:*"}] },
"fs:allow-write-file",
{ "identifier": "fs:scope", "allow": [{"path": "**"}] }
```

任意 http/https + 全盘写。`tauri.conf.json` 的 `"csp": null`。

在**没有第三方代码**的今天这只是"不优雅";**一旦引入第三方应用,这是 P0 漏洞** —— 任何被嵌入的页面都可能拿到全盘写权限。M6 必须收紧,详见 §3.8。

### 2.5 其他要知道的

- 本地状态**全部**在 `localStorage`(`rcx-folders` / `rcx-todos` / `rcx-drafts` / `rcx-auth` …),无 IndexedDB。应用数据、向量索引、离线消息队列都塞不进去 → M6 要引入 IndexedDB 层。
- `packages/rc-client/src/realtime.ts` 的手写 DDP 客户端**已经是一条通用事件总线**(`call` / `subscribe` / `onStream` + 断线重订阅)。内核的事件系统直接架在它上面,不用碰协议层。
- **零 AI 代码、零 LLM 依赖。** 完全从头开始。
- 硬性约定(`architecture.md` 第 95–97 行):**zustand 选择器必须返回稳定引用,否则整页白屏。** 内核所有新 store 必须遵守,这是已经踩过的坑。

---

## 3. 第一部分 · 扩展内核(M6)

### 3.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ 应用层   官方应用 │ 第三方应用 │ MCP Server │ Agent Provider  │
├────────────────────────────────────────────────────────────┤
│ RCX Kernel        apps/web/src/kernel/                      │
│   registry   扩展点注册表(12 类)                             │
│   manifest   应用声明、安装、生命周期                          │
│   permission 权限 scope + 授权 UI                            │
│   sandbox    iframe 容器 / Worker 容器                       │
│   bridge     postMessage + JSON-RPC(MCP Apps 兼容)          │
│   storage    IndexedDB(应用数据 / 向量索引 / 离线队列)         │
├────────────────────────────────────────────────────────────┤
│ 能力总线 Capability Bus  —— 内核暴露给应用的唯一 API 面         │
│   chat.*  rooms.*  users.*  files.*  ui.*  storage.*        │
│   ai.*     ← M7                                             │
│   agent.*  ← M8                                             │
│   lan.*    ← M9/M10   ★ 飞书结构性做不到的部分                 │
├────────────────────────────────────────────────────────────┤
│ 宿主运行时  @rcx/web (React 18 / zustand 5)                  │
│            @rcx/rc-client (REST + 手写 DDP)                 │
├────────────────────────────────────────────────────────────┤
│ Tauri 2 / Rust    winauth.rs(已有) │ proc.rs │ lan.rs │ ipmsg.rs │
├────────────────────────────────────────────────────────────┤
│ 可选服务端  services/rcx-hub  (registry / 免登 JWT / AI 网关 / │
│            IPMSG 常驻网关 / 审计)      services/ado-bridge(已有)│
└────────────────────────────────────────────────────────────┘
```

### 3.2 协议底座:自研内核 + MCP 兼容层

**不是二选一。**

2026-01 发布的 **MCP Apps**(第一个官方 MCP 扩展)把"工具返回交互式 UI"标准化了,机制是:工具在 `_meta.ui.resourceUri` 声明一个 `ui://` 资源(打包好的 HTML/JS)→ 宿主取回 → 沙箱 iframe 渲染 → **postMessage 上跑 JSON-RPC 双向通信** → UI 发起的工具调用需用户显式授权。Claude 桌面版/网页版、Goose、VS Code 已支持。

**直接把它当作我们的应用 Bridge 协议。** 收益:
- 不用自己发明轮子、写规范、写文档
- 白拿生态:任何现成 MCP server 都能当 RocketX 应用装进来
- `$codex` 不再是特例 —— codex 本身就能作为 MCP server / app-server 暴露自己

**但纯 MCP 撑不住全部需求。** MCP 是 LLM 语义的协议,它没有办法表达"往左侧导航栏挂一个一级模块""注册一个消息右键菜单项""在工作台放一张卡片"。所以宿主侧的**扩展点注册表、Manifest、权限模型仍然自研**,MCP 是其中一种应用形态。

### 3.3 扩展点清单(12 类)

| ID | 挂载位置 | 对应现有代码 | 首个用例 |
|---|---|---|---|
| `nav.module` | 左侧一级导航 | `NavRail.tsx` MODULES | 看板应用 |
| `panel.right` | 右侧上下文栏 | `ChatArea.tsx` rightPanel | Agent 会话面板 |
| `message.action` | 消息右键 / 悬浮操作 | `MessageItem.tsx` menuItems | "让 codex 看看这条" |
| `message.renderer` | 自定义消息类型 / 附件卡片 | `AttachmentCard` 分发链 | AI 卡片、审批卡片 |
| `composer.command` | 斜杠命令(**本地**) | `slash.ts` + `runSlash` | `/ai`、`/summary` |
| `composer.trigger` | 输入框触发符(`$` / `@app`) | `markdown.tsx` INLINE_RE | `$codex` |
| `composer.action` | 输入框工具栏按钮 | `Composer.tsx` 工具栏 | AI 润色 |
| `entity.link` | 正文富实体 + 悬停卡片 | `markdown.tsx` `WorkItemLink` | 内网 GitLab/禅道链接 |
| `home.widget` | 工作台卡片 | 工作台硬编码 | 值班表、日报 |
| `room.tab` | 会话内标签页 | 无 | 群公告、群看板 |
| `settings.page` | 设置页 | 无 | 应用配置页 |
| `background.task` | 后台事件订阅 | 无 | 自动归档、提醒 |

> 上个 commit 删掉会议/云文档后,`ModuleKey` 正好空出位置 —— `nav.module` 的第一个用例可以直接补进去。

### 3.4 Manifest(`rcx.app.json`)

```jsonc
{
  "id": "com.corp.kanban",          // 反域名,全局唯一
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
  "netAllow": ["https://kanban.corp.local"],  // net:fetch 的域名白名单,必填

  "contributes": {
    "nav.module":       [{ "id": "kanban", "label": "看板", "icon": "LayoutGrid" }],
    "composer.command": [{ "name": "kanban", "desc": "把这条消息建成卡片" }],
    "message.action":   [{ "id": "to-card", "label": "转成看板卡片" }],
    "home.widget":      [{ "id": "my-cards", "label": "我的卡片", "size": "md" }]
  }
}
```

### 3.5 权限模型

三档,授权时机不同:

| 档 | scope | 授权时机 |
|---|---|---|
| **基础**(安装时一次性告知) | `chat:read` 当前会话可见消息<br>`rooms:list` 会话列表<br>`users:read` 通讯录<br>`storage:local` 应用自己的存储<br>`ui:notify` 发通知 | 安装弹窗展示清单,装即授权 |
| **敏感**(安装时**显式勾选**) | `chat:write` 代发消息<br>`chat:history` 拉历史<br>`files:read` / `files:write`<br>`net:fetch` 出网(**必须配 `netAllow` 白名单**)<br>`ai:invoke` 调 AI 总线<br>`lan:discover` / `lan:transfer` 内网能力 | 安装弹窗逐条勾选,可事后在设置页撤销 |
| **危险**(每次调用二次确认) | `agent:spawn` 起 agent 会话<br>`process:spawn` 起任意本地进程 | **仅限管理员白名单 / 已签名的应用**;每次调用弹审批卡片(允许一次 / 允许本会话 / 拒绝) |

`process:spawn` 是唯一能把任意代码跑在用户机器上的权限。它的存在只是为了 `$codex` 这类**本地可信 agent**。**第三方远程应用一律不得申请。** 内核在安装校验时硬性拒绝:`runtime: "iframe"` + 远程 `entry` + `process:spawn` = 拒绝安装。

### 3.6 三种运行形态

| 形态 | 隔离手段 | 能力 | 用于 |
|---|---|---|---|
| **iframe** | 沙箱 iframe(`sandbox="allow-scripts"`,无 `allow-same-origin`)+ 严格 CSP + 域名白名单 | 全部 UI 扩展点;通过 Bridge 调能力总线 | 第三方在线服务(看板)、MCP Apps 的 `ui://` 资源 |
| **worker** | Web Worker,**无 DOM** | 逻辑扩展点(命令、后台任务、消息渲染的**数据**变换) | 轻量机器人、自动归档规则 |
| **native / mcp** | 独立 OS 进程,stdio JSON-RPC | 通过 MCP 协议暴露 tools / resources / prompts;可返回 MCP Apps UI | `$codex`、内网能力、本地 CLI 工具 |

### 3.7 Bridge 协议

postMessage + JSON-RPC 2.0,方法命名空间与 MCP 对齐。

```
宿主 → 应用   rcx/event      消息到达 / 房间切换 / 主题变化 / 应用被激活
应用 → 宿主   rcx/call       方法名 = 能力总线 API,如 chat.postMessage
应用 → 宿主   rcx/requestUI  申请打开面板 / 弹窗 / 通知
```

所有 `rcx/call` 都过一层 **权限闸门**:检查 scope → 危险权限弹审批 → **写审计日志**(内网合规硬需求)。

### 3.8 安全收紧(P0,和内核同批做)

引入第三方代码的**同一个 PR** 里必须完成:

1. **CSP 从 `null` 收紧**。主窗口 `default-src 'self'`;iframe 应用单独一套,`connect-src` 只允许它 manifest 里声明的 `netAllow`。
2. **`fs:scope` 从 `**` 收窄**到应用沙箱目录 + 用户显式选择的路径(走 `dialog`)。当前的全盘写在没有第三方代码时只是不优雅,有了就是提权漏洞。
3. **`http:default` 的 `**` 白名单收窄**。宿主自己的请求走 RC 服务器域;应用的出网请求由内核代理,按 `netAllow` 逐条校验(**不能让应用直接拿到 `httpFetch`**)。
4. iframe 一律 `sandbox="allow-scripts"`,**不给 `allow-same-origin`** —— 否则沙箱形同虚设。

### 3.9 存储

引入 `packages/rcx-store`(IndexedDB 封装),localStorage 保留给现有的小配置不动:

| 数据 | 位置 |
|---|---|
| 应用注册表、manifest、授权记录 | IndexedDB `apps` |
| 应用私有存储(`storage:local`) | IndexedDB `app-data`,**按 appId 分区隔离** |
| 消息向量索引(M7 语义搜索) | IndexedDB `vectors` |
| 离线消息队列(M10 断网降级) | IndexedDB `outbox` |
| 审计日志 | IndexedDB `audit`,可选上报 `rcx-hub` |

### 3.10 M6 改动清单(文件级)

**新增**
```
apps/web/src/kernel/registry.ts       扩展点注册表(12 类)
apps/web/src/kernel/manifest.ts       manifest 解析 + 校验 + 安装/卸载
apps/web/src/kernel/permission.ts     scope 校验 + 审批 UI + 审计
apps/web/src/kernel/bridge.ts         postMessage JSON-RPC(宿主侧)
apps/web/src/kernel/sandbox/iframe.tsx
apps/web/src/kernel/sandbox/worker.ts
apps/web/src/kernel/capabilities/     chat / rooms / users / files / ui / storage
apps/web/src/kernel/dispatch.ts       ★ 统一输入派发器(收敛 Composer/ThreadPanel 重复逻辑)
packages/rcx-store/                   IndexedDB 封装
packages/app-sdk/                     @rcx/app-sdk —— 给第三方开发者的 Bridge 客户端
```

**改造**
```
stores/ui.ts            ModuleKey 联合类型 → string + 注册表校验
components/NavRail.tsx  MODULES 常量 → registry.get('nav.module')
stores/chat.ts          RightPanel 联合类型 → { kind: string; props?: unknown }
                        runSlash() → 先查本地命令注册表,再落回 rest.runCommand()  ★ 开口子
components/ChatArea.tsx 8 个 rightPanel.kind 分支 → 注册表查找渲染
components/MessageItem.tsx  menuItems 数组 → 内置项 + registry.get('message.action')
                            AttachmentCard 分发链 → renderer 注册表
components/MessageList.tsx  msg.t 分发 → renderer 注册表
components/Composer.tsx     doSend 里的斜杠逻辑 → kernel/dispatch.ts   ★ 去重
components/ThreadPanel.tsx  同上                                       ★ 去重
lib/slash.ts            filterCommands 支持本地+服务端合并
lib/markdown.tsx        INLINE_RE 支持注册的 entity/trigger 规则
src-tauri/capabilities/default.json   ★ 收紧(§3.8)
src-tauri/tauri.conf.json             ★ CSP 从 null 收紧
```

### 3.11 M6 验收

1. 一个 Hello World 应用(iframe),声明 `nav.module` + `composer.command`,装上后左侧出现新模块、`/hello` 能用。
2. **一个真·第三方看板嵌进来**,能读当前会话、能把消息转成卡片、免登(见 M11)。
3. 删掉应用 → 导航项、命令、渲染器全部干净消失,无残留。
4. 越权测试:一个只声明 `chat:read` 的应用调用 `chat.postMessage`,被闸门拒绝 + 审计日志有记录。
5. **CSP / fs / http 三处收紧全部落地**,`smoke.ts` 全绿。

---

## 4. 第二部分 · AI 总线(M7)与 Agent(M8)

### 4.1 为什么 AI 总线要排在 Agent 前面

你更想先看到 `$codex`,但 **Provider 抽象、流式渲染、AI 卡片渲染器**这三样基建,Agent Session 会**原样复用**。先做 Agent 就得把它们临时搭一遍再重写。

**折中:M7 里塞一条快速通道** —— 用最简单的 `codex exec --json`(单轮、非交互、stdout 出结果)先做一个可玩的 `$codex` MVP,大约多花 3–5 天。完整的 `app-server` 长会话版本留到 M8。这样你在 M7 结束时就能真的用上,而不必等到 M8。

### 4.2 AI 总线(M7)

```ts
// apps/web/src/kernel/ai/provider.ts
interface AiProvider {
  id: string
  chat(req: { messages: Msg[]; tools?: Tool[]; stream?: boolean }): AsyncIterable<Chunk>
  embed?(texts: string[]): Promise<number[][]>
}
```

内置三个实现:
- `openai-compatible` —— **一个实现覆盖绝大多数**:Ollama、vLLM、one-api、DeepSeek、Qwen、内网自建网关
- `anthropic`
- `azure-openai`

配置在设置页,支持**多 Provider + 按能力路由**(例:摘要用内网 7B 小模型省钱,codex 用云端强模型)。

**内网合规开关(必做)**:每个 AI 能力可独立配置「仅本地模型」;所有 AI 请求写审计日志。这是"内网为主可受控出网"这个约束的直接产物 —— 不能让一次总结把内部聊天记录发到外网去。

**密钥存放**:纯客户端模式下存本地(Tauri 的 OS keychain);装了 `rcx-hub` 时密钥只在服务端,客户端不下发 —— 这就是"服务端可选"的价值。

### 4.3 会话智能能力清单(M7)

全部走同一条总线,全部复用 M6 的 `message.renderer` 渲染:

| 能力 | 入口 | 备注 |
|---|---|---|
| 会话总结 / 未读速览 | `/summary`、会话列表右键 | "我不在的这两小时群里发生了什么" —— 内网 IM 的高频真实痛点 |
| 翻译 / 润色 / 改写 | Composer 工具栏(`composer.action`) | |
| 语义搜索 | Ctrl+K 升级 | 需 embedding + IndexedDB 向量索引;增量建索引 |
| 智能分类 | 现有 `scripts/test-classify.ts` 升级 | 项目已有分类逻辑,接上 LLM |
| AI 卡片 | 结构化输出 → `message.renderer` | 和审批卡片共用渲染器 |

### 4.4 `$codex` / Agent Session(M8)—— 核心杀手锏

**关键设计:`$codex` 不是一个功能,是通用 Agent Session 机制的一个 Provider。** `$claude`、`$gemini`、任意本地 CLI agent 都是同一机制的配置项。

#### 触发

- `$codex <prompt>` —— 输入框触发符(`composer.trigger`,复用 `#工作项` 那套富实体机制)
- `/agent codex` —— 斜杠命令
- 消息右键 →「让 codex 看看这条」(`message.action`)

#### 流程

1. **内核收集上下文包**(这一步决定了体验好坏,是重点):
   - 当前会话最近 N 条消息(N 可配)
   - 被引用 / 选中的消息及其整条线程
   - 附件:代码块、日志、图片 → 落到临时目录,把路径给 agent
   - 房间元信息:名称、话题、**关联的 ADO 工作项**(工作台已有这层关联,直接复用)
   - 触发者身份
   → 序列化成 markdown,作为 agent 首轮 context

2. **Agent Provider 启动会话**:Rust 侧 `proc.rs` spawn `codex app-server`,stdio 上跑 JSON-RPC。(MVP 阶段用 `codex exec --json` 单轮。)

3. **流式输出渲染成消息气泡**,bot 身份 `codex`,带 agent 标记。

4. **续接**:Agent Session 激活期间,该线程内的后续用户消息**直接路由给 agent**,不发给 RC。`/exit` 结束会话。—— 这就是你要的"无缝对话"。

5. **审批**:agent 要执行命令 / 写文件时,宿主弹审批卡片(允许一次 / 允许本会话 / 拒绝),对应 codex 自己的 approval 机制。**不能让 agent 在用户机器上静默执行命令。**

6. **工作区(cwd)**:配置项 —— 固定目录 / 从房间关联的 git 仓库推导 / 每次会话临时目录。

#### MCP Host + 反向 MCP Server(M8)

- **RocketX 作为 MCP Host**:连接内网 MCP servers(工作项、Wiki、代码搜索、内部 API),AI 总线和 Agent 都能调这些工具。
- **RocketX 反向暴露一个 MCP server**(`rcx-mcp`):让**外部** agent 读取聊天上下文。意味着你在 IDE 里的 Codex 也能读到群里的讨论 —— **双向打通**,这是别人没有的。

### 4.5 M7/M8 验收

- M7:**内网 Ollama 跑通全部 AI 能力,全程零外网请求**(抓包验证)。审计日志完整。
- M7 快速通道:`$codex 解释一下这段报错` + 贴日志 → 能出结果。
- M8:在群里 `$codex`,贴一段报错,agent 读到上下文 → 提方案 → 请求执行命令 → 用户在聊天里点「允许」→ 完成一轮修复,**全程没离开聊天窗口**。
- M8:切换 `$claude`,同一套机制照常工作(证明 Provider 抽象没白做)。

---

## 5. 第三部分 · 内网能力(M9 / M10)

> 这部分是**飞书结构性做不到**的,是差异化的根。但它排在 AI 后面,因为它不依赖内核之外的东西,随时可以并行插队。

### 5.1 LAN 直传(M9)

新增 Rust crate `apps/desktop/src-tauri/src/lan.rs`:

- **发现**:mDNS(`_rcx._tcp.local`)+ UDP 组播兜底。广播:RC userId、设备名、IP、端口、公钥。
- **身份绑定(安全关键)**:用 **RC 的 userId 做身份**,握手时用 RC token 派生的短期凭证互验。**不能只信广播里的自称** —— 否则内网任何人都能冒充。
- **传输**:TCP 直连,1 MB 分片、并发流、断点续传(offset)、BLAKE3 校验、可选 TLS(自签 + RC 身份绑定)。
- **自动路由**:发文件时内核判断 —— 对方在线 + 同网段 → P2P;否则 → 走 RC 上传。UI 显示「局域网直传 · 112 MB/s」。
- **回退**:P2P 失败自动降级服务端上传,**用户无感**。
- **暴露给应用**:`lan.peers()` / `lan.send(userId, file)`(scope `lan:discover` / `lan:transfer`)。

价值:内网千兆环境传 GB 级设计图 / 代码包,速度差一个数量级,而且**不占服务器存储和带宽**。

### 5.2 IPMSG 网关(M10)—— 存量用户迁移的杀手锏

新增 `apps/desktop/src-tauri/src/ipmsg.rs`。协议:**UDP 2425**(发现/消息)+ **TCP 2425**(文件)。

报文格式:`Ver:PacketNo:SenderName:SenderHost:CommandNo:AdditionalSection`
命令字:`BR_ENTRY`(上线广播)/ `BR_EXIT` / `ANSENTRY` / `SENDMSG` / `RECVMSG` / `GETFILEDATA` / `RELEASEFILES`

**两种模式:**

| 模式 | 部署 | 效果 |
|---|---|---|
| **共存模式**(客户端内置) | 零部署 | RocketX 同时以 IPMSG 身份上线。**飞秋/内网通用户能在他们的列表里看到你、给你发消息和文件。** 这些消息进入 RocketX 的一个虚拟频道(「局域网」) |
| **网关模式**(`rcx-hub` 常驻) | 一台机器 | 把整个 IPMSG 网络双向桥接到 RC 频道,适合大规模过渡期 |

**为什么这是杀手锏**:推广内网 IM 最大的阻力永远是"老王还在用飞秋,我发给他他收不到"。共存模式**直接消灭这个阻力** —— 不需要全员同一天切换。

⚠️ **风险:飞秋 / 内网通对原版 IPMSG 有私有扩展**(加密、扩展字段、中文编码差异),不完全兼容。**M10 开工前必须先做一个抓包 spike**(见 §8),否则可能做出一个只能和"原版 IP Messenger"互通、和国产变种互不理睬的东西。

### 5.3 断网降级(M10)

RC 服务器不可达时,同网段用户之间**仍可通过 LAN 通道聊天**。消息进 IndexedDB `outbox`,RC 恢复后带原始时间戳回灌。

内网机房抖动、跨楼层网络故障是真实高频场景 —— **"服务器挂了还能聊"是一个非常硬的卖点**,SaaS IM 永远给不了。

### 5.4 其他内网候选(按性价比排序,择机插入)

1. **内网服务 unfurl + 单点登录**:GitLab / Jira / 禅道 / Confluence / SVN 链接预览。**高价值、低成本** —— 直接复用 `entity.link` 扩展点和现有的 `WorkItemLink` 悬停卡片,几乎白送。
2. **局域网紧急广播**:全员喊话。政企刚需,IPMSG 协议本身就支持。
3. **共享盘路径解析**:粘贴 `\\nas\share\x.pdf` 直接预览。
4. **P2P 分发客户端更新包**:省内网带宽,顺带解决 Tauri 自动更新在隔离网的难题。

### 5.5 M9 / M10 验收

- M9:千兆内网传 5 GB 文件,**给出 P2P vs 服务端上传的实测对比数字**;中途拔网线 → 重连后断点续传成功;文件 BLAKE3 校验通过。
- M9:冒充测试 —— 伪造一个广播包声称是别人的 userId,握手被拒。
- M10:**飞秋 ↔ RocketX 双向收发消息 + 文件成功**(用真实飞秋客户端,不是自己写的测试桩)。
- M10:拔掉 RC 服务器 → 同网段两个客户端仍能聊天 → 恢复后消息回灌且顺序正确。

---

## 6. 第四部分 · 应用生态(M11)

内核是地基,生态才是目的。

- **`@rcx/app-sdk`**:npm 包,封装 Bridge JSON-RPC,TypeScript 类型完整。第三方开发者只面对它。
- **`create-rcx-app`** 脚手架 + `rcx-app dev`(本地热重载)+ `rcx-app validate`(manifest 校验)。
- **免登(SSO)** —— 接入第三方在线服务的关键:应用打开时,宿主(或 `rcx-hub`)签发**短期 JWT**(含 userId / roomId / 签名),第三方服务验签即可免登。**没有这个,"接入别人开发的看板"就是让用户再登一次,体验直接归零。**
- **私有应用市场**:`rcx-hub` 上一个 JSON index + 静态文件服务;管理员审核 / 白名单 / 强制推送。纯客户端模式下降级为"从本地目录 / 管理员推送的包安装"。
- **官方样板应用(首发 5 个)**:看板、Codex Agent、值班表、投票、审批。样板应用的真正作用是**验证扩展点设计够不够用** —— 如果官方应用还要"开后门"才能实现,说明内核设计有漏。

**M11 验收**:一个**外部开发者**,只看文档,30 分钟内发出第一个能用的应用。

---

## 7. 横切 · 安全与信创(M12)

内网为主的部署环境,这些是**准入门槛**而非加分项:

- **信创适配**:麒麟 / 统信 UOS + 龙芯 / 飞腾。⚠️ **Tauri 在国产 Linux 上依赖 WebKitGTK,这是本蓝图最大的技术风险**(见 §8)。
- **等保三级相关**:消息水印、防截屏、审计日志、三员管理。
- **应用签名**:第三方应用包签名校验,防篡改。

---

## 8. 必须提前做的 Spike(在对应里程碑开工前)

这三件事**做晚了会推翻架构**,每个 2–5 天:

| # | Spike | 为什么必须早做 | 什么时候 |
|---|---|---|---|
| 1 | **Tauri 在麒麟 / 统信 UOS 上的 WebKitGTK 兼容性** | 如果国产 Linux 的 WebKitGTK 版本过老、渲染或 iframe 沙箱行为异常,**整个桌面壳选型都要重新评估**(可能被迫回 Electron)。这会推翻本蓝图的技术前提。**越晚发现越贵。** | **立刻,M6 之前** |
| 2 | **飞秋 / 内网通的 IPMSG 私有扩展抓包** | 决定 M10 是"两周的事"还是"两个月的事"。也可能发现某个变种根本无法互通,需要调整承诺。 | M9 期间 |
| 3 | **codex app-server 的 stdio JSON-RPC 实测** | 验证长会话、审批回调、流式输出在 Tauri 子进程里能不能跑通。M8 的全部设计压在这个假设上。 | M7 期间 |

---

## 9. 里程碑总表

| 里程碑 | 内容 | 估时 | 依赖 |
|---|---|---|---|
| **Spike 1** | 信创 WebKitGTK 兼容性 | 2–3 天 | — |
| **M6** | 扩展内核 + 安全收紧 + IndexedDB + SDK v0 | 4–5 周 | Spike 1 |
| **M7** | AI 总线 + 会话智能 + `$codex` MVP(快速通道) | 3–4 周 | M6 |
| **M8** | Agent Session(完整)+ MCP Host + 反向 MCP Server | 4 周 | M7 |
| **M9** | LAN P2P 直传 | 3–4 周 | M6(能力总线) |
| **M10** | IPMSG 网关 + 断网降级 | 3–4 周 | M9 |
| **M11** | 应用生态:SDK / 脚手架 / 免登 / 市场 / 5 个样板应用 | 3–4 周 | M6 |
| **M12** | 信创适配 + 水印 / 审计 / 签名 | 持续 | — |

**关键路径**:Spike 1 → M6 → M7 → M8。M9/M10(Rust 侧)和 M11(生态)可以随时并行插队,它们只依赖 M6。

---

## 10. 现在就要拍板的技术决策

| # | 决策 | 我的建议 |
|---|---|---|
| 1 | 应用协议:自研 vs MCP | **自研内核 + MCP Apps 作为 Bridge 协议**。白拿生态,又不被 LLM 语义限制住 UI 扩展点 |
| 2 | 沙箱:iframe vs Tauri WebviewWindow | **先 iframe**(简单、和 MCP Apps 一致);高危应用未来可升级到独立 WebviewWindow |
| 3 | 应用数据存哪 | **IndexedDB**。localStorage 装不下向量索引和离线队列 |
| 4 | 跨设备同步应用配置 | 先不做。真要做,用 RC 的 `users.setPreferences` 或一个私有频道当存储,**不改 RC 源码** |
| 5 | LAN P2P:Rust 原生 socket vs WebRTC | **Rust 原生 TCP**。有 Tauri 就别绕 WebRTC 的信令和 NAT 穿透 —— 内网本来就通 |
| 6 | 第三方应用能否用远程 URL | **能,但必须走 `netAllow` 域名白名单 + CSP `connect-src` 双重限制** |
| 7 | AI 密钥存哪 | 纯客户端 → OS keychain;装了 `rcx-hub` → 只在服务端,不下发 |

---

## 11. 一句话总结

**先把五处硬编码改成注册表,拿到内核;再让 AI、Agent、内网能力全部以"应用可调用的能力"形态挂上去。** 这样飞书能抄的你都有,飞书抄不了的(内网 P2P、协议互通、断网可用、本地 agent)只有你有。
