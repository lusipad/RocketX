# Super Agent 与 LobeHub 式三栏工作台界面改造计划（Engineering Handoff）

> 文档状态：**已完成落地 / 历史（2026-11-08）**
> 目标：将 RocketX 前端壳层与 AI 管家界面同步升级为「本地优先、单轨紧凑导航、三栏常驻协同、右栏统一 Portal、Pi 开箱即用」的现代 Super Agent 工作台。
> 退出条件：WS-1 至 WS-5 全部落地；浅色/深色主题在 `1280×800` 默认窗口下四列（全局图标轨 + 项目会话栏 + 对话流 + 右侧 Portal）不拥挤、不遮挡；`pnpm check:architecture`、`pnpm typecheck` 与全部回归测试通过；编译桌面安装包验证通过后将本文档状态更新为「历史」。

---

## 1. 背景与现状痛点诊断

后端与协议层已完成 **零登录本地模式（`localMode`）**、**内建通用引擎 Pi（`@earendil-works/pi-coding-agent@1.5.0`）**、**SQLite 统一工作账本（`butler_ledger`）** 与 **受控 Worktree 派工（`superAgentBridge`）**，但当前前端界面仍停留在早期「IM 优先 + Codex 单栏附加页」的壳层结构，存在 5 个直观断层：

1. **零登录首屏错位**：`apps/web/src/stores/ui.ts` 默认模块固定为 `'messages'`，导致未登录 Rocket.Chat 的用户首次启动直接落入嵌入式登录表单，而不是立即可用的本地 AI 管家工作台（`'butler-view'`）。
2. **双重宽侧栏挤压主舞台**：`NavRail`（固定 `210px`）+ `ButlerConversationHistory`（`260~280px`）+ 右侧 `ButlerWorkPortalDock`（`420px`）合计占用 **`890~910px`**；在 Tauri 默认 `1280×800` 窗口下，中间核心对话流仅剩 **`370~390px`**，在 `< 1280px` 时打开 Portal 还会强制 `display: none` 隐藏左栏。
3. **右侧面板互斥割裂**：`ButlerConversation.tsx` 中 `CodexArtifactPanel`（`has-artifact`）与 `ButlerWorkPortalDock`（`has-portal`）互斥二选一；点击对话中的文件/代码产物链接不仅会关掉任务 Portal，还会隐藏左侧项目会话栏。
4. **Pi 首次启用路径过深**：新用户进入 AI 管家时若未配置引擎，只能看到静态空状态提示并跳转到「设置 → AI」填表，缺少原地 30 秒引导（选 DeepSeek / 内网免密网关 / 本地 Ollama 即刻开聊）。
5. **左栏信息噪音与看板入口重复**：
   - 桌面端左栏仍渲染移动端才需要的「返回 RocketX」箭头；
   - 纯本地未登录状态下仍常驻展示空白的「AI 托管（还没有房间托管会话）」区块；
   - `TodosPage` 与 `ButlerPage` 同时内嵌全屏 `WorkKanbanBoard`，且看板点击卡片是在底部纵向追加详情，未复用右侧滑出式 Portal。

---

## 2. 目标界面架构与栅格预算

### 2.1 桌面端黄金四列栅格（以默认 `1280×800` 窗口为基准）

