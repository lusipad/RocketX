# RocketX Agent 工作台重构实施记录

方案：[个人管家与多 Agent 工作台重构方案](rocketx-agent-workspace-refactor-plan.md)

- 实施日期：2026-11-15–16
- 实施基线：main，HEAD 0e53124d；进入实施时存在大量用户未提交重构，保留并增量修改。
- 当前切片：S1–S5 已实现；S6 已接入默认关闭的 Windows 离线 CPU 语音。继续完成隔离桌面与真实服务验收，结果见文末。
- 完成状态：已有真实 Codex、本机 Rocket.Chat 与 Tauri WebView 证据；真实 ADO 写入、Windows 原生输入法、物理麦克风／扬声器及系统休眠仍按各自边界记录，不能从自动化通过推定。

下方 S0／S1 及 S2–S5 部分保留各批交付时的历史记录；最新状态见文末“继续实施：S6 与实机验收”。进入实施前已有的未提交重构持续保留，未自动提交或发布。

## Decisions

### S1 输入与工作上下文

- 文本、已读取图片、待发送和失败请求使用按账号、目录和接收会话隔离的草稿记录。图片单独存入 IndexedDB，元数据使用引用；事务按仍有效的草稿引用清理图片，避免每个按键重写完整图片。
- 失败请求保留原目标与内容。明确尚未提交的失败可直接重试；重启遗留或执行器可能已接收的请求先核对原会话，不自动重放。
- 管家发送在进入异步连接前冻结原会话和工作目录；附件准备后核对原账号与连接，turn/start 明确使用原目录。
- 首次创建会话时，身份一经确认就绑定待发送记录，不等待历史列表刷新。旧账号迟到的刷新结果不能覆盖新账号。
- 工作详情与对话标题共用按运行时、原生 ID 和目录匹配的上下文。找不到关联或用户选择已删除的工作时保持空态，不猜测另一项。
- 无结构化计划时取消阶段百分比；有计划时只统计明确完成的步骤，验收条件不从整体阶段推算完成。

### 首批修改计划（历史）

1. 锁定现有类型检查、架构检查与相关回归基线，记录既有失败。
2. 修复管家与 ACP 输入的中文组合输入、草稿作用域、发送目标冻结和失败恢复；复用现有草稿与账号存储约定，不增加依赖。
3. 修复工作详情、执行会话与汇报的关联，避免无关会话回退；没有可靠分母的进度使用真实阶段描述。
4. 增加能复现错误和覆盖用户操作的测试，完成定向验证后执行整体质量检查。
5. 独立审查本轮差异并记录未覆盖的真实运行行为，下一切片继续已有 Codex 工作接续。

验收重点：AC20、AC21、AC22、AC23、AC24；只在已验证范围内报告完成。

## Deviations

新增 IndexedDB 草稿存储用于已有图片输入的持久化。现有聊天草稿的 localStorage 不适合保存最大 25 MiB 图片数据；没有新增第三方依赖。账号切换使用草稿键中的账号作用域隔离，不把完整图片放入账号数据搬移列表。

S1 为冻结真实发送目录增加 AppServerController.startTurn 的可选 workspaceRoot 参数，兼容现有调用。只在界面捕获会话 ID 无法覆盖底层控制器目录变化，因此这个最小原生请求边界修复前移到 S1。
## Surprises

### S0 原生 Codex 接续前置

- 本机 codex --version 为 0.165.0；exec resume 帮助提供原会话 ID、JSON 与 stdin 输入，app-server 帮助提供 stdio／WebSocket、daemon 与 proxy。仅核对帮助，没有向现有会话发送请求。
- local_sessions.rs 发现与日志允许根固定为默认 .codex，记录固定标为 idle；superAgentBridge 又把非 running 投影为 idle。S2 必须同时修正状态来源与控制判断，不能只更换一个状态字符串。
- 现有外部 Codex ACP 续办启动新的 codex exec resume 子进程，不等于连接外部正在运行的进程。
- TauriPiTransport 和部分保留 Codex 命名的 driver 实际进入 Pi。S2 必须核对运行时身份，不能将外部 Codex ID 送入 Pi 后宣称恢复成功。
- 原生会话唯一键、Web 回退合并、ACP sessionKey 和自动上板键需要一起处理来源作用域。只改前端发现键不足以隔离不同数据来源。

上述内容属于 S2 的前置清单，本轮 S1 不声明已通过真实 Codex 接续或活动会话接管验收。

### S1 失败测试与兼容断言

- 新增浏览器用例在原逻辑下复现跨会话草稿串线；上下文与报告用例复现默认选首卡、混入无关会话和阶段百分比。
- 发送方法与历史刷新改为显式请求／捕获连接后，两条旧源码断言仍要求旧变量名和调用形式。更新对应断言；真实目标冻结由新增浏览器与协议行为用例验证，不为保留断言恢复竞态。
- 背景成果更新的新增 UI 用例复现了汇报标签被自动切走；将标签切换限定为用户主动操作，并让父级与详情共享显式选择。

## Questions for review

## Verification

### S0 开始时的基线

- pnpm typecheck：通过，9 个工作区项目完成检查。
- pnpm check:architecture：通过，扫描 33 个 Tauri 调用相关文件。
- pnpm test:pure：237 通过，0 失败。
- pnpm test:regression：1200 通过，0 失败。
- 定向原生会话同步、ACP 工作流、账本、Portal 与并行工作区回归：23 通过，0 失败。

以上是本轮修改前的基线；不能代替新增用户行为的验收。测试日志保存在本机忽略目录 .omx/logs/rocketx-workspace-refactor-20261115。

### S1 完成后的结果

- pnpm typecheck：通过。
- pnpm build：通过。
- pnpm check:architecture：通过。
- pnpm test:pure：237 通过，0 失败。
- pnpm test:regression：1207 通过，0 失败；其中新增 6 项工作上下文／汇报回归和 1 项控制器工作目录协议回归。
- pnpm exec playwright test tests/ui/agent-composer-reliability.spec.ts tests/ui/agent-work-context.spec.ts --workers=1：16 通过，0 失败；其中 13 项输入与 3 项工作上下文交互。
- 独立只读审查：输入、工作详情、报告与标签切换未发现剩余高／中优先问题；审查者另复跑 6 项上下文与 1 项协议回归通过。
- 文档引用与差异检查随本轮收尾执行；未新增第三方依赖。

源码与测试涉及：管家、ACP 输入、图片选择与反馈、agentComposerDrafts、codexWorkspace、AppServerController、workContext、工作详情及报告。相关规格、能力矩阵和追踪索引同步更新。

### 本轮文件清单

