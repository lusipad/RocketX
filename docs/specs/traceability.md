# 功能规格追踪索引

> 基线：工作树 `2026-08-18`
> 用途：从验收 ID 定位当前实现、自动化证据和仍需真实验证的部分。

路径缩写：表中的 `pages/`、`stores/`、`components/`、`lib/`、`agent/` 均相对于 `apps/web/src/`；未带目录的 `*.test.ts` 均相对于 `scripts/regressions/`。`tests/ui/` 和 `apps/desktop/` 使用仓库根目录完整路径。

## Agent 工作台 S1 增量

2026-11-15 工作树的[输入与工作上下文规格](agent-workspace-input-and-context.md)单独追踪；运行结果统一保存在[实施记录](../implementation-notes-rocketx-agent-workspace-refactor.md)，不将模拟执行器证据视为真实 Codex 接续。

| 验收 ID | 主要实现 | 自动化入口 | 验证状态与边界 |
| --- | --- | --- | --- |
| AWC-S1-01–04 | components/ButlerConversation.tsx、components/AcpWorkspaceSurface.tsx、components/CodexImagePicker.tsx、stores/agentComposerDrafts.ts、stores/codexWorkspace.ts、agent/AppServerController.ts | tests/ui/agent-composer-reliability.spec.ts、agent-composer-runtime.test.ts | R、UI；真实 Windows 输入法另验；工作详情／SQLite 的真实 WebView 证据单列如下，不代替全部草稿行为 |
| AWC-S1-05–06 | components/ButlerWorkPortalDock.tsx、components/ButlerConversation.tsx、lib/workContext.ts | tests/ui/agent-work-context.spec.ts、work-context-report.test.ts | R、UI；详情与成果归属、删除选择、后台更新与显式标签切换 |
| AWC-S1-07–08 | agent/workflowReport.ts、components/WorkflowReportCard.tsx | work-context-report.test.ts、tests/ui/agent-work-context.spec.ts | R、UI；真实计划计数与无计划状态，不代表验收完成 |

### 2026-11-16 工作台易用性增量