```text
+--------+--------------------+----------------------------------+-----------------------+
| 全局轨 |  管家项目与会话栏   |         核心对话 / 看板主舞台     |   右侧统一上下文 Portal |
|  60px  |       248px        |        minmax(520px, 1fr)        |   380px (340~560可调)  |
| (可展) |                    |        (1280窗口下实得 592px)     |   (可折叠 / Alt+P)     |
+--------+--------------------+----------------------------------+-----------------------+
| 头像   | [对话] [看板 ●2]   | 管家会话 / Issue #400  [wt分支]   | [任务卡] [产物] [动态] |
| ------ | [+ 新对话] [🔍]    | -------------------------------- | --------------------- |
| AI管家 | ------------------ |                                  | ● 执行中 · 受控自动   |
| 消息   | ▾ 系统工作区       |  用户 / Pi 流式 Markdown 对话     | 关联分支: rcx/card-a1 |
| 待办   |   ● 管家会话    3  |  ┌────────────────────────────┐  | --------------------- |
| 日历   |   ○ 临时会话    1  |  │ ⚡ 已派发 Worktree 子会话   │  | 验收证据门禁 (2/2)    |
| 工作台 | ▾ 个人项目     [+] |  └────────────────────────────┘  |  ✓ 单测通过 (最新SHA) |
| ------ |   ▾ rocketchatx 5  |  ┌────────────────────────────┐  |  ✓ Diff 审查无越界    |
| 专注   |     ● 界面改造方案 |  │ 🛡 命令执行审批卡片         │  | --------------------- |
| 设置   |     ○ 修复水合问题 |  └────────────────────────────┘  | [+ 派发隔离 Worker]   |
| 本地●  | ------------------ | -------------------------------- | [标记完成] [打开目录] |
| [展开] | ⚙ Pi · deepseek-v3 | [输入框: 给 Pi 一个任务...     ] |                       |
|        |                    | [🖼] [模型▾] [推理▾] [替我审批▾] |                       |
+--------+--------------------+----------------------------------+-----------------------+
```

### 2.2 响应式断点策略

| 窗口宽度 | 全局 `NavRail` | 左栏 `ButlerConversationHistory` | 中栏主舞台 | 右栏 `UnifiedPortal` |
| --- | --- | --- | --- | --- |
| `>= 1280px` | 默认紧凑 `60px`（支持手动展开 `200px`） | 常驻 `248px` | 自适应 `>= 520px` | 常驻并列 `380px`（支持拖拽 `340~560px`） |
| `960px ~ 1279px` | 固定紧凑 `60px` | 常驻 `232px` | 自适应 `>= 480px` | 展开时采用右侧浮层抽屉（Overlay Drawer `380px`），**不再隐藏左栏** |
| `< 840px` | 隐藏（由左栏抽屉顶部返回按钮承接） | 抽屉唤出 | 单列全宽 | 全屏覆盖层（Overlay） |

### 2.3 视觉与表面层级规范（延续 RocketX 主壳主题变量）

- **不新建第二套色彩系统**，严格使用现有语义 Token（深浅色自动适配）：
  - 全局 `NavRail`：`bg-surface-1` + 右侧 `border-line-strong`；
  - 管家左栏：`bg-surface-1`（与主舞台形成清晰主次对比）；
  - 主对话舞台：`bg-surface`（纯净阅读底色，对话内容区最大可读宽度 `820px` 居中，输入舱对齐同一主轴）；
  - 右侧统一 Portal：`bg-surface-1` + 左侧 `border-line`，内部可操作模块使用 `bg-surface` + `border-line` 轻量分组。
- **主次按钮纪律**：同一视口区域最多 **1 个** 实心强调按钮（`bg-primary text-white`），其余辅助操作统一为描边或幽灵按钮。

---

## 3. 分模块改造规格（Workstreams）

### WS-1：全局壳层紧凑化与零登录首屏直达

- **涉及文件**：
  - `apps/web/src/components/NavRail.tsx`
  - `apps/web/src/stores/ui.ts`
  - `apps/web/src/pages/MainPage.tsx`
- **实施要点**：
  1. **新增 `navCollapsed` 状态**（持久化于 `localStorage`）：
     - 在 `NavRail.tsx` 中支持 `collapsed` 紧凑图标轨模式（宽度 `60px`）：模块图标居中、右上角保留红点/数字角标、`title` 原生悬浮提示、底部保留「专注 / 快捷键 / 设置 / 展开切换」图标按钮；
     - 模块排序优化：将 `AI 管家`（`butler-view`）提升至第一梯队（紧邻 `消息` 或在 `localMode` 下置顶高亮），凸显本地 AI 工作台核心定位；
     - 当进入 `butler-view` 且用户未手动锁定展开态时，默认以 `60px` 紧凑轨呈现，瞬间释放 `150px` 横向空间。
  2. **零登录默认进入 AI 管家**：
     - 在 `apps/web/src/stores/ui.ts`（或 `App.tsx` 首次进入 `localMode` 时）：若 `localStorage` 中尚无用户显式保存的 `rcx-ui` 模块记录且处于免登录本地模式（`localMode === true`），默认激活 `'butler-view'` 而非 `'messages'`；
     - 用户主动点击 `消息` 或 `通讯录` 时，依然按需展示 `LoginPage embedded` 引导连接团队 Rocket.Chat。