| 文件 | 本轮变更 |
| --- | --- |
| [ButlerConversation](../apps/web/src/components/ButlerConversation.tsx) | 会话草稿、发送身份、失败反馈、附件读取与成果所属会话 |
| [AcpWorkspaceSurface](../apps/web/src/components/AcpWorkspaceSurface.tsx) | ACP 草稿、组合输入、按目标防重复及原位失败反馈 |
| [CodexImagePicker](../apps/web/src/components/CodexImagePicker.tsx) | 可选读取状态回调，防止附件读取期间提前发送 |
| [AgentComposerFeedback](../apps/web/src/components/AgentComposerFeedback.tsx) | 复用两处输入的保存、发送及失败反馈 |
| [agentComposerDrafts](../apps/web/src/stores/agentComposerDrafts.ts) | 本机按目标持久草稿、失败请求、附件引用与清理 |
| [codexWorkspace](../apps/web/src/stores/codexWorkspace.ts) | 显式发送目标、新线程身份回调、异步账号与连接校验 |
| [AppServerController](../apps/web/src/agent/AppServerController.ts) | turn/start 接受显式工作目录 |
| [workContext](../apps/web/src/lib/workContext.ts) | 按运行时、会话与目录统一匹配工作 |
| [ButlerWorkPortalDock](../apps/web/src/components/ButlerWorkPortalDock.tsx) | 移除首卡和无关会话回退，稳定选择与用户标签控制 |
| [workflowReport](../apps/web/src/agent/workflowReport.ts) | 按工作过滤报告来源，取消无分母百分比 |
| [WorkflowReportCard](../apps/web/src/components/WorkflowReportCard.tsx) | 呈现真实计划比例与未量化状态 |
| [输入 UI 用例](../tests/ui/agent-composer-reliability.spec.ts) | 13 项输入、持久化及异步竞态验证 |
| [上下文 UI 用例](../tests/ui/agent-work-context.spec.ts) | 3 项详情、选择与标签行为验证 |
| [控制器协议用例](../scripts/regressions/agent-composer-runtime.test.ts) | 冻结目录的实际协议参数验证 |
| [上下文回归](../scripts/regressions/work-context-report.test.ts) | 6 项报告、匹配与根目录验证 |
| [输入入口结构检查](../scripts/regressions/assistant-command.test.ts)、[工作区入口结构检查](../scripts/regressions/butler-entry-points.test.ts) | 适配新显式请求和捕获连接形式，保留原生调用约束 |

### 首批结束时的剩余项（历史）

- S1 尚未完成所有页面的加载、失联、权限与数据覆盖状态统一，也未验证完整的跨工作阅读位置恢复；本轮不能把方案 AC22、AC24 的全部要求标为完成。
- 组合输入验证使用浏览器合成事件；真实 Windows 输入法和 Tauri WebView 存储需桌面验证。
- 草稿与附件仅保存在本机当前浏览器／WebView，未实现跨设备或云同步。
- ACP 同一会话发送仍等待现有整轮 Promise；可写下一条草稿，未实现新的原生实时 steer。
- 本轮没有修改 Rust 或运行真实 ADO 写入，不声明通过 Rust 变更验证、原生 Codex 接续或业务同步验收。
- S2 下一步先落实原生数据来源与 unknown 只读保护，再验证专用会话的顺序接续，随后处理完整身份持久迁移。沿原会话继续、导入新会话和控制活动进程必须分别验证。

## 持续实施：S1 剩余项与 S2–S5

用户要求继续开发至方案完成后，本次持续实施没有停在上述首批切片。

### 已落地的用户流程

1. **管家与工作台**：主入口明确，保留直接操作执行器、原生会话和既有业务入口。按账号／工作区／会话保留草稿和同窗口阅读位置；真实区分加载、缓存失败、覆盖不足与空。100 条长标题工作在半屏、125% 缩放和键盘操作下可查找并打开。
2. **原生工作接续**：发现支持 `CODEX_HOME` 与命名执行器来源，未知状态只读；用户明确原端停止后消费短期一次性交接令牌。真实原生 ID 与直播 RPC 别名分开；RocketX 新建后退出桥接进程仍能沿同一 ID、目录、profile 和工作关联恢复。没有静默新建或将 Codex ID 送入 Pi。
3. **一句话委派**：`create_work_card` 以 requestId 原子幂等建工作；目标、验收、来源和目录保留。派工工具先持久入队并立即返回，管家可响应新问题；执行不抢当前页面、草稿或工作目录。
4. **验收与返工**：要求和成果双版本 CAS，逐条件证据；Agent 自述只能登记为参考报告。CI 从 ADO 实际读取并核对当前 Git 成果；业务人工接受记录身份、范围和已审阅版本。返工保留工作 ID，实际 HEAD、工作树、暂存区或未跟踪内容变化使旧证据过期。旧待办勾选不能绕过工作验收。
5. **同步与汇报**：外部写入先持久意图，ADO 检查 revision／状态并回读。汇报内容产生稳定身份和逐段消息 ID，保存部分回执；刷新与重启不生成新投递。未知结果先查，显式续投只补必要部分。外部投递不消耗 Agent 模型轮次预算。
6. **持续跟进**：全局最多两路，同一未隔离目录单写；持久收件、301 条跨页历史与并发实时消息补偿；prepared 恢复、unknown 不盲重放；等待／依赖唤醒、预算与截止、“需要你”和变化通知。暂停跟进、接管本轮与取消后续计划含义分开；取消失败保留真实状态，转向等待旧轮次确认退出。
7. **账号与资料**：原生数据库按账号及服务器隔离，旧库首次认领保留 ID；原生待办就绪 gate、前端代际与迟到响应保护贯穿工作、待办和记忆。共享工作不注入私人长期记忆。记忆纠正保留历史，失效内容不召回；搜索标明缓存覆盖；成功方法复用现有 routines，创建独立工作并重新验收。

### 实现与简化

| 范围 | 主要文件 |
| --- | --- |
| 输入、布局与阅读 | `stickToBottom.ts`、`ButlerConversation.tsx`、`AcpWorkspaceSurface.tsx`、`ButlerConversationHistory.tsx`、`WorkKanbanBoard.tsx` |
| 原生身份、交接与审批 | `local_sessions.rs`、`acp.rs`、`acp_bridge.mjs`、`acpAgents.ts`、`sessionAdapter.ts` |
| 工作与完成权 | `butler_ledger.rs`、`workLedger.ts`、`workCoordinator.ts`、`WorkCardPortal.tsx`、`workArtifacts.ts`、`workCiEvidence.ts` |
| 后台执行 | `workSupervisor.ts`、`superAgentBridge.ts`、`codexWorkspace.ts`、`AppServerController.ts` |
| 外部动作 | `externalActionExecutor.ts`、`externalWorkActions.ts`、`workflowReport.ts`、`WorkflowReportCard.tsx`、`codexHostTools.ts` |
| 账号存储 | `butler_account.rs`、`butler_db.rs`、`butlerAccountReady.ts`、`desktopCommands.ts`、`todos.ts`、`main.tsx`、`accountScope.ts` |
| 记忆与复用 | `butler_memory.rs`、`butlerMemory.ts`、`personalAssistant.ts`、`workSearch.ts`、`WorkContextSearch.tsx`、`workMethods.ts`、`WorkMethodReuse.tsx`、`routines.ts` |

复用既有账本、ADO 受控写、原生运行器和 routines，没有新增依赖或第二套通用编排框架。移除了任意首卡回退、无证据百分比、后台抢焦点和历史会话默认自动上板；本轮清理仅限自身新增代码。没有整理或还原既有脏工作树。

### S1–S5 交付时的验证结果（历史）

日志目录：本机忽略目录 `.omx/logs/rocketx-workspace-refactor-20261115/`，保留失败复现、修复中途与最终结果，不能把中途失败日志当最终状态。

| 检查 | 最新结果／证据 |
| --- | --- |
| 纯函数检查 | 237 通过，0 失败；`release-candidate-pure.log` |
| 全量回归 | 1287 通过，0 失败；`final-verified-regression.log` |
| 组合浏览器 | 34 通过，0 失败；`release-candidate-ui.log`，覆盖输入、上下文、阅读、百项工作、验收、原生交接界面、记忆复用及汇报重载去重 |
| Rust 全量 | 252 通过，0 失败，6 项既有忽略；`release-candidate-native.log` |
| 类型／构建／架构 | 全工作区类型与构建通过；架构扫描 33 个 Tauri 相关文件，未新增例外 |
| 新进程业务贯通 | `workflow-end-to-end.test.ts`：真实 store／工具／后台协调器，模拟执行器和 ADO／RC 边界；默认 3 轮预算，2 个执行轮次后完成验收、一次 ADO PATCH、分段回执丢失及新 Node 进程只读恢复，无重复执行／写入 |
| 原生 Codex 真实往返 | 仓库依赖 CLI **0.144.4**（非系统 0.165），通过 model/list 自动选默认 gpt-5.6-sol；`smoke-native-codex-handoff.ts` 与 `--new-session` 两条路径均通过，未指定二进制／模型覆盖；隔离 CODEX_HOME／临时目录，真实模型回忆首轮标记，原 ID、目录、命名 profile 和历史保留，错误 ID 拒绝 |
| 账号竞争 | `work-account-generation.test.ts`、`todo-native-account-ready.test.ts`、记忆原生 IPC deferred 回归；迟到读取、创建、删除、迁移及失败回滚不污染新账号 |

