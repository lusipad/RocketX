# 功能规格追踪索引

> 基线：工作树 `2026-08-11`
> 用途：从验收 ID 定位当前实现、自动化证据和仍需真实验证的部分。

路径缩写：表中的 `pages/`、`stores/`、`components/`、`lib/`、`agent/` 均相对于 `apps/web/src/`；未带目录的 `*.test.ts` 均相对于 `scripts/regressions/`。`tests/ui/` 和 `apps/desktop/` 使用仓库根目录完整路径。

## 1. 证据等级

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
| `ONB-AC-01` | `pages/FirstRunPage.tsx`、`lib/firstRun.ts` | `scripts/regressions/first-run.test.ts` | 新安装包 MAN |
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

## 4. 工作台与个人效率

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `WB-AC-01`、`WB-AC-02`、`WB-AC-03` | `pages/WorkbenchPage.tsx`、`stores/workbench.ts`、`components/AdoLists.tsx` | `workbench-refresh.test.ts`、`custom-query.test.ts`、`ado-open-issues.test.ts` | 真实 ADO INT |
| `WB-AC-04`、`WB-AC-05` | `lib/adoDirect.ts`、工作项写动作 | `ado-write-actions.test.ts` | 写超时/并发冲突 INT |
| `WB-AC-06` | ADO 受管 Skill 与业务 MCP | `ado-skill-cli.test.ts`、`app-server-controller.test.ts` | 自然语言真实任务 INT |
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
| `AGT-AC-02` | `stores/agentEnvironments.ts` | `agent-environments.test.ts` | 两会话真实竞争 |
| `AGT-AC-03`、`AGT-AC-04` | `components/AgentPanel.tsx`、`components/ChatArea.tsx`、请求路由 | `agent-session.test.ts`、`agent-context.test.ts`、`tests/ui/core-flows.spec.ts` | 真实房间 INT |
| `AGT-AC-05` | 共享 Agent 租约逻辑 | `shared-agent-runtime.test.ts` | 两设备 INT |
| `AGT-AC-06` | 中断恢复与环境释放 | `agent-session.test.ts`、`shared-agent-runtime.test.ts` | 进程崩溃 INT |
| `AGT-AC-07` | 产品/规格门禁 | 文档与入口审查 | 独立委托未实现 |
| `PERM-AC-01`、`PERM-AC-02` | `permissionSettings`、`components/ButlerConversation.tsx` | `app-server-controller.test.ts`、`codex-workspace.test.ts` | 上游 Profile 版本变化 |
| `PERM-AC-03`、`PERM-AC-04`、`PERM-AC-05`、`PERM-AC-06` | Server Request 路由、审批与输入卡 | `tests/ui/butler-host-input.regression-1.spec.ts` | 真实命令/MCP 请求 INT |
| `PERM-AC-07` | `agent/codexAutomation.ts` | `routines.test.ts` | 真实无人值守审批 INT |

## 7. Runtime 与平台

| 验收 ID | 主要实现 | 自动化证据 | 仍需验证 |
| --- | --- | --- | --- |
| `RUN-AC-01`、`RUN-AC-02`、`RUN-AC-03` | `apps/desktop/src-tauri/src/proc.rs`、Runtime 探测 | `codex-runtime.test.ts`、Rust tests | 安装/未登录/多版本 MAN |
| `RUN-AC-04` | 进程管理、Controller shutdown、Store 恢复 | `butler-stop-process.test.ts`、`app-server-controller.test.ts` | 强杀进程 INT |
| `RUN-AC-05` | 两份 Tauri bundle 配置 | `codex-bundled-resource.test.ts` | 发布产物内容审计 |
| `RUN-AC-06` | Tauri-only transport 与 Web 门禁 | `codex-runtime.test.ts`、UI | 部署 Web MAN |
| `RUN-AC-07` | 原生 Thread resume | `codex-workspace.test.ts` | `pnpm smoke:codex-lifecycle` |
| `PLAT-AC-01` | 主导航与管家布局 | `tests/ui/butler-workspace.spec.ts` | 各分辨率视觉 MAN |
| `PLAT-AC-02` | 平台检测、`lib/autostart.ts`、Tauri transport | `autostart.test.ts`、`codex-runtime.test.ts` | Web 部署 MAN |
| `PLAT-AC-03` | `apps/desktop/src-tauri/src/main.rs` | Rust tray tests | 三平台发布产物 MAN |
| `PLAT-AC-04` | `lib/autostart.ts`、系统插件 | `autostart.test.ts` | Windows/macOS/Linux MAN |
| `PLAT-AC-05` | `UpdaterBridge.tsx`、`lib/updateSource.ts` | `update-source.test.ts` | 签名 Release MAN |
| `PLAT-AC-06` | Tauri bundle/OCR 配置 | `image-ocr.test.ts`、`codex-bundled-resource.test.ts` | 精简/全量产物审计 |
| `PLAT-AC-07` | `lib/runtimeMode.ts` | `issue-264-performance-mode.test.ts` | 长时间资源观察 |
| `PLAT-AC-08` | `lib/unread.ts`、`lib/tray.ts` | `tray-flash.test.ts`、`taskbar-badge.test.ts`、通知聚合 tests | 三平台 MAN |
| `PLAT-AC-10` | `lib/uiScale.ts`、`components/DesktopUiScaleBridge.tsx`、`stores/uiPrefs.ts`、Tauri capability | `ui-scale.test.ts`、`tests/ui/core-flows.spec.ts` | 三平台 1080p 发布产物清晰度与快捷键 MAN |

## 8. 发布候选门禁

规格状态要提升为“已实现”前，至少满足：

1. 对应 AC 有 R 或 UI 证据；依赖外部系统的主流程还要有 INT。
2. Web/桌面、无 Runtime、未登录、权限拒绝等适用边界已验证。
3. 发布产物相关能力完成 MAN，不以开发模式替代。
4. [能力矩阵](capability-matrix.md)、对应规格与本追踪表一致。
5. 测试失败或尚未执行时，在实施记录中如实保留，不以旧截图代替。

## 9. 不再接受的历史证据

- 依赖已删除自建 Butler Memory 的测试，不能证明当前 Codex 原生 Memory。
- 依赖已删除“派出去”界面的测试，不能证明独立委托存在。
- Blackboard、旧 AI 页面或 mock 工具成功截图，不能证明当前管家 Runtime。
- ADO `@Me` 局部快照为零，不能证明整个项目/组织工作项为零。