### WS-2：管家左栏重构（去噪、双主入口与按需渐进披露）

- **涉及文件**：
  - `apps/web/src/components/ButlerConversationHistory.tsx`
  - `apps/web/src/styles.css`
- **实施要点**：
  1. **精简顶部产品栏**：
     - 桌面端（`>= 840px`）默认隐藏 `.butler-codex-back-rocketx` 返回按钮（CSS 已有媒体查询基础，清理宽屏下的多余占位）；
     - 标题旁显示紧凑运行时胶囊（如 `Pi` 或 `Codex`），点击可快速跳往引擎配置。
  2. **顶部一级分段切换器（对话 / 统一看板）**：
     - 将「对话流 (`conversation`)」与「统一看板 (`kanban`)」设计为左栏顶部的双分段主切换（Segmented Control），看板项右侧实时展示需人工介入的卡片数角标（`waiting_input` / `waiting_approval` / `blocked` + `awaiting_approval` 动作数）。
     - 次级工具入口（`拉取请求`、Codex 专属 `已安排` / `插件`）收敛为精简列表项（`piRuntime` 下继续 `hidden` Codex 专属项）。
  3. **按需渐进披露「房间 AI 托管」**：
     - 当 `localMode && hostedSessionCount === 0` 时，为 `.butler-hosted-sessions` 添加 `hidden` 属性，消除无意义的「还没有房间托管会话」空状态占位；一旦连接了 Rocket.Chat 或存在托管记录则自动展现。
  4. **底部引擎状态微栏（Engine Footer Pill）**：
     - 左栏底部增加一行 `36px` 高的状态微栏：展示当前引擎、当前默认模型（如 `Pi · deepseek-chat` · 绿点就绪 / 黄点待配置）及快捷设置齿轮图标。

### WS-3：中栏对话舞台升级（原地 Pi 引导 + 上下文顶栏 + 结构化动作卡）

- **涉及文件**：
  - `apps/web/src/components/ButlerConversation.tsx`
  - 新增 `apps/web/src/components/PiQuickOnboardingCard.tsx`
  - `apps/web/src/styles.css`
- **实施要点**：
  1. **原地开箱引导卡（`PiQuickOnboardingCard`）**：
     - 触发条件：`ButlerPage` 的 `aiRuntimeProvider === 'none'`，或 `ButlerConversation` 中 `isPi && status === 'unavailable'` / 首次尚未配置凭据；
     - 提供三张场景快速切换：**`DeepSeek API`**、**`内网兼容网关（免密可选）`**、**`Ollama 本地模型（自动探测）`**；
     - 内含 API Base URL、API Key（免密模式下自动折叠为可选）、默认模型输入框，点击 **「立即启用并开始对话」** 直接调用 `writePiConfig` -> `activateAiRuntimeProvider('pi')` -> `reconnectRuntime()`，无需跳去设置页再跳回。
  2. **任务与分支上下文顶栏（Header Context Pills）**：
     - 在 `ButlerConversation` 顶部标题右侧或副标题行，根据 `useWorkLedger` 中 `nativeSessionId === activeThreadId` 查找关联 `WorkCard`：
       - 若已绑定卡片：展示可点击的 **`[看板卡：标题 · 阶段]`** 胶囊与 **`[分支 / Worktree]`** 徽标，点击自动展开右栏 Portal 并选中该卡；
       - 若未绑定卡片且已有对话：提供轻量 **`+ 关联任务卡`** 按钮，支持一键把当前对话沉淀为受控跟踪的 Kanban 卡片。
  3. **结构化工具与子代理进度展现**：
     - 对话过程活动区（`.codex-native-activities`）针对动态宿主工具（`butler_upsert_work_card`、`butler_spawn_isolated_worker`、`butler_record_evidence` 等）映射友好的中文语义标题与图标徽标，派发子会话成功后支持一键点击切换到子线程或打开 Portal 动态页。