全树 `cargo fmt --check` 仍报告进入本次实施前已有的 `acp.rs`、`local_sessions.rs`、`pi.rs` 与记忆旧函数格式差异；本轮新增／实改函数已定向格式化。没有为了全树格式全绿而改写无关重构。`git diff --check` 通过。

独立架构最终复核通过，未发现剩余架构阻塞。审查者独立执行此前 64 项与最终 18 项定向测试均通过；已复核真实原生身份落盘、Todo 账号就绪与迁移顺序、记忆迟到响应隔离及上述最终日志。定向清理后重新运行全量回归、组合 UI、类型、构建、架构与相关原生验证，结果如表。

真实 Codex 的原始工具执行会话为 `43584`（已有会话）和 `54736`（RocketX 新建后退出重载）；成功输出含 `passed`、`nativeIdPreserved`、`cwdPreserved`、`customCodexHomePreserved`、`namedProfilePreserved`、`originalLogContainsBothTurns`、`wrongIdentityRejected` 均为 true，第二条另有 `createdThroughBridge: true`。隔离认证副本在运行结束时清理，不把认证内容写入记录。

### S1–S5 交付时的环境验收边界（历史）

- 已完成真实 Codex 子进程与模型往返；浏览器原生控制界面测试使用模拟桌面接口。尚未把完整 Tauri WebView、真实 Windows IME、托盘／休眠／完全退出操作记作实机通过。
- ADO／RocketX 真实写入需要明确测试项目、工作项与讨论室。本次已经请求该目标，未收到前使用受控 HTTP 故障注入验证，不拿生产数据试错，也不将其写为真实业务服务器通过。
- 冷恢复时外部活动未知仍要求明确交接；没有用历史 idle 或旧 owner 字段推断当前不存在其他写入者。
- 本地进程退出、休眠或关机期间不承诺继续执行；语音 S6 仍独立可选。本机草稿未实现跨设备同步。

## 继续实施：S6 与实机验收

### 默认关闭的本地语音

S6 已接入管家和 ACP 输入区，行为合同见[本地语音规格](specs/local-voice.md)。本轮选择 Windows 已安装的 `System.Speech` 中文桌面识别器和 Microsoft Desktop 音库，使用 CPU 运行；没有引入 sherpa、额外依赖、云端语音服务或自动模型下载。非 Windows 桌面端和网页版明确显示不可用，文字工作不依赖该能力。

- 用户每次启动后自行启用；未启用时不探测语音引擎、不申请麦克风、不启动语音进程。
- 按住说话、松开转写，单次最多 30 秒；文字追加到原输入目标的最新草稿，保留期间的手工修改，可编辑后自行发送，不自动派工。
- 最新回复仅在点击后朗读；超过 300 字明确显示只朗读前 300 字。“停止语音”不停止 Agent 工作。
- 关闭、失焦、切换账号／收件目标或组件卸载时，停止录音轨道和播放，撤销对应请求；迟到的权限、转写或朗读结果不进入新目标。能力探测同样可以取消，不会因挂起探测阻塞下一次启用。
- 原生端限定完整的 16 kHz 单声道 PCM16 WAV、30 秒录音和文本长度；隐藏辅助进程有输出上限、35 秒超时和按请求 ID 取消，退出时回收子进程。

真实静默往返已用本机中文音库合成“你好请继续完成今天的工作”，再交给本机识别器转写；生成音频 3990 ms、127724 字节。该证据证明本地 TTS→ASR 管线，不代表物理麦克风拾音、扬声器播放、噪声环境识别质量或 GPT Live 式全双工体验已通过。

最终隔离桌面构建另通过真实 Tauri IPC 完成探测、合成和识别：发现 1 个识别器、2 个音库，生成 112684 字节 RIFF WAV，识别 12 字中文、3520 ms；无效 WAV 与空文本返回对应业务错误。该次也未使用麦克风或扬声器。证据：`desktop-voice-ipc.log` 及其 JSON 记录。

### 真实服务兼容与恢复

使用隔离 Docker 项目 `rocketx-acceptance-20261115`、独立 MongoDB 数据卷及回环地址 `127.0.0.1:3301`，在真实 Rocket.Chat **8.6.1** 上执行 `scripts/smoke-local-report-delivery.ts`，没有向已有生产讨论室发送测试消息。

该服务器对不存在的 `chat.getMessage` ID 返回无 `errorType` 的 HTTP 400；首次投递的预读因此会被误判为未知。修复后，账本通过 CAS 首次进入 `dispatched` 且没有历史投递记录时，直接发送冻结的消息 ID，并严格核对回执的 ID、讨论室和内容；已有尝试或恢复时仍先核对，裸 HTTP 400 不构成“消息不存在”的证明。

实测完成 3 段正常汇报，以及 1 条已送达但丢失回执的消息；重复消息 **0**。新 Node 进程读取不含凭据的磁盘账本后，将未知动作核对为 `acknowledged`，恢复阶段消息写入 **0**。临时讨论室和账本均已清理。证据：`.omx/logs/rocketx-final-acceptance-20261115/local-rc-report-delivery.log`。

验收后仅回收本轮项目标签下的两个容器及网络，释放 3301 端口；专用数据卷、镜像与日志保留，既有 `rcx-dev` 容器和 Docker Desktop 未关闭。清理证据：同目录 `local-rc-cleanup.log`。

ADO 现有测试连接的只读请求返回 **401**，尚无明确的测试工作项目标；本轮没有据此执行真实 ADO 写入。受控 HTTP 中的 revision 冲突、回读和 unknown 恢复测试继续有效，但不替代真实 ADO 权限与状态流验收。

### 隔离的原生桌面验证

使用独立应用标识 `com.lusipad.rocketx.acceptance20261115`、AppData、WebView2 profile、SQLite 和凭据服务命名空间构建测试实例。正式标识 `com.lusipad.rocketx` 保留既有 keyring service 名称；其他标识使用各自前缀，未初始化作用域时拒绝访问，避免测试启动流程触及正式凭据。

在真实 `http://tauri.localhost/` WebView 中创建工作、通过工作详情编辑并保存目标、回读原生 SQLite，再刷新 WebView，工作 ID、目标、验收条件及要求版本 2 保持一致。该测试发现前端更新包装器传入 `todoId`、Rust 命令实际要求 `id`；已修复为 `id`，并增加真实包装器参数与 CAS 保留回归。52 个命令的顶层参数及注册核对未发现其他不一致。

原生 Alt+F4 已验证将测试窗口隐藏而保留进程；再次启动同一测试应用，通过 single-instance 路径使原窗口恢复，工作回读保持一致。随后在核对精确 PID、完整路径与启动时间后，中止自身隔离测试进程，以最终源码重新构建并用同一隔离 profile 启动新进程；工作 `9dbbecc8-a347-4f06-86cb-3407fc952df2`、要求版本 2、成果版本 0、暂停状态、目标及验收条件全部保持。证据：`desktop-native-close-observation.log`、`desktop-native-reopen-observation.log`、`desktop-verify-after-process-restart.log`。这属于隔离进程中止后重启；未点击物理托盘菜单，也未验证托盘“退出”的优雅退出流程、系统休眠或原生中文选词。