现行行为见[输入与工作上下文规格第 7 节](agent-workspace-input-and-context.md#7-2026-11-16-工作台易用性增量)，不改变原生交接、人工验收或外部写入权限。

| 验收 ID | 主要实现 | 自动化入口 | 验证状态与边界 |
| --- | --- | --- | --- |
| AWC-UX-01–03 | components/WorkSessionImport.tsx、components/WorkSessionHistoryPreview.tsx、components/AcpWorkspaceSurface.tsx、agent/superAgentBridge.ts | work-session-import.test.ts、tests/ui/work-session-import.spec.ts | R、UI；300 条发现上限、30 条分页、批量／部分失败／完整身份／账号隔离；只读预览最多 24 条，不能证明完整历史或活动接管 |
| AWC-UX-04 | components/WorkKanbanBoard.tsx、agent/superAgentBridge.ts | tests/ui/workboard-usability.spec.ts、work-session-import.test.ts | R、UI；普通优先级、摘要区分、当前版本记录／阻碍、初始扫描共享状态及窄窗，不将未知活动状态显示为运行 |
| AWC-UX-05–06 | components/WorkCardPortal.tsx | tests/ui/work-portal-usability.spec.ts、work-acceptance-portal.spec.ts、workflow-report-delivery.spec.ts | 阅读优先、折叠管理、跨卡迟到保存 CAS／新输入／错误隔离及最新失败可见；定向复现含先红后绿与 StrictMode；本轮未重跑原生 WebView |

## 1. 证据等级

S2–S5 的现行合同见[执行、验收与可靠投递](agent-workspace-execution-and-delivery.md)，可选 S6 见[本地语音](local-voice.md)。本轮新增追踪如下，最终运行结果以[实施记录](../implementation-notes-rocketx-agent-workspace-refactor.md)为准。

| 方案验收 | 实现 | 行为证据 |
| --- | --- | --- |
| AC01–02、07–12 | codexHostTools、workLedger、workCoordinator、workArtifacts、原生 butler_ledger／butler_worktree、WorkCardPortal | work-host-lifecycle、work-ledger-lifecycle、work-acceptance-contract、work-ci-evidence、workflow-end-to-end；work-acceptance-portal UI |
| AC03–06、29 | local_sessions、acp_bridge、acpAgents、sessionAdapter、superAgentBridge | native-session-handoff；原生身份／令牌 Rust 测试；native-session-handoff UI；smoke-native-codex-handoff |
| AC13–15、26 | externalActionExecutor、externalWorkActions、workflowReport、WorkflowReportCard | external-work-actions、external-work-actions-integration、workflow-report-identity、workflow-end-to-end；workflow-report-delivery UI；smoke-local-report-delivery 在真实 RC 8.6.1 验证 3 段正常＋1 条丢回执、重复 0、恢复写入 0；ADO 401，真实写入未验收 |
| AC08–09、16–19、27–28 | workSupervisor、superAgentBridge、codexWorkspace、ACP 审批与取消 | work-supervisor、work-supervisor-runtime、codex-workspace-parallel、native-session-handoff；隔离实机 Alt+F4 隐藏／single-instance 再启动显示及隔离进程中止后同工作恢复已验；未点击物理托盘菜单，系统休眠另验 |
| AC20–24、30a | 草稿、阅读位置、工作上下文、工作台与导航 | agent-composer-reliability、agent-reading-position、agent-work-context、agent-workboard-state UI（100 条、半屏、缩放与键盘） |
| AC25、30b | butler_account、账号代际保护、butlerMemory、workSearch、workMethods | work-account-generation；butler_account／butler_memory Rust；work-context-memory、work-context-search、work-method-reuse；work-context-memory-search UI |
| AC31 | components/LocalVoiceControls.tsx、lib/localVoiceAudio.ts、stores/localVoice.ts、platform/localVoice.ts、apps/desktop/src-tauri/src/local_voice.rs／local_voice.ps1 | local-voice-audio；tests/ui/local-voice.spec.ts；Rust local_voice 专项 7／7，含真实离线 TTS→ASR 和挂起探测取消；desktop-voice-ipc 的真实 Tauri 探测／静默合成识别及输入限制通过；物理拾音／播放未验收，限 Windows 可选 PTT |
| 原生工作保存 | desktopCommands.ts、apps/desktop/src-tauri/src/butler_ledger.rs、WorkCardPortal | work-ledger-native-ipc；smoke-desktop-workspace 的隔离 Tauri WebView 创建→详情保存→SQLite 回读→刷新→隔离进程中止后重启，同工作、要求版本 2／成果版本 0、暂停状态保持；不代替托盘退出菜单或 IME 验收 |
| 测试凭据隔离 | apps/desktop/src-tauri/src/credential_scope.rs、业务 MCP／Agent bot／LAN／live_e2e 的 keyring 入口 | credential_scope Rust 4 项；正式 service 名称兼容、测试标识独立、未初始化拒绝访问；实际桌面实例使用独立标识与数据路径 |

| 等级 | 含义 | 能否单独证明“已实现” |
| --- | --- | --- |
| S | 静态结构/源码断言 | 否；只能证明入口或约束存在 |
| R | 回归/单元/协议自动化 | 通常可以证明确定性分支 |
| UI | 浏览器交互自动化 | 可以证明界面和模拟集成行为 |
| INT | 真实服务或真实 Codex 集成 | 可以证明外部系统主流程 |
| MAN | 候选产物人工验证 | 用于操作系统、发布产物和难自动化交互 |

“UI mock 通过”不能替代真实 ADO、Rocket.Chat、Codex 或操作系统验证。历史测试如果依赖已删除的旧 Runtime、旧 Memory 或旧委托界面，也不能继续作为当前能力证据。

## 2. 首次引导、账号与连接

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `ONB-AC-01` | `pages/FirstRunPage.tsx`、`lib/firstRun.ts` | `scripts/regressions/first-run.test.ts`、`tests/ui/core-flows.spec.ts` 深色对比度 | 新安装包 MAN |
| `ONB-AC-02`、`ONB-AC-03`、`ONB-AC-04` | `components/WorkspaceConfigImport.tsx`、`lib/workspaceConfig.ts` | `workspace-config.test.ts`、`workspace-config-source.test.ts` | 真实远程 Raw URL |
| `ONB-AC-05` | `WorkspaceConfigImport.tsx`、`stores/auth.ts` | `workspace-config.test.ts`、`onboarding.test.ts` | 切换真实服务器 |
| `ONB-AC-06` | `pages/LoginPage.tsx`、`lib/loginDiagnostic.ts` | `tests/ui/core-flows.spec.ts` | 真实错误分类 |
| `ONB-AC-07`、`ONB-AC-08` | `pages/FirstRunPage.tsx`、`lib/firstRun.ts`、`lib/notify.ts`、`lib/autostart.ts` | `first-run.test.ts`、`autostart.test.ts`、`pnpm test:ui:release` | Windows/macOS/Linux 正式包首次安装与覆盖升级 MAN |

## 3. 消息与会话

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `MSG-AC-01` | `stores/chat.ts`、消息动作组件 | `chat-send-idempotency.test.ts`、`message-delete.test.ts`、`issue-232-thread-main.test.ts` | 真实 Rocket.Chat 权限矩阵 |
| `MSG-AC-02` | 消息列表与贴底逻辑 | `message-scroll.test.ts`、`message-output.test.ts` | 长历史人工滚动 |
| `MSG-AC-03` | 快速搜索、用户目录 | `user-search.test.ts`、`user-directory.test.ts`、`search-filters.test.ts` | 中文生产目录 |
| `MSG-AC-04` | `components/Avatar.tsx`、`ConversationList.tsx`、`ChatArea.tsx` | `chat-header-presence.test.ts` | 在线状态实时切换 |
| `MSG-AC-05` | 搜索页面与筛选模型 | `quick-search.test.ts`、`search-filters.test.ts` | 服务端正则设置 |
| `MSG-AC-06` | 文件索引、下载与桌面桥接 | `file-index.test.ts`、`download-history.test.ts`、`tests/ui/download-history.spec.ts` | 发布产物文件对话框 |
| `MSG-AC-07` | `stores/chat.ts`、实时客户端 | `tests/ui/core-flows.spec.ts` | 真实断网/恢复 INT |
| `MSG-AC-08` | `stores/chat.ts`、`components/MessageList.tsx`、`lib/messageScrollDiagnostics.ts` | `message-scroll.test.ts`、`diagnostics.test.ts`、`tests/ui/core-flows.spec.ts` | Windows WebView2 连续切房与三平台正式包 MAN |
| `MSG-AC-09` | `packages/rc-client/src/files.ts`、`apps/web/src/lib/download.ts` | `issue-393-download-resume.test.ts`、`file-transfer.test.ts` | 真实反向代理掐断 HTML 附件传输 |
| `MSG-AC-10` | `components/MessageItem.tsx`、`lib/downloadHistory.ts`、Tauri `download_history_open` | `download-history.test.ts`、`tests/ui/core-flows.spec.ts` | Windows 正式包点击已下载附件、删除本地文件后再点击 |

## 4. 工作台与个人效率

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `WB-AC-01`、`WB-AC-02`、`WB-AC-03` | `pages/WorkbenchPage.tsx`、`stores/workbench.ts`、`components/AdoLists.tsx` | `workbench-refresh.test.ts`、`custom-query.test.ts`、`ado-open-issues.test.ts` | 真实 ADO INT |
| `WB-AC-04`、`WB-AC-05` | `lib/adoDirect.ts`、工作项写动作 | `ado-write-actions.test.ts` | 写超时/并发冲突 INT |
| `WB-AC-06` | ADO 受管 Skill 与业务 MCP | `ado-skill-cli.test.ts`、`app-server-controller.test.ts` | 自然语言真实任务 INT |
| `WB-AC-07`、`WB-AC-08` | `pages/ProfileContributionsPage.tsx`、`components/ContributionHeatmap.tsx`、`stores/profileContributions.ts` | `profile-contributions-ui.test.ts`、`tests/ui/core-flows.spec.ts` | 真实 ADO 身份、时区和链接 INT |
| `WB-AC-09`、`WB-AC-10` | `lib/adoContributions.ts`、`lib/adoDirect.ts` | `profile-contributions-data.test.ts`、`profile-contributions-pr-only.test.ts` | ADO Server 2022 大实例 PR 分页、项目权限局部失败与 NTLM 取消边界 INT |
| `PERS-AC-01` | `stores/todos.ts` | `manual-todo.test.ts` | 桌面 DB 失败注入 |
| `PERS-AC-02` | 各本地 Store 的账号作用域 | `manual-todo.test.ts`、`download-history.test.ts` | 真实切换账号 |
| `PERS-AC-03` | `stores/calendar.ts` | 日历相关 regression / UI | 多来源失效组合 |
| `PERS-AC-04` | 通讯录与用户目录 | `user-directory.test.ts`、`user-search.test.ts` | 中文生产目录 |
| `PERS-AC-05` | 下载记录与 Tauri 文件命令 | `download-history.test.ts`、`tests/ui/download-history.spec.ts` | 发布产物 MAN |

## 5. 管家、目录与 Memory

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `BUT-AC-01`、`BUT-AC-02` | `agent/AppServerController.ts`、`stores/codexWorkspace.ts`、`components/ButlerConversationHistory.tsx` | `app-server-controller.test.ts`、`codex-workspace.test.ts` | 真实 Thread 生命周期 INT |
| `BUT-AC-03` | `ButlerConversation.tsx`、`agent/attachments.ts` | `codex-workspace.test.ts`、`tests/ui/butler-workspace.spec.ts` | 真实多模态 Turn INT |
| `BUT-AC-04` | `stores/codexWorkspace.ts` | `codex-workspace.test.ts`、`butler-stop-process.test.ts` | Steer/Queue 真实时序 INT |
| `BUT-AC-05` | 请求路由、输入卡片 | `tests/ui/butler-host-input.regression-1.spec.ts` | 真实 Codex 请求 INT |
| `BUT-AC-06` | `agent/codexTransfer.ts`、`refreshFromCodex` | `codex-transfer.test.ts`、`codex-workspace.test.ts` | Codex App 顺序接续 MAN |
| `BUT-AC-07` | Runtime 门禁与 unavailable 状态 | `codex-runtime.test.ts`、`tests/ui/butler-workspace.spec.ts` | Web 部署 MAN |
| `BUT-AC-08` | `pages/ButlerPage.tsx`、启动级 AI 运行时选择、Codex/DeepSeek 视图 | `dsh-view.test.ts`、`butler-entry-points.test.ts`、`tests/ui/butler-workspace.spec.ts` | 正式桌面重启生效 MAN |
| `BUT-AC-09` | `pages/ButlerPage.tsx`、`components/DshConversation.tsx`、`components/DshQuestionCard.tsx`、`agent/dsh/DshController.ts`、`agent/dsh/HostedDshController.ts`、`apps/desktop/src-tauri/src/dsh_bridge.mjs` | `dsh-controller-runtime.test.ts`、`hosted-dsh-controller.test.ts`、`dsh-bridge-script.test.ts`、`dsh-view.test.ts` | 官方 DSH Web iframe 宿主与 loopback URL INT |
| `BUT-AC-10` | `agent/dsh/DshController.ts`、`agent/dsh/HostedDshController.ts` | `dsh-controller-runtime.test.ts`、`hosted-dsh-controller.test.ts` | 进程崩溃与恢复 INT |
| `EXT-AC-01`、`EXT-AC-02`、`EXT-AC-03` | `agent/AppServerController.ts`、`components/ButlerPluginsPage.tsx` | `butler-plugin-marketplace-ui.test.ts`、`butler-bundled-skills.test.ts` | 真实目录 INT |
| `EXT-AC-04` | `stores/codexWorkspace.ts` 的安装/启停动作 | `tests/ui/butler-workspace.spec.ts` | Marketplace 安装/卸载 INT |
| `EXT-AC-05` | Runtime 门禁与目录错误隔离 | `butler-plugin-marketplace-ui.test.ts` | Web/no Runtime MAN |
| `MEM-AC-01`、`MEM-AC-02` | `agent/AppServerController.ts` 的 `startThread/resumeThread` | `app-server-controller.test.ts` | 真正跨 Thread Memory INT |
| `MEM-AC-03`、`MEM-AC-04`、`MEM-AC-05` | 原生 Memory 架构与规格约束 | 源码搜索 + 文档审查 | 用户审阅/重置尚未实现 |

## 6. 已安排、共享 Agent 与审批

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `SCH-AC-01` | `ButlerRoutines.tsx`、`ButlerRoutineCreateDialog.tsx` | `butler-routines-layout.test.ts`、`tests/ui/butler-workspace.spec.ts` | 候选版 MAN |
| `SCH-AC-02` | `stores/routines.ts`、`agent/codexAutomation.ts` | `routines.test.ts` | 真实立即运行 INT |
| `SCH-AC-03`、`SCH-AC-04` | 本机 scheduler/tick | `routines.test.ts` | 短周期、休眠、退出 MAN |
| `SCH-AC-05`、`SCH-AC-06` | 自动化预检与 Server Request 策略 | `routines.test.ts`、`codex-workspace.test.ts` | 真实审批请求 INT |
| `SCH-AC-07` | 本机 Storage 与页面文案 | `routines.test.ts`、`tests/ui/butler-workspace.spec.ts` | 双设备 MAN |
| `AGT-AC-01` | `stores/sharedAgent.ts` | `shared-agent-runtime.test.ts` | 无 Runtime MAN |
| `AGT-AC-02` | `stores/agentEnvironments.ts`、`components/ButlerProjectConfigDialog.tsx` | `agent-environments.test.ts` | 两会话真实竞争 |
| `AGT-AC-03`、`AGT-AC-04` | `components/AgentPanel.tsx`、`components/ChatArea.tsx`、请求路由 | `agent-session.test.ts`、`agent-context.test.ts`、`tests/ui/core-flows.spec.ts` | 真实房间 INT |
| `AGT-AC-05` | 共享 Agent 租约逻辑 | `shared-agent-runtime.test.ts` | 两设备 INT |
| `AGT-AC-06` | 中断恢复与环境释放 | `agent-session.test.ts`、`shared-agent-runtime.test.ts` | 进程崩溃 INT |
| `AGT-AC-07` | 产品/规格门禁 | 文档与入口审查 | 独立委托未实现 |
| `AGT-AC-08`、`AGT-AC-09` | `stores/sharedAgent.ts`、`components/AgentPanel.tsx`、`agent/dsh/HostedDshController.ts` | `agent-hosting-backend.test.ts`、`hosted-dsh-controller.test.ts`、`shared-agent-runtime.test.ts` | 共享 Agent 继承全局启动级运行时的真实房间 INT |
| `AGT-AC-10`、`AGT-AC-11` | `stores/sharedAgent.ts`、`lib/runtimeMode.ts`、`components/AgentPanel.tsx`、`components/Composer.tsx`、`components/ThreadPanel.tsx` | `agent-card.test.ts`、`shared-agent-runtime.test.ts`、`butler-hosting-session-identity.test.ts`、`tests/ui/core-flows.spec.ts`、`tests/ui/ai-mention.spec.ts` | 两设备与 Web 实服 INT |
| `PERM-AC-01`、`PERM-AC-02` | `permissionSettings`、`components/ButlerConversation.tsx` | `app-server-controller.test.ts`、`codex-workspace.test.ts` | 上游 Profile 版本变化 |
| `PERM-AC-03`、`PERM-AC-04`、`PERM-AC-05`、`PERM-AC-06` | Server Request 路由、审批与输入卡 | `tests/ui/butler-host-input.regression-1.spec.ts` | 真实命令/MCP 请求 INT |
| `PERM-AC-07` | `agent/codexAutomation.ts` | `routines.test.ts` | 真实无人值守审批 INT |
| `PERM-AC-08`、`PERM-AC-09` | `agent/dsh/protocol.ts`、`agent/dsh/DshController.ts`、`agent/dsh/HostedDshController.ts` | `dsh-controller-runtime.test.ts`、`hosted-dsh-controller.test.ts`、`dsh-bridge-script.test.ts` | DSH 原生审批/问题 INT |

## 7. Runtime 与平台

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `RUN-AC-01`、`RUN-AC-02`、`RUN-AC-03` | `apps/desktop/src-tauri/src/proc.rs`、Runtime 探测 | `codex-runtime.test.ts`、Rust tests | 安装/未登录/多版本 MAN |
| `RUN-AC-04` | 进程管理、Controller shutdown、Store 恢复 | `butler-stop-process.test.ts`、`app-server-controller.test.ts` | 强杀进程 INT |
| `RUN-AC-05` | 两份 Tauri bundle 配置 | `codex-bundled-resource.test.ts` | 发布产物内容审计 |
| `RUN-AC-06` | Tauri-only transport 与 Web 门禁 | `codex-runtime.test.ts`、UI | 部署 Web MAN |
| `RUN-AC-07` | 原生 Thread resume | `codex-workspace.test.ts` | `pnpm smoke:codex-lifecycle` |
| DSH 固定运行时 | `apps/dsh-runtime/package.json`、`scripts/prepare-dsh-runtime.mjs`、`apps/desktop/src-tauri/src/dsh.rs` | `dsh-bundled-runtime.test.ts`、Rust tests、部署树 CLI/profile/PTY/bridge smoke | macOS universal 与 Linux 安装产物 INT/MAN |
| `PLAT-AC-01` | 主导航与管家布局 | `tests/ui/butler-workspace.spec.ts` | 各分辨率视觉 MAN |
| `PLAT-AC-02` | 平台检测、`lib/autostart.ts`、Tauri transport | `autostart.test.ts`、`codex-runtime.test.ts` | Web 部署 MAN |
| `PLAT-AC-03` | `apps/desktop/src-tauri/src/main.rs` | Rust tray tests | 三平台发布产物 MAN |
| `PLAT-AC-04` | `lib/autostart.ts`、`apps/desktop/src-tauri/src/main.rs`、系统插件 | `autostart.test.ts`、Rust tests、`tests/ui/core-flows.spec.ts` | Windows/macOS/Linux MAN |
| `PLAT-AC-05` | `UpdaterBridge.tsx`、`lib/updateSource.ts`、`apps/desktop/src-tauri/src/proc.rs` | `update-source.test.ts`、Rust tests | 签名 Release 与真实 UNC 有签名/无签名安装 MAN |
| `PLAT-AC-06` | Tauri bundle/OCR 配置 | `image-ocr.test.ts`、`codex-bundled-resource.test.ts` | 精简/全量产物审计 |
| `PLAT-AC-07` | `lib/runtimeMode.ts` | `issue-264-performance-mode.test.ts` | 长时间资源观察 |
| `PLAT-AC-08` | `lib/unread.ts`、`lib/tray.ts` | `tray-flash.test.ts`、`taskbar-badge.test.ts`、通知聚合 tests | 三平台 MAN |
| `PLAT-AC-10` | `lib/uiScale.ts`、`components/DesktopUiScaleBridge.tsx`、`stores/uiPrefs.ts`、Tauri capability | `ui-scale.test.ts`、`tests/ui/core-flows.spec.ts` | 三平台 1080p 发布产物清晰度与快捷键 MAN |
| `PLAT-AC-11` | `apps/desktop/src-tauri/src/main.rs`、WebView2 官方内存目标 | `webview-memory.test.ts`、Windows Release 前后进程采样 | macOS/Linux 系统 WebView 不适用；Windows 长时间驻留观察 |
| `PLAT-AC-12` | Tauri DSH resource、`scripts/prepare-dsh-runtime.mjs`、`apps/desktop/src-tauri/src/dsh.rs` | `dsh-bundled-runtime.test.ts`、`official-plugins.test.ts`、桌面 Rust tests | 三平台 Release matrix 资源与启动 MAN |

## 8. 每日工作循环

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `LOOP-AC-01` | `stores/focus.ts`、`components/FocusDialog.tsx`、`components/FocusDigestCard.tsx`、`components/NavRail.tsx`、`stores/chat.ts` 通知路由 | `focus-mode.test.ts`、`notification-sound.test.ts` 路由顺序锁定 | 真实登录下专注全链路 UI/INT；三平台状态切换 MAN |
| `LOOP-AC-02`、`LOOP-AC-03` | 未实现（v3 通知瀑布重组） | — | — |
| `LOOP-AC-04`、`LOOP-AC-06` | 部分：消化卡与统计（v2 消化清单未实现） | `focus-mode.test.ts` | 消化清单批处理 UI |
| `LOOP-AC-05` | 未实现（v4 消息待办自动消解） | — | — |

## 9. 斜杠命令与团队功能

规格：[slash-commands.md](slash-commands.md)（2026-09-06 对 Rocket.Chat 8.6.1 实测）

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `SLASH-AC-01` | `lib/clientCommands.ts`、`kernel/dispatch.ts`、`stores/chat.ts` runSlash | `slash-commands.test.ts`、smoke 命令表覆盖断言（服务端命令缺中文说明即失败） | 其他 RC 版本的命令表差异 INT |
| `SLASH-AC-02` | `lib/poll.ts`、`components/PollCard.tsx`、`CommandDialogs.tsx` | `poll.test.ts`、smoke 投票段（附件往返、双账号表情计票、结束标记） | 官方移动端表情参与 INT |
| `SLASH-AC-03` | `lib/kanban.ts`、`lib/oncall.ts`、`components/KanbanPanel.tsx`、`components/OncallPanel.tsx` | `kanban-oncall.test.ts`、`thread-pagination.test.ts`、judge 截图验收 9/9 | 超长事件流真服务端压测 INT |
| `SLASH-AC-04` | `kernel/capabilities/host.ts`、`kernel/bridge.ts`、`kernel/chatEvents.ts`、`packages/app-sdk` | `kernel-host.test.ts`、`chat-events.test.ts`（消息事件按 chat:read 门控有源码断言） | 第三方应用实战 |

## 10. 发布候选门禁

规格状态要提升为“已实现”前，至少满足：

1. 对应 AC 有 R 或 UI 证据；依赖外部系统的主流程还要有 INT。
2. Web/桌面、无 Runtime、未登录、权限拒绝等适用边界已验证。
3. 发布产物相关能力完成 MAN，不以开发模式替代。
4. [能力矩阵](capability-matrix.md)、对应规格与本追踪表一致。
5. 测试失败或尚未执行时，在实施记录中如实保留，不以旧截图代替。

## 11. 不再接受的历史证据

- 依赖已删除自建 Butler Memory 的测试，不能证明当前 Codex 原生 Memory。
- 依赖已删除“派出去”界面的测试，不能证明独立委托存在。
- Blackboard、旧 AI 页面或 mock 工具成功截图，不能证明当前管家 Runtime。
- ADO `@Me` 局部快照为零，不能证明整个项目/组织工作项为零。