### WS-4：右栏统一上下文 Portal（合并任务卡、代码产物与子会话脉搏）

- **涉及文件**：
  - 重构 `apps/web/src/components/ButlerWorkPortalDock.tsx`
  - 协同 `apps/web/src/components/CodexArtifactPanel.tsx`、`apps/web/src/components/WorkCardPortal.tsx`
  - `apps/web/src/components/ButlerConversation.tsx`
  - `apps/web/src/styles.css`
- **实施要点**：
  1. **消除 `has-artifact` 与 `has-portal` 布局冲突**：
     - 在 `ButlerConversation.tsx` 中统一由单一 Portal 开关与 `portalTab: 'card' | 'artifact' | 'activity'` 控制右侧栏；
     - 当 AI 回复生成文件产物或用户点击对话中的 `CodexArtifactLink` 时，自动打开右侧统一 Portal 并切到 **`产物 (artifact)`** Tab，**不再隐藏左侧项目与对话历史栏**！
  2. **三合一 Segmented Tabs 设计**：
     - **`任务卡` Tab**：复用并精修 `WorkCardPortal`（卡片选择器、5 阶段推进、自主级别切换、证据门禁检查清单、一键派发隔离 Worktree Worker）；默认优先自动选中当前 `activeThreadId` 绑定的 `WorkCard`！
     - **`产物` Tab**：内嵌 `CodexArtifactPanel` 预览视图 + 当前会话产生的所有文件链接快捷切换列表；
     - **`动态` Tab**：汇总当前任务关联的所有并行 Session（标注 `Pi` / `Codex` / `DSH` 及 `可实时控制` / `可恢复` / `只读`）、待审批动作（`awaiting_approval` 一键批准/驳回）及最近外部事件。
  3. **宽度可调与快捷键**：
     - 右栏左边缘增加 `4px` 拖拽分隔条（宽度范围 `340px ~ 560px`，默认 `380px`，双击恢复默认）；
     - 支持快捷键 `Alt + P` 随时开关右栏 Portal，顶栏「工作台」按钮实时显示关联卡片状态点。

### WS-5：统一看板与待办模块去重收口

- **涉及文件**：
  - `apps/web/src/components/WorkKanbanBoard.tsx`
  - `apps/web/src/pages/TodosPage.tsx`
- **实施要点**：
  1. **看板页（`WorkKanbanBoard`）改用右侧滑出抽屉**：
     - 移除目前点击卡片后在五列看板正下方纵向堆叠详情块的做法（会导致上下滚动割裂），改为在看板右侧直接并列展开同一个右侧 `WorkCardPortal` 详情抽屉（`400px`），做到「看板点卡」与「对话开 Portal」交互完全一致。
  2. **待办页（`TodosPage`）职责提纯**：
     - 移除 `TodosPage` 内部重复嵌套的 `统一看板` Tab，专注轻快的高密度个人清单（待办 / 今天 / 已逾期 / 已完成）；
     - 在每条待办悬浮操作区提供 **「在管家看板推进」** 按钮（点击调用 `setButlerView('kanban')` 并定位到对应卡片 ID），让个人速记待办与 Super Agent 看板形成顺滑升级漏斗而非重复造轮子。

---

## 4. 架构红线与回归测试兼容合同（Handoff 必读）

实施者在改写上述组件与样式时，**必须严格遵守以下仓库门禁与既有测试契约**：

1. **架构边界零违规（`pnpm check:architecture`）**：
   - 严禁在 `scripts/check-architecture-boundaries.mjs` 白名单之外的任何组件/Store 中直接引入 `@tauri-apps/*` 或调用 `invoke(`；
   - 新增或调用的桌面端命令一律通过 `apps/web/src/platform/desktopCommands.ts`、`desktopDialog.ts`、`desktopFs.ts` 或 `desktopOpener.ts` 转发。