原生键盘试验观测到各一次 composition start／end，但输入框仍是拉丁字母，没有中文候选、汉字或 Enter 确认，因此不计为真正的 Windows 中文选词及 Enter 防误发通过。13 项浏览器输入可靠性用例继续有效，真实输入法行为仍需在设备上人工验证。证据：`desktop-ime-observation.json`、`desktop-ime-report.log`。

验收结束后，按精确 PID、路径和启动时间核对并清理隔离测试进程；正式 release 进程 `199508` 仍运行，原启动时间不变。证据：`desktop-process-cleanup.json`。最终桌面证据汇总为 `desktop-acceptance-report.md`。

### 本轮验证结果

日志目录：`.omx/logs/rocketx-final-acceptance-20261115/`。这是上一节 S1–S5 历史结果之后的新一轮验证。

| 检查 | 本轮结果／证据 |
| --- | --- |
| 纯函数检查 | 237 通过，0 失败；`final-pure.log` |
| 全量回归 | 1293 通过，0 失败；`full-regression.log` |
| 组合浏览器 | 44 通过，0 失败；`full-workspace-ui.log`；包括 S1–S5 原有 34 项与 S6 新增 10 项 |
| Rust 全量 | 259 通过，0 失败，10 项忽略；`final-native.log`；包含最后探测取消用例，语音实际进程／音库专项另行显式运行 |
| 语音原生专项 | 7／7 通过，包含请求隔离、挂起探测取消后重试及真实本地 TTS→ASR；不操作音频设备 |
| 类型／架构 | 全工作区类型检查通过；架构扫描 34 个 Tauri 相关文件，0 个例外；`full-typecheck.log`、`final-architecture.log` |
| 全量构建 | `pnpm build` 通过，退出码 0；`final-build.log` |
| 独立复核 | 最终新增定向检查 25／25 通过；探测取消缺口修复后复核通过 |
| 真实 Rocket.Chat | 3 段正常投递＋1 条回执丢失，重复 0、恢复写入 0；`local-rc-report-delivery.log` |
| 真实 WebView／SQLite | create→详情保存→回读→刷新通过；`desktop-workspace-seed-2026-11-15T16-02-23-902Z.json` |
| 隔离进程中止后重启 | 核对 PID／路径／启动时间后中止自身进程→最终构建→同 profile 新进程；同工作、双版本、目标、验收条件与暂停状态保留；`desktop-verify-after-process-restart.log`；未测试托盘退出菜单 |
| 真实桌面语音 IPC | 探测→静默合成→识别通过，WAV／文本输入限制返回业务错误；`desktop-voice-ipc.log`；无物理设备或云端语音 |

### 文件范围与保留边界

| 范围 | 本轮主要文件 |
| --- | --- |
| 可选语音 | `LocalVoiceControls.tsx`、`localVoiceAudio.ts`、`stores/localVoice.ts`、`platform/localVoice.ts`、`local_voice.rs`、`local_voice.ps1`、管家／ACP 输入区及命令注册 |
| 凭据隔离 | `credential_scope.rs`、`business_mcp.rs`、`mcp.rs`、`agent_bot.rs`、`native/lan_discovery.rs`、`live_e2e.rs`、`main.rs` |
| 桌面 IPC | `desktopCommands.ts`、`work-ledger-native-ipc.test.ts` |
| 投递兼容 | `externalActionExecutor.ts`、外部动作回归及 `smoke-local-report-delivery.ts` |
| 桌面证据 | `smoke-desktop-workspace.ts` 与隔离构建日志；无产品测试后门 |

本轮继续复用现有草稿、适配器、账本与 Windows 组件，没有新增通用语音框架或依赖。本机草稿仍不跨设备同步，应用完全退出或关机期间不承诺后台执行。

### 剩余实机验收的完成条件

| 项目 | 当前证据与具体完成条件 |
| --- | --- |
| 真实 ADO 写入 | 当前只读连接返回 401。需恢复有效登录，并明确允许测试的工作项；在该目标上验证 revision／状态检查、允许的状态更新与回读一致，冲突不覆盖，unknown 先核对。 |
| Windows 中文输入法 | 需在真实 Pi／ACP 输入框中用拼音产生候选并确认；按 Enter 确认候选只完成选词，不误发，随后明确发送才提交。当前虽有 composition start／end 事件，但没有中文候选、汉字及 Enter 确认，浏览器用例不能替代。 |
| 物理麦克风／扬声器 | 需手动录入可理解的中文、松开后在原草稿得到可编辑转写，并听清手动朗读；停止语音应结束录音／播放并释放设备，Agent 工作继续。静默 TTS→ASR 不替代该验证。 |
| 系统休眠恢复 | 需用户实际休眠并唤醒后，核对同一工作 ID、版本、草稿及持久动作；unknown 先核对、不重复写入或汇报，不要求休眠期间执行。 |

本轮未自动改变系统电源或麦克风权限设置，也未将上表项目记作通过。

## 2026-11-16：工作台卡片与已有会话的易用性

本轮针对“卡片看不明白、已有 Codex／Claude 会话加入繁琐、不知道会读入什么”的反馈，调整工作台入口、会话整理和详情信息层级，不扩大执行权限，也不变更语音或 ADO 业务合同。

### 已有会话：发现、查看与加入

- 统一入口为“添加已有会话”，打开工作台自动发现本机记录。磁盘扫描最多最近 300 个会话，另含账本已有的托管会话；空工作台有候选时直接展示，不要求先找文件、导出或逐条转卡。
- 默认最近 7 天，可按来源、项目目录和标题／目录／摘要关键词筛选。每页 30 个，后续页可达；“当前范围”指全部筛选结果，而非仅当前页。筛选改变清空旧选择，翻页保留同一范围的选择。
- 只有一个主加入按钮：有选择时“加入所选”，否则“加入当前范围”。逐项显示新增、已加入与失败，部分失败保留并可重试，成功项可直接打开工作。
- 列表读取标题、目录、更新时间和记录摘要；只有“查看对话”才通过原生只读接口读取最多最近 24 条可读消息，并明确不是完整历史。读取失败可重试，没有可读消息不解释为原会话没有历史；Escape 关闭并返回原按钮焦点。
- 添加只创建工作关联，不复制执行器配置，不启动模型、不发送消息、不接管原会话。既有 unknown 仍只读，需要继续工作时沿独立的明确交接流程处理。
- 账号、运行时、提供方、原生 ID、来源作用域、目录、宿主、执行 profile 和来源路径组成加入身份；并发加入共用在途请求，稳定 requestId 支持绑定失败后的重试。相同标题或 native ID 不足以把不同来源合并。账号切换停止旧批次并丢弃迟到历史。
- 首次账本加载与发现共用扫描状态，未完成前显示正在发现并禁止批量加入，避免把暂时为空当成无会话；扫描失败明示错误并保留缓存。导入页与工作台共用刷新路径，刷新成功同时清除旧扫描警告。发现上限和只读历史覆盖在界面说明，不宣称扫描所有磁盘历史。

### 卡片先讲清工作，详情先阅读

新加入的工作使用普通优先级 3，目标以会话标题起步，摘要单独标为“会话摘要”；不把历史摘要改写成目标，也不自动制造“确认交接”的下一步或验收待办。

卡片先展示项目、来源、目标及当前版本的最新非失效记录；测试／人工验证的通过与未通过、未核验的执行者说明分别标明。没有当前记录时才展示会话摘要，并说明记录更新时间；活动未知不显示为正在运行。实际下一步、等待或阻碍存在时才展示，不给普通卡附加默认审批、待验证和暂停噪声。已有工作时默认隐藏空阶段，可显式展开；只剩一个非空阶段时，卡片使用可读宽度平铺。

