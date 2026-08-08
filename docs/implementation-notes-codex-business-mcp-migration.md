# Implementation notes — Codex 业务 MCP 无感接入

Plan: `docs/codex-business-mcp-migration-plan.md`

## Decisions

- 内部业务 MCP 使用独立的 `--business-mcp` 入口；现有 `--mcp` 继续代表用户显式授权
  给外部 AI 的只读能力。
- Butler 对话与 Butler Errand 自动合并内部 MCP 配置，用户不接触配置 JSON；
  通用 `localCodex` / `sharedAgent` 默认不获得业务数据权限。
- Skill 负责方法，MCP 负责独立业务查询，Host Dynamic Tools 只保留 WebView/UI 本地状态。
- Windows ADO 默认使用当前登录身份；PAT 不是启用条件，只兼容用户已经保存的配置。
- 第一阶段只迁移 Rocket.Chat 与 ADO 读操作。
- 已验证等价的 ADO 工作台快照 Dynamic Tools 已删除，避免模型在实时 MCP 与 UI 快照
  之间选回旧路径；legacy Azure Skill CLI 只保留给非原生兼容路径。尚未等价的
  Rocket.Chat 本地工具继续可用。
- 工作台、`adoDirect` 和用户在 UI 中的确定性查询/操作保持不变；只有 AI 数据入口收敛。
- 自然语言不由 TypeScript 场景标签追问或强制选择 Skill；标签只供任务归档与用户确认后
  的 Skill 学习，且不会注入模型提示。显式 `$skill` 仍作为用户主动指定方法的快捷方式。

## Deviations

- vendored `azure-devops-server` Skill 继续保持上游文件原样，避免破坏来源和 revision
  合同；RocketX 通过托管 `AGENTS.md` 覆盖其中的凭据采集、bootstrap 和 PowerShell
  步骤，只允许调用 `rocketx_azure_devops_server_read`。
- Workbench 的 `bearer` / `none` 认证暂不映射到内部 MCP。遇到这两种模式时清除内部
  ADO 凭据，避免沿用旧连接；Windows 默认凭据和 PAT 路径已实现。
- MCP 工具调用由 Codex 以 `mcpToolCall` item 通知，不走 Dynamic Tool 的服务端请求；
  Butler 单独把该通知映射成现有的过程步骤与结果事件。

## Surprises

- 当前 `winauth.rs` 没有调用 `WinHttpSetTimeouts`。Rocket.Chat MCP token 请求或
  Workbench 的 NTLM 请求遇到不可达主机时，WinHTTP 默认等待可能破坏“离线不死等”
  的产品合同，因此显式网络超时是第一阶段门禁。
- 现有 ADO Host Adapter 外层有 60 秒进程超时。它适合兼容复杂脚本，但对聊天内工具调用
  太长；实现需参数化，而不是全局缩短并影响已有路径。
- 逐线程 `config.mcp_servers` 已在 Codex `0.144.4` 和 `0.145.0` 上完成真实发现与调用；
  生产缺口主要是自动配置、认证同步和业务工具等价，不是再造路由器。
- 现有外部 `rcx-mcp` 只有三个读取工具，缺少 Butler 所需的消息搜索、人员/房间搜索和
  明确分页完整性合同，不能直接宣布迁移完成。
- `list_mentions(unprocessedOnly)` 的 `processed` 状态来自 Today/Butler 的本地收件箱，
  不是 Rocket.Chat 服务端事实，因此该工具必须保留在 Host Dynamic Tool 边界。
- Butler resident 的 resume 失败会走 transcript-rebuilt `thread/start`；Errand 在线程
  仍等待审批/输入时会保守停回 `paused`。MCP 自动配置必须覆盖前者，但不能改变后者。
- 当前 ADO adapter 路径通过 Tauri `AppHandle` 解析；`--business-mcp` 会在 Tauri UI
  初始化前运行，实现时必须提取一个不依赖 `AppHandle` 的受管资源定位函数。
- 同时向 Codex 注册新 ADO MCP 工具和旧 ADO Dynamic Tool 时，真实模型仍会选旧工具。
  因此“影子兼容”只能保留实现，不能把两个等价入口同时暴露给模型。
- MCP 调用不会自动进入现有 Butler `tool-call` / `tool-result` 事件流；若不显式桥接，
  后端虽已查询成功，界面过程区仍看不到正在调用哪个业务工具。

## Implemented

- 新增独立 `rocketx.exe --business-mcp` stdio 入口、专用系统凭据项和 6 个只读工具：
  Rocket.Chat 会话、线程、房间历史、消息搜索、人员/房间搜索，以及 Azure DevOps
  Server GET。
- Butler resident 的 start/resume/transcript rebuild、ephemeral workflow 和 Butler
  Errand 的 start/resume 自动合并 MCP 配置；通用 `localCodex` / `sharedAgent` 不注入。
- 登录、token 恢复、登出、认证失效和 Workbench 配置更新自动同步或清理内部凭据；
  业务 MCP 配置失败最多等待 1 秒，普通聊天配置仍可继续使用。
- Rocket.Chat 账号或 ADO 连接切换时先撤销旧 keychain 再写入新值；Web 侧只有两类
  凭据都完成同步或清理后才注入 MCP。同步失败会补发清理，并通过凭据 revision
  让常驻管家下一轮重建线程，避免继续复用旧账号或旧 collection/PAT。
- WinHTTP 设置了解析、连接、发送和接收超时；ADO 业务调用外层限制为 15 秒；多房间
  Rocket.Chat 搜索遇到离线、超时或认证失败后不再逐房间重复等待。
- ADO、晨报、晚间回顾、周报和 PR comparison Skill 契约已切到
  `azure-devops-server` + `rocketx_azure_devops_server_read`；工作台快照查询实现及其
  Dynamic Tool 注册已删除。
- Butler 不再本地拦截不完整指代，也不再给自然语言 PR 比较强塞 `skillName`；Codex
  原生 Skill 负责隐式匹配、追问和工具顺序。

## Verification

- Rust：格式检查、完整构建和 71 项全量测试通过，其中包含 business MCP 6 项定向测试
  与完整 adapter 路径测试。
- Web：类型检查与生产构建通过；账号/ADO 切换 fail-closed、原生 Skill 路由和工作台
  隔离回归均通过；全量回归 950/950 通过。
- 四个修改过的托管 Skill 均通过 Codex `skill-creator` 的 `quick_validate.py` 校验。
- 实际 `rocketx.exe --business-mcp` 无配置启动并列出工具耗时 55 ms，固定 6 个只读
  工具，未知工具返回结构化不可重试错误。
- Codex `0.144.4`（仓库固定版）与 `0.145.0`（系统版）都能从线程级配置发现真实
  `rocketx-business` 服务器及全部工具。
- 两个 Codex 版本的 ADO Skill 前向测试都只调用
  `rocketx_azure_devops_server_read`，经现有只读 adapter 命中 mock ADO；旧 Dynamic
  Tool 未调用。

## Remaining risks

- Rocket.Chat MCP 已可供 Codex 独立读取，但消息结果仍是服务端事实结构；日期/发送人/
  附件复合筛选和本地永久链接补全尚未达到现有 `search_messages` /
  `list_room_messages` 的完整等价，所以这两项 Host 工具尚未移除。
- 第一阶段仍不向通用 `localCodex` / `sharedAgent` 注入业务权限。