2. **既有源码静态断言与选择器保留清单**：
   - `scripts/regressions/ai-runtime-selection.test.ts`：
     - `AiSettings.tsx` 单选组必须保持 `Codex` → `DSH` → `无 AI` 相对顺序（`Pi` 置于最前），保留 `重启.*生效` 文案与 `persistAiRuntimeProvider` 调用；
     - `ButlerPage.tsx`、`NavRail.tsx`、`ButlerPanel.tsx`、`AgentPanel.tsx` 中严禁出现热切换后端下拉或 `管家执行引擎` / `房间 AI 执行引擎` 字样。
   - `scripts/regressions/butler-entry-points.test.ts` 与 `butler-conversation-entry.test.ts`：
     - `ButlerPage.tsx` 保持 `<ButlerConversationHistory />`、`<ManagedSurface><ButlerRoutines /></ManagedSurface>`、`<ManagedSurface><ButlerPluginsPage /></ManagedSurface>`、`<section aria-label="任务" className="butler-task-surface">`、`<ButlerConversation embedded />`，且不在 `ButlerPage.tsx` 直接访问 `localStorage` 或使用 `role="tab"`；
     - `ButlerConversationHistory.tsx` 保持 `aria-label="新对话"`、`aria-label="Codex 工作区"`、`aria-label="Codex 对话历史"`（CSS 选择器亦依赖此属性）、`aria-label="AI 托管会话"`、`>系统工作区<`、`>个人项目<`、`aria-label="工作项目"`；隐藏非当前引擎或离线空区块时统一使用 `hidden={...}` 属性而非删除语义结构；
     - `ButlerConversation.tsx` 内部禁止使用原生 `<select>` 元素（统一使用现有自定义菜单/分段按钮组件）。
   - `scripts/regressions/local-mode-and-portal.test.ts`：
     - 右侧 Portal 根容器保留 `aria-label="任务工作台面板"`。

---

## 5. 推荐实施顺序（分步提交切片）

建议按以下 4 个原子切片推进，每步均可独立通过 `pnpm typecheck` 与回归测试：

1. **Slice A（壳层与首屏）**：完成 **WS-1**（`NavRail` 60px 紧凑/展开双态 + `localMode` 首次启动直达 `butler-view`）与全局四列 CSS 栅格调整。
2. **Slice B（左栏去噪与原地引导）**：完成 **WS-2**（`ButlerConversationHistory` 双主切换、离线隐藏空托管块、底部引擎状态微栏）+ **WS-3 前半**（`PiQuickOnboardingCard` 原地 30 秒启用 Pi）。
3. **Slice C（右栏统一 Portal 与中栏上下文联动）**：完成 **WS-4**（合并 `Task` / `Artifacts` / `Activity` 三标签统一可调宽 Portal，消除 `has-artifact` 隐藏左栏问题）+ **WS-3 后半**（对话顶栏绑定 `WorkCard` / Worktree 分支胶囊）。
4. **Slice D（看板抽屉统一与待办收口 + 全量验收）**：完成 **WS-5**（`WorkKanbanBoard` 右侧抽屉化、`TodosPage` 一键升级联动），补齐 UI 回归测试并执行桌面端 Release 编译验证。

---

## 6. 验收清单（Exit Verification）

```powershell
# 1. 架构边界与全量类型检查
pnpm check:architecture
pnpm typecheck

# 2. 核心回归与真进程集成测试套件
pnpm exec tsx --test `
  scripts/regressions/ai-runtime-selection.test.ts `
  scripts/regressions/pi-runtime-integration.test.ts `
  scripts/regressions/local-mode-and-portal.test.ts `
  scripts/regressions/butler-entry-points.test.ts `
  scripts/regressions/butler-conversation-entry.test.ts `
  scripts/regressions/butler-work-ledger-kanban.test.ts `
  scripts/regressions/codex-workspace.test.ts

# 3. 桌面端打包冒烟验证（1280×800 浅色/深色、免登录开箱、Pi 原地启用、三栏并列与 Portal 切换）
pnpm prepare:pi-runtime
pnpm --filter @rcx/desktop tauri build --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'
```