详情默认展示目标、记录／摘要、阻碍／下一步及验收条件；编辑、派工、阶段和预算操作折叠到二级区域。窄窗覆盖整个工作内容区，搜索区不会把详情挤到下方；宽屏为 480 px 侧栏。人工验收、原生交接和外部写入仍沿已有授权与完成门禁。

已修复详情保存的时序隔离：A 的迟到成功不修改 B 的草稿身份或 CAS 版本，迟到失败不出现在 B，提交后新输入也不因旧回执被清为已保存。详情按当前版本最新非失效记录显示失败、通过或未核验，不用旧通过记录遮蔽新失败。相关新增用例先复现失败、修复后通过，并包含 StrictMode 运行。

### 实现、简化与验证

| 范围 | 主要文件／证据 |
| --- | --- |
| 统一加入与只读查看 | `WorkSessionImport.tsx`、`WorkSessionHistoryPreview.tsx`；复用现有发现和历史读取接口 |
| 完整身份与幂等 | `superAgentBridge.ts`、`AcpWorkspaceSurface.tsx`、`work-session-import.test.ts`；发现与 ACP 表面复用完整来源匹配 |
| 卡片与详情 | `WorkKanbanBoard.tsx`、`WorkCardPortal.tsx` |
| 加入与卡片交互 | `tests/ui/work-session-import.spec.ts`、`workboard-usability.spec.ts`；覆盖分页、批量、只读历史、账号切换、缓存失败、初次扫描与窄窗 |
| 详情补修与完成门禁 | `tests/ui/work-portal-usability.spec.ts`、`work-acceptance-portal.spec.ts` 与汇报 UI；包括跨卡迟到成功／错误、新输入及最新失败记录的先红后绿复现 |
| 全量回归 | 1299／1299 通过；`.omx/logs/workbench-usability-regression.log` |
| 最终组合 UI | 65／65 通过；`.omx/logs/workbench-usability-final-ui-verified.log`，覆盖输入、工作上下文、工作台、已有会话、详情、验收、汇报及原有可选语音交互 |
| 全工作区类型／构建 | `pnpm typecheck`、`pnpm build` 通过；`workbench-usability-typecheck.log`、`workbench-usability-build.log` |
| 架构边界 | 扫描 34 个 Tauri 相关文件，0 个例外；`workbench-usability-architecture.log` |
| 独立复核 | APPROVE；4 项 P2 闭环，复核者独立 18 项定向回归与 Web 类型检查通过 |
| 桌面 smoke 适配 | `scripts/smoke-desktop-workspace.ts` 已适配编辑折叠并通过单文件类型检查；未执行本轮原生 smoke |

删除重复“会话池／同步”主入口和旧单条导入表单，复用现有账本、发现、历史与工作完成门禁，没有新增依赖、数据库模式或通用编排层。旧 `autoPromoteRecent` 仍是默认关闭的兼容分支，其历史排除 marker 使用较粗身份，本轮未扩大修改；新的主入口不依赖它自动加入。此前真实服务、原生中文输入法、音频设备和休眠的验证边界继续有效，本轮浏览器证据不替代这些实机条件。

桌面 smoke 已适配详情编辑折叠并通过单文件类型检查；本轮未修改 Rust，也未重跑 Rust 全量或原生 WebView smoke。前一轮原生身份与持久化实机证据仍保留其历史效力，不作为新界面的原生验收。

## 2026-11-16：DeepSeek 配置后 Pi 连接恢复

本轮修复配置 DeepSeek 后持续停留在“正在连接”的本地连接问题，不更改用户已有 Key、端点或默认模型，也不把模型别名作为已证实根因。

### 已复现的问题与修复

- Pi **1.5.0** SDK 不支持桥接传入的 `refresh({ offline: true })`。使用临时假 Key、清除继承凭据并拦截 fetch 的真实 SDK 回归，修前观察到 3 次远程模型目录请求；改为 SDK 支持的 `allowNetwork: false` 后为 **0**，已配置默认模型仍可从本地目录读出。该修复只针对目录初始化，不把后续模型调用变为离线。
- 启动中的 client 现在也由 Controller 管理。连接、停止与重连按所属代次隔离；重连不复用旧 `connectRequest`，关闭或账号切换后的迟到完成不回写 ready，也不清除新请求或停止新进程。监听注册失败及迟到注册会清理自己的监听。
- 连接失败先显示原始错误，再回收所属资源；`stop` 尚未返回或挂起时，不再让错误反馈与下一次连接一起卡在 connecting。生命周期相关回归均先复现失败后修复。
- 快速配置保存并完成连接后，删除 `onSuccess` 再次 `connect` 的重复路径，避免 ready 被立即改回 connecting；同时移除吞错的重复探测。一次保存只建立一次连接。
- 管家界面明确展示连接失败原因，提供“使用已保存配置重试”；修改配置折叠显示，不再用空白配置表单遮住错误。连接中也可主动重新连接，不要求重填或更换 Key。

### 文件范围与简化

| 范围 | 本轮文件 |
| --- | --- |
| 本地模型目录 | `apps/desktop/src-tauri/src/pi_app_server.mjs` |
| 连接与资源归属 | `apps/web/src/agent/AppServerController.ts`、`agent/protocol/client.ts`、`agent/protocol/tauriTransport.ts`、`stores/codexWorkspace.ts` |
| 单次配置与失败恢复 | `apps/web/src/components/PiQuickOnboardingCard.tsx`、`ButlerConversation.tsx` |
| 回归 | `scripts/regressions/pi-model-catalog-offline.test.ts`、`pi-connect-lifecycle.test.ts`、`pi-transport-lifecycle.test.ts` |
| 界面回归 | `tests/ui/pi-connection-recovery.spec.ts` |
| 隔离原生验收 | `scripts/smoke-pi-connection.ts` |
| 文档 | 本实施记录末尾新增本节；前期结果保持不变 |

本轮复用现有 Controller、transport、store 和配置入口，删除重复连接与探测，没有新增依赖或第二套连接框架。

### 验证结果

日志目录：`.omx/logs/pi-connect-fix-20261116/`。

| 检查 | 本轮结果／证据 |
| --- | --- |
| 真实 SDK 目录回归 | 通过；外部 fetch 0，假 Key、不发送模型 Turn；`offline-catalog.log` |
| 全量回归 | 1314／1314 通过；`regression.log` |
| 最终组合 UI | 68／68 通过；`ui-all.log`；新增 3 项首次保存／错误展示／重连用例先红后绿 |
| 全工作区类型／构建 | `pnpm typecheck`、`pnpm build` 通过；`typecheck.log`、`build.log` |
| 架构边界 | 扫描 34 个 Tauri 相关文件，0 个例外；`architecture.log` |
| 独立复核 | APPROVE；复核者独立 14／14 生命周期回归通过 |
| 真实 Tauri 本地连接 | `TauriPiTransport`→`AppServerClient` 完成 initialize／initialized／model/list 并停止，1281 ms、36 个模型、DeepSeek 目录可见、主界面 ready；`.omx/logs/pi-connection-20261116/pi-connection-evidence.json`、`pi-ready-real-webview.png` |
| 正常标识调试构建 | `com.lusipad.rocketx` 的 debug 构建通过，30.92 s；`.omx/logs/pi-connection-20261116/normal-identifier-build.log`；仅暂存，未启动或替换运行实例 |

### 运行实例与验证边界

原生验收使用全新 `com.lusipad.rocketx.acceptancepi20261116`、独立 AppData 和凭据作用域，先由原生接口写入隔离假配置，再验证真实客户端目录与主界面 ready。它不是快速配置卡的 UI 保存→ready 实机全流程；后者由新增浏览器交互用例覆盖。4 个 Node 进程均启用网络守卫，远程尝试 0，thread／turn 请求 0；结束后假 Key 已清空，隔离进程已停止。

这些证据证明本地协议、目录初始化和连接恢复分支，不证明用户 Key 已通过 DeepSeek 服务鉴权，也没有发送真实模型请求。

用户原有正式 release 进程 `199508` 与 debug 进程 `40148` 未被停止或替换；目标实例尚待用户确认，修复尚未应用到这些运行中的窗口。不能据测试通过宣称用户已经连上。

正常标识候选暂存于 `D:\Repos\rocketchatx\.omx\target\pi-connection-acceptance\normal-build\rocketx.exe`，依赖仓库现有 `apps/desktop/src-tauri/target/pi-runtime`（Pi 1.5.0）及系统 Node ≥22.19，是本地调试产物，不是便携版或分发安装包。产物清单为 `.omx/logs/pi-connection-20261116/normal-artifact.json`；SHA256 为 `1483A8780844204550DB7D543B9B5B3A87FCC8BC9FACD56BA70A888936A3888F`。未启动该候选，也未以它覆盖用户进程。

## 2026-11-16：执行会话以对话为主的布局

本轮针对 ACP 截图中目录、会话、对话与空检查器多列并排、工作标题截断的反馈，重新安排当前执行会话的阅读空间。保留全局导航、深浅主题、会话身份和权限合同，不调整数据库或执行器接续协议。

### 用户可见改变

- 已有会话默认以完整工作标题、当前状态、对话与输入区为主，不常驻展示客户端发现目录和空检查器。标题允许换行，执行器与目录放在次级信息中，不再受 ACP 固定 52 px 顶栏断言限制。
- 用轻量会话选择框切换已有会话，保留各会话状态和待审批数量。新建会话、中断和停止保留与当前状态相符的入口。
- “管理执行器”和“任务详情”按需打开覆盖面板，同一时刻只打开一个，最大宽度 440 px，窄窗不超过可用宽度，不再作为常驻列挤压对话。
- 详情继续提供权限模式、计划、工具、汇报与日志；待审批请求仍在主对话中可见，不因收起详情而藏起来。打开和关闭辅助面板不重建当前会话，不丢草稿、不发送指令，发送仍使用原会话身份。
- 面板支持 Escape、Tab／Shift+Tab 焦点约束和关闭后焦点返回；当前会话移除时关闭详情并解除约束。
- ACP 窄窗导航改为参与正常布局，避免浮动导航覆盖完整标题；该父级样式只作用于 `acp-hub`，不推广到普通 Pi 对话视图。

### 文件范围与简化

| 范围 | 本轮文件 |
| --- | --- |
| 主对话与按需面板 | `apps/web/src/components/AcpWorkspaceSurface.tsx` |
| 视图作用域 | `apps/web/src/pages/ButlerPage.tsx`；仅为 `acp-hub` 添加 `is-executor-workspace` |
| 局部布局样式 | `apps/web/src/styles.css`；限 `rcx-acp-*` 与执行会话专用窄窗导航选择器 |
| 新交互回归 | `tests/ui/acp-conversation-layout.spec.ts`，5 项覆盖默认阅读空间、面板、会话草稿、审批与焦点释放 |
| 既有断言适配 | `tests/ui/native-session-handoff.spec.ts` 的两项用例先打开管理面板；`scripts/regressions/ui-visual-harmony.test.ts` 不再要求 ACP 固定 52 px 顶栏 |

复用既有管理、检查器和会话状态，仅改变显示方式与布局作用域，没有引入新面板框架、依赖或控制协议。

### 已验证结果与视觉证据

日志目录：`.omx/logs/acp-conversation-layout-20261116/`。新增布局用例有 3 项修前失败复现，保留问题基线 `default-before.png`。

| 检查 | 当前证据 |
| --- | --- |
| 全量回归 | 1314／1314 通过；`regression-final.log` |
| 最终支持范围 UI 矩阵 | `ui-supported-final.log` 明确运行 73 项，73／73 通过；包含新增 5 项 ACP 布局交互；不代表下述 200 项扩展运行通过 |
| 全工作区类型／构建 | `pnpm typecheck`、`pnpm build` 通过；`typecheck.log`、`build.log` |
| 架构边界 | 扫描 34 个 Tauri 相关文件，0 个例外；`architecture.log` |
| 独立源码复核 | APPROVE，Web 类型检查通过 |
| 独立视觉复核 | 改前 36／fail，最终 94／pass；实际复核 1440 px 默认、900 px 窄窗及 1280 px 管理／详情四张图 |
| 用户同款导航状态预览 | 收起全局导航的 `default-user-navigation-current.png` 已实际看图；`user-navigation-preview-final.log` 单例 1／1 通过，6.7 s；仅补充测试截图，产品未改 |
| 独立桌面构建 | 正常应用标识 debug 构建通过，44.33 s；`normal-native-build.log`；独立输出文件，未启动、未重跑原生 smoke |

截图证据为 `default-before.png`、`default-current.png`、`narrow-current.png`、`management-1280-current.png`、`details-1280-current.png` 与 `default-user-navigation-current.png`。中途 `ui-supported-matrix.log` 因路径筛选实际只运行 5 项，最终矩阵以 `ui-supported-final.log` 为准。

### 扩展 UI 运行的未解决边界

额外的 200 项 UI 扩展运行到日志中的第 106／200 项时中止，已记录 38 个失败，没有完整结束汇总。错误文本保留在 `ui-final.log`，另有 6 份上下文保存在 `legacy-ui-contexts`；部分原 trace 已被后续运行覆盖，不能宣称所有 trace 仍可用。不能将本轮定向通过表述为全部 UI 通过，也不能把这 38 项统一归为已知历史基线。

初步核对显示：普通 Pi 的 860 px 宽度存在产品行为与测试要求冲突，本轮 ACP 专用样式没有直接作用于该视图，但尚不足以声明历史基线；部分 DSH／Codex 工作区导航断言不适配当前源码；`test user missing` 属于 fixture 前置失败，根因未确证；消息定位及 KaTeX 用例未到达预期断言的原因也未确证。这些扩展失败不在本轮已验证范围内。

### 当前运行实例

本轮未操作用户窗口或读取真实 Key。本轮观测到用户自有 debug／deps 进程为 `252720`；上一节记录的 `199508` 和 `40148` 已退出，并非本轮操作。独立构建未替换当前进程，不据浏览器截图声称用户正在运行新布局。

元数据核对显示，`252720` 的 SHA256 与上一轮 Pi 修复候选一致，证据为 `current-process-artifact-match.json`。本轮新候选暂存于 `D:\Repos\rocketchatx\.omx\target\pi-connection-acceptance\normal-build\rocketx-layout-20261116.exe`，标识仍为 `com.lusipad.rocketx`；SHA256 为 `BE3485F7E0E90E14E3C0D63D7F3C5CE526FE98F5E95A8E41F6B1BE12E3AAA3A4`。构建后用户进程保持不变，旧候选也未覆盖；新候选未启动，未获得新布局的真实原生窗口验收。

产物清单为 `.omx/logs/acp-conversation-layout-20261116/normal-artifact.json`。这是引用仓库现有 Pi runtime 和系统 Node ≥22.19 的本地 debug 产物，不是便携版或分发安装包；既有桥接资源未更改。

## 2026-11-17：以工作和注意力为主的日常界面

本轮落实用户已接受的“管家＋我的工作＋注意力”方向，调整日常入口、工作列表、完整详情和输入区。任务在 11 月 16 日开始，因此日志继续保存在 `.omx/logs/work-first-redesign-20261116/`。这次交付是现有能力的交互重设计，不把体验合同或交互样例当成已经验证的完整任务旅程。

### 已落地的日常路径

- 默认导航只突出“管家”和“我的工作”。执行器、简报与记忆、例行任务等入口收入“更多功能”，直接进入相关页面仍能找到当前入口；没有内容的项目／历史组不再占位，真实已有对话仍可返回。
- 管家空态说明可以交代什么，示例只补入草稿并聚焦，不自动发送；输入区显示“发给管家”及当前工作锚点。模型、权限和语音收进按需展开的设置，不再和工作要求争夺首屏。
- 导航与“我的工作”的“交代新事情”均创建独立空白对话，保留旧对话草稿。准备目录、连接和创建等异步步骤逐次核对登录账号及运行作用域，期间切换账号时停止后续创建和跳转，不向另一账号发送要求。
- “我的工作”默认采用纵向分组条目，优先呈现需要处理的情况；正常推进、已收录、已有结果、外部等待和历史记录分别呈现，阶段视图保留为可选。搜索按需展开，不用常驻检索大框占首屏。
- 每条工作给一个主要情况和操作，按当前有效记录选择实际阻碍、待决定动作、验证结果或来源摘要，避免目标、摘要和状态重复堆叠。unknown 明示未核实，历史完成不等于当前验收通过；后续活动与当前版本验证确认恢复后，旧错误不再重复列为待处理，独立未回答问题仍保留。
- 打开工作后使用完整主区展示目标、当前记录、成果和下一步，技术会话与管理配置按需展开；“返回我的工作”恢复列表筛选、阅读位置与触发项焦点。没有成果时如实说明，不把填写验收表当作查看工作的必经步骤。
- 当前有效的待决定事项在详情首屏直达其具体批准／取消入口；旧版本或信息不完整的请求保留核对与取消入口，禁止直接批准。查看详情或请求本身不派发执行。
- 只读来源明确提供查看记录，不能冒充可发送或可继续；受支持接续沿既有完整来源身份定位原会话，并在匹配账号、来源与会话后聚焦对应输入框，不自动新建或发送。ACP 输入区只补充用于正确定位的工作／会话标识。
- 收起语音面板会卸载控件，触发录音、朗读和在途请求清理，避免控件已隐藏但仍占用媒体。语音浮层使用固定尺寸和两列控件布局，降低录音状态切换时按钮移动；本地语音后端与默认可选边界没有扩展。

### 文件范围与简化

| 范围 | 本轮文件 |
| --- | --- |
| 日常导航与管家输入 | `apps/web/src/components/ButlerConversationHistory.tsx`、`ButlerConversation.tsx` |
| 纵向工作与轻量检索 | `apps/web/src/components/WorkKanbanBoard.tsx`、`WorkContextSearch.tsx` |
| 完整详情与具体操作 | `apps/web/src/components/WorkCardPortal.tsx` |
| 原会话输入定位 | `apps/web/src/components/AcpWorkspaceSurface.tsx`，仅输入区 `data-work-composer`／`data-work-session-id` |
| 局部视觉样式 | `apps/web/src/styles.css` 的本轮作用域样式 |
| 新工作交互用例 | `tests/ui/work-first-navigation.spec.ts`、`work-first-list.spec.ts`、`work-first-detail.spec.ts`、`work-first-shell.spec.ts`，分别 7、7、7、1 项 |
| 语音折叠回归 | `tests/ui/local-voice.spec.ts` 新增收起时停止录音／朗读用例 |

复用现有工作身份、账本、来源记录、执行入口与审批合同；删除默认管理噪声和空组，保留可追溯入口。未改后端或 store，没有新增依赖；已有交互测试按新入口适配，不恢复被取消的旧页面密度来满足旧定位器。

### 交互与视觉证据

实施前的 16 项相关回归基线通过。最终补修的 33 项针对性交互通过，独立代码复核 APPROVE；包括两处新对话入口的账号／作用域竞争、旧请求禁止批准、只读记录与原会话输入定位，以及语音收起清理。

视觉迭代由第一版 79 分、第二版 86 分收敛至最终五张图 **93／pass**：`assistant-1440.png`、`assistant-light-1440.png`、`work-list-1440.png`、`work-list-900.png`、`work-detail-1440.png`。中途浅色截图处于主题切换的 140 ms 过渡阶段；测试改为等待背景和文字 computed style 稳定后截图，未因此更改产品色系。截图证明信息层级与可读性，不替代真实执行或原生任务旅程。

| 最终补丁检查 | 结果／证据 |
| --- | --- |
| 支持范围 UI 矩阵 | 96／96 通过，1.6 min；`ui-verified.log`；不是全库 UI |
| 全量回归 | 1314／1314 通过，78.6 s；`regression-verified.log` |
| 全工作区类型 | 通过；`typecheck-verified.log` |
| 全工作区构建 | `pnpm build` 通过，Vite 16.10 s；`build-verified.log` |
| 架构边界 | 34 个 Tauri 相关文件，0 个例外；`architecture-verified.log` |
| 独立桌面构建 | 通过，43.91 s、退出码 0；`native-build-20261117.log`、`native-build-protection-20261117.json`；独立输出、无调试符号，未启动 |

补修前日志保留为历史，不替代上述最终补丁验证。上一章 200 项扩展 UI 的 38 个失败记录保持原边界；本轮没有重跑该扩展集合，也不声称全库 UI 通过。

### 实际能力与运行边界

本轮没有重验真实执行器的完整任务旅程，也没有将可信上下文总结、离开后的变化归并、后台持续推进和成果回传等体验合同算作本次 UI 新实现。界面只使用实际已有记录与权限；不足之处继续明确显示，不以“继续工作”文案替代真实可控性验证。

正常应用标识 `com.lusipad.rocketx` 的新候选已独立暂存于 `D:\Repos\rocketchatx\.omx\target\pi-connection-acceptance\normal-build\rocketx-workspace-20261117.exe`，SHA256 为 `F56BF55FC3207A31F64DDFAC2751403AB9AE99602D57B915864C5D2DEAE60D01`；本轮前端入口的 SHA256 为 `033B811737219E0C535807C4DD9830463B94E2D6906D2D364A828B1B29E24F45`。这是不含调试符号、依赖仓库现有 Pi runtime 和系统 Node 的本地候选，不是便携版或分发安装包。

构建保护记录确认：用户进程 `252720` 的路径、启动时间及前后 SHA256 保持一致，桥接资源未改；本轮未停止或替换它，也未读取或修改真实 Key。新候选尚未启动，未重验新界面的原生完整任务旅程，不据浏览器图像或构建成功声称用户已运行新界面。

## 2026-11-17：Antigravity 实际执行连接恢复

本轮修复已有 Antigravity 会话发送时 CLI 退出 1、提示 `ANTIGRAVITY_LS_ADDRESS is not set` 的问题。安装发现不等于执行可用：RocketX 原先只继承自身环境，官方 `agentapi` wrapper 不会替外部启动的桥接补齐连接上下文。该问题不要求用户重填地址或更改 DeepSeek Key。

### 修复与保留的行为

- Windows 自动读取固定目录 `~/.gemini/antigravity/daemon/hub_<httpPort>.json`，校验结构、端口、存活 PID、可执行路径、启动时间与文件时间，只接受唯一有效服务；无有效记录或多个服务时不猜测归属。
- 通过官方 CLI 对保留 sentinel UUID 作只读 metadata 握手，确认服务确实应答后才判定连接可用；版本探测成功不再直接等同执行就绪。描述文件 token 只在内存中传给 CLI 环境，不打印或另行持久保存。
- 恢复已有会话及发送前查询原 UUID，拒绝不存在或身份冲突的会话；发送回执的 `recipientId` 必须匹配原会话。失败、超时或回执未知时不自动重发，不静默新建替代会话。
- 删除不可靠的旧 transcript 轮询路径，不把历史文字当成本次执行结果。有效发送回执只说明指令已提交，不证明原端任务完成。
- 前端通过 `connectionReady` 区分连接与历史记录；未连接时发送不可用，仍可查看已收到内容并保留草稿。账本同步不会把未连接会话投影为可实时控制。

| 范围 | 本轮文件 |
| --- | --- |
| 发现、握手、原会话与回执 | `apps/desktop/src-tauri/src/acp_bridge.mjs` |
| 原生可用性探测 | `apps/desktop/src-tauri/src/acp.rs` |
| 连接状态与草稿 | `apps/web/src/stores/acpAgents.ts`、`components/AcpWorkspaceSurface.tsx` |
| 工作账本中的控制能力 | `apps/web/src/agent/superAgentBridge.ts` |
| 回归与 UI | 新增 `scripts/regressions/antigravity-connection.test.ts`；更新 `acp-client-workflow.test.ts`、`native-session-handoff.test.ts`、`tests/ui/native-session-handoff.spec.ts` 与 `acp-conversation-layout.spec.ts` |

复用已安装的官方 CLI 与现有 ACP 流程，没有新增依赖、后台侧车或第二套连接服务。

### 已验证结果

日志目录：`.omx/logs/antigravity-connection-20261117/`。

| 检查 | 本轮结果／证据 |
| --- | --- |
| 本机只读连接 | 实际 `--probe` 返回 `{"ready":true}`，退出码 0，约 1.85 s；`local-readonly-probe.log`；未发送任务或读取真实聊天 |
| 定向回归 | 27／27 通过；`targeted-regression.log` |
| 全量回归 | 1324／1324 通过，66.836 s；`regression.log` |
| 相关 UI | 13／13 通过，15.3 s；`ui.log`；不是全库 UI |
| 类型／构建 | 全工作区类型检查与构建通过，Vite 9.63 s；`typecheck.log`、`build.log` |
| 架构与复核 | 34 个 Tauri 相关文件、0 个例外；`architecture.log`；独立代码复核 APPROVE |
| Rust 定向单位检查 | `acp::tests::antigravity_probe_requires_explicit_success_and_preserves_connection_reason`：1 通过、0 失败，269 项未运行，0.71 s；`native-unit.log`；测试产物编译 32.10 s 通过，`native-unit-build.log`；不代表 Rust 全量 |
| 独立桌面构建 | 34.52 s 通过，退出码 0；`native-app-build.log`；正常应用标识的新候选未启动，未发送真实 Agent 任务 |

### 平台与能力边界

hub 读取规则基于本机 Antigravity **44.9.1**、Language Server **2.32.1**，不是公开稳定契约，版本变化后需重新验证。自动发现当前仅支持 Windows；其他平台需已有完整的 sidecar 环境及有效执行入口。连接描述缺失或不唯一时明确失败，不自动修改原应用配置。

官方 [Sidecars 文档](https://antigravity.google/docs/sidecars)说明 `agentapi` 可以向已有会话发送消息，新建会话需要项目 ID。本桥接当前只支持继续已有会话，缺少可靠项目 ID 时不从这里新建；原端取消和完成结果回传尚未支持，停止本地等待不代表停止原应用已收到的任务。本轮只读探测不证明真实发送、任务完成或成果交付，之前的全库 UI 失败边界也没有因此消除。

正常应用标识 `com.lusipad.rocketx` 的本地候选已暂存于 `D:\Repos\rocketchatx\.omx\target\pi-connection-acceptance\normal-build\rocketx-antigravity-20261117.exe`，SHA256 为 `D66840CF3B16B77CAE56ADE44A4D77B7B0A902E20BC46EDE8CD86E3AD66FA018`，58939904 字节；清单为 `.omx/logs/antigravity-connection-20261117/normal-artifact.json`。新前端入口和冻结 bridge 已包含在产物中；dev 模式仍优先读取仓库 `src/acp_bridge.mjs`，原正常目录中的旧 sidecar 文件未覆盖。因此这是依赖仓库运行资源的本地候选，不是便携版或分发安装包。

构建保护记录确认，当前运行 `rocketx-workspace-20261117.exe` 的用户进程 `288796`，其路径、启动时间和前后 SHA256 均保持不变；证据为 `native-build-protection.json`。本轮不发布、不停止用户实例、不更改真实 Key，新候选未启动、未发送真实 Agent 任务；不能据只读连接探测或构建成功声称用户窗口已更新或任务已执行。

## 2026-11-17：在工作详情接续导入的 Codex 原会话

用户截图暴露了入口断层：已有原生 Codex 交接后端，但 `WorkCardPortal` 对只读历史直接打开预览，工作详情无法完成交接。现在对来源和本机目录明确的外部 Codex 会话显示“尚未接续”，保留查看记录，并就地提供“原 Codex 会话已停止执行”确认与“在这里继续原会话”入口。

`superAgentBridge.openOrResumeWorkSession` 仅在明确交接时放行这条路径，沿用原生 ID、sourceScope、原配置 ID、目录、来源记录和工作关联。继续复用已有原生一次性交接令牌与恢复入口，没有创建新会话或自动发送提示词；检查来源账号和设备，`acpAgents.resumeLocalSession` 在异步准备后复核账号，账号切换即停止。默认查看历史及其他只读来源行为不变。

改动文件为 `WorkCardPortal.tsx`、`superAgentBridge.ts`、`acpAgents.ts`，没有新增依赖或修改 Rust/bridge。新增测试覆盖明确确认、原身份/来源/配置透传、账号/设备不匹配、准备期间切换账号，以及确认前禁止接管、接续不自动发送。

独立复核另发现并修复：已有控制器的快速匹配不能忽略指定执行配置；原配置缺失或停用时不得改用其他配置；加载期间切换账号时只停止本次控制器且不导航到旧账号会话。两条模拟回归已复现并验证，独立复核 APPROVE。

证据目录 `.omx/logs/codex-import-control-20261117/`：最终定向回归 14/14；最终全量回归 1328/1328（65.71 s，`regression-final.log`）；最终相关 UI 10/10（15.3 s，`ui-final.log`）；最终全工作区类型检查与构建通过（Vite 12.79 s，`typecheck-final.log`／`build-final.log`）；架构检查 34 文件/0 例外，最终 diff 检查通过。实际查看 `codex-handoff.png`，新入口和确认项清晰可读；截图为测试数据。

能力边界：这是用户停止原端后的原会话交接，不能同时遥控正在工作的 Codex App。后端不能独立证实原端已停止，因此保留用户确认；没有向真实会话发送任务，本次测试不证明真实账号下的执行与成果交付。

最终本地候选为 `.omx/target/pi-connection-acceptance/normal-build/rocketx-codex-handoff-20261117.exe`，正常应用标识，原生构建 38.02 s／退出码 0；SHA256 `681547BD5ED7F9C7219C8D5553BC39A262A2D8CC2EEBC90CD30291E09BFAD9B4`。实际嵌入最终 `index-DT8BsMvR.js`，前端入口 SHA256 `13F9E880ECBF4DD34EDA41EEEFB7B1F22CB9FACC8CC21F1B904070ABA99A1389`；清单为本轮证据目录 `normal-artifact.json`。中途首轮构建未作为最终交付证据。构建保护确认用户进程 288796 的原路径、启动时间和 hash 不变；新程序未启动或替换用户实例，不是便携分发包。
