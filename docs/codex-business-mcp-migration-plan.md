# Codex 业务 MCP 无感接入改造计划

## 1. 待复核的关键决策

### 1.1 用户合同：登录后直接聊天

用户不需要理解或配置 MCP。桌面端成功登录 RocketX 后，Butler 对话和 Butler 派出的
Errand 自动获得 Rocket.Chat 与 Azure DevOps Server 的只读业务工具。

用户可直接用自然语言提出：

- “找一下昨天项目群里关于发布失败的讨论”
- “我有哪些未完成的工作项”
- “看看 PR 42 最近一次构建为什么失败”

自然语言是默认入口；`$skill` 只保留为用户主动指定方法的专家快捷方式。聊天界面不为
这些查询常驻“转成果”等含义不清的操作按钮。

界面不增加“启用业务 MCP”“复制 JSON”“重启 Codex”或“必须填写 PAT”的步骤。
现有“让外部 AI 工具读你的聊天”设置继续是独立、显式授权的能力，不因本计划自动开启。

**置信度：高。** 这是本轮新增的硬产品约束。若改变，会直接改变认证、权限和 UI 方案。

### 1.2 内部业务 MCP 与外部 MCP 分权

复用同一个 RocketX 桌面可执行文件，但使用两个独立入口：

| 入口 | 调用方 | 开启方式 | 凭据 | 能力 |
| --- | --- | --- | --- | --- |
| `--business-mcp` | Butler 对话与 Butler Errand | 自动注入 | 内部专用凭据项 | Rocket.Chat 搜索 + ADO 只读查询 |
| `--mcp` | 用户自行配置的外部 AI 客户端 | 设置页显式开启 | 现有外部 MCP 凭据项 | 保持现有只读聊天上下文合同 |

两者可以共享 JSON-RPC/MCP 协议实现和 Rocket.Chat 请求函数，但不能共享授权开关或凭据项。
内部自动登录不得静默扩大外部 AI 的访问权限。

**置信度：高。** 若合并两个入口，代码更少，但会把“RocketX 内部可用”错误等同于
“任意外部客户端已获授权”，不可接受。

### 1.3 Skill、MCP 与 Host Tool 的边界

- **Skill**：Markdown 方法论、查询步骤、结果解释和何时调用工具。
- **业务 MCP**：可独立运行的 Rocket.Chat / Azure DevOps Server 读操作。
- **Host `dynamicTools`**：只保留必须读取当前 WebView/UI 状态的能力，例如本地待办、
  Today、审批卡、当前 Errand 状态和当前界面快照。
- **Codex**：唯一的工具选择、路由、沙箱和审批执行者。

不再给 RocketX 增加第二套 Skill Router、工具选择器或业务 Agent Runtime。

**置信度：高。** 该边界延续现有 Codex 壳层简化方向，只把此前尚未落地的生产业务
MCP 补齐。

### 1.4 自动注入使用一个中央配置函数

新增一个 Web 侧中央函数，负责把以下配置合并进已有 `ThreadStart` /
`ThreadResume` 配置，不能覆盖调用方已有的 MCP server：

```json
{
  "mcp_servers": {
    "rocketx_business": {
      "command": "<当前 RocketX 桌面可执行文件>",
      "args": ["--business-mcp"]
    }
  }
}
```

命令路径由一个轻量 Tauri command 返回并缓存。配置中不得出现 Rocket.Chat token、
ADO PAT、服务器地址或用户 ID。

中央函数只在明确的业务会话入口启用：

1. Butler 常驻会话新建与恢复；
2. Butler 常驻会话恢复失败后的 transcript-rebuilt `thread/start`；
3. Butler 临时会话；
4. Butler Errand 新建与恢复。

通用 `localCodex` 和 `sharedAgent` 代码执行线程默认不注入业务 MCP，避免普通代码任务
自动获得聊天记录和 ADO 读取权限。后续若有明确的“从 Butler 派活”入口，应通过业务
origin 显式启用，而不是按 Store 名全局开启。

浏览器构建、Tauri command 不可用或内部 MCP 启动失败时，原 Codex 对话仍须继续，
只降级业务查询能力。

**置信度：高。** 分散手写配置很容易遗漏恢复重建路径，也会形成配置漂移；按业务 origin
启用同时保留了内部最小权限。

### 1.5 认证默认零输入，已有配置可复用

#### Rocket.Chat

- 登录或 token 恢复成功后，桌面端自动把 `serverUrl`、`userId`、`authToken`
  同步到**内部业务 MCP 专用**系统凭据项。
- 登出、认证丢失或切换账号时，先删除旧凭据，再写入新账号凭据。
- 同步失败不能阻塞 RocketX 登录；只记录诊断。用户真正发起相关查询时，工具返回
  可解释、可重试的结构化不可用结果。
- MCP 每次工具调用读取最新凭据，不要求重启长期存在的 Butler/Codex 任务。

#### Azure DevOps Server

- Windows 桌面端优先复用当前 Windows 登录身份
  （Negotiate/Kerberos，必要时退回 NTLM），不要求 PAT。
- ADO 集合地址和认证模式在 Workbench 保存/探测成功后自动同步到内部 MCP 配置。
- 用户已有 PAT 配置时可作为兼容回退；业务 MCP 所需的副本只保存到系统凭据库，
  不得进入线程配置、Prompt、日志或工具参数。本计划不顺带重写 Workbench 自身的
  既有存储格式。
- 非 Windows 或没有可用 ADO 配置时，ADO 工具快速返回 `unavailable`，不影响
  Rocket.Chat 工具和普通对话。

**置信度：高。** 当前 Workbench 已经采用 NTLM 优先顺序；本计划只把相同决策延伸到
Codex 的独立 MCP 进程。

### 1.6 工具清单固定，配置在调用时解析

`tools/list` 不访问网络，固定暴露以下只读工具，避免配置变化后要求重启 MCP：

| 工具 | 用途 |
| --- | --- |
| `rocketx_list_conversations` | 列出当前账号可访问会话 |
| `rocketx_get_room_history` | 分页读取频道、私有组或私聊历史 |
| `rocketx_get_thread_context` | 读取一个消息线程 |
| `rocketx_search_messages` | 按关键词、房间和时间范围搜索消息 |
| `rocketx_search_people_rooms` | 搜索人员与会话 |
| `rocketx_azure_devops_server_read` | 执行受控 ADO Server GET 查询 |

现有 `list_mentions(unprocessedOnly)` 继续作为 Host Dynamic Tool：其中 `processed`
来自 Today/Butler 本地收件箱状态，不是 Rocket.Chat 服务端数据。为了“全 MCP”搬走它
会丢失语义或迫使 MCP 读取 WebView 状态，均违反本计划边界。

每次 `tools/call` 再读取最新内部配置。未登录、未配置、离线、超时和无权限必须用稳定的
结构化错误码区分，不能伪造空结果：

```json
{
  "status": "unavailable",
  "reason": "offline|not_configured|auth_failed|forbidden|timeout",
  "retryable": true,
  "message": "..."
}
```

**置信度：中高。** 条件化 `tools/list` 看起来更干净，但现有 Codex 任务不一定会在配置
变化后重新取工具清单；固定工具合同更符合“换账号/改地址无需重启”。

### 1.7 第一阶段只迁移读操作

Rocket.Chat 发消息、ADO 评论/改状态/建工作项等写操作不在本阶段。未来若加入，必须：

- 单独建具名工具，不能塞进通用 read 工具；
- 标记为非只读/可能破坏性；
- 经过 Codex 原生审批；
- 在 Skill 中明确展示目标和变更内容。

**置信度：高。** 当前 Butler 已有的业务查询合同就是只读；先迁移读操作可避免把
认证迁移与写入审批混成一个不可审查的大改。

### 1.8 兼容迁移，不一次拔掉旧工具

先让 MCP 与现有 `dynamicTools` 并存，并用同一组契约样例比对结果。MCP 达到等价后：

1. Skill 和生成的 Butler 指令改用 MCP 工具名；
2. 默认路径停止注册重复的 Rocket.Chat/ADO Dynamic Tools；
3. 保留一个短期开发回退开关；
4. 稳定一个发布周期后再删除旧业务适配代码。

Host 本地状态工具不参与删除，包括带本地 `processed` 状态的 `list_mentions`。

当前进度：ADO 已完成该收敛。工作台及 `adoDirect` 继续服务确定性 UI；AI 侧不再注册
`list_work_items`、`list_pull_requests`、`list_builds` 工作台快照工具，自然语言由
Codex 原生 Skill 隐式发现，ADO 实时事实统一经 `azure-devops-server` Skill 与业务 MCP。
Rocket.Chat 仍按下述等价性门禁渐进迁移。

**置信度：高。** 当前工作区还有大量在途 Butler 改造；影子迁移能避免把业务 MCP
改造与未完成的聊天体验变更互相覆盖。

## 2. 假设

| 假设 | 置信度 | 来源/验证方式 |
| --- | --- | --- |
| Codex 固定版 `0.144.4` 与系统版 `0.145.0` 都支持逐线程 `config.mcp_servers` | 高 | `pnpm spike:codex-mcp-config` 已在两版完成发现和真实工具调用 |
| `ThreadStart` 与 `ThreadResume` 都能接受嵌套 MCP 配置 | 高 | 当前协议类型与已核对的 Store 调用合同 |
| RocketX 桌面可执行文件可以继续承载另一个 stdio MCP 入口 | 高 | 现有 `--mcp` 已使用相同进程模型 |
| Rocket.Chat token 可以在 Tauri 进程内写入系统凭据库 | 高 | 现有外部 MCP 设置已经采用此路径 |
| ADO Windows 集成认证是桌面端默认和最便捷路径 | 高 | `adoDirect.ts` 与 `winauth.rs` 已实现 NTLM/Negotiate 优先 |
| 现有 ADO PowerShell Host Adapter 可以复用验证、版本兼容和脱敏边界 | 高 | 已有 GET-only 校验、受限 area/resource/query、超时和回归测试 |
| MCP 工具清单变化通知在两版 Codex 上没有稳定合同 | 中 | 当前探针只证明初始化发现；因此本计划不依赖动态工具清单 |
| 浏览器版无法直接使用桌面内部 MCP | 高 | 没有当前桌面可执行文件和系统凭据库入口 |

尚未把“浏览器版也具备同等业务 MCP”当作本计划目标。浏览器版继续走现有 Host
Dynamic Tools；这不是让桌面等待的理由。

## 3. 偏离策略

“保守偏离”定义为同时满足：

1. 不改变用户数据和授权范围；
2. 不扩大写权限；
3. 不覆盖现有线程配置；
4. 不要求用户新增设置步骤；
5. 可以通过关闭内部开发开关回退；
6. 记录在 `docs/implementation-notes-codex-business-mcp-migration.md`。

实现中若遇到小型协议或平台差异，可选择最小、可逆且最接近本计划意图的方案继续。

以下情况必须停止该分支实施并重新评审：

- 需要自动开启现有外部 MCP；
- 需要把 token/PAT 放进 Prompt、线程配置、命令行或普通日志；
- 需要让业务 MCP监听 TCP 端口；
- 需要绕过 Codex 沙箱或审批；
- 需要用“返回空数组”掩盖离线、权限不足或查询不完整；
- 需要删除尚未完成等价验证的旧 Dynamic Tool；
- 需要为浏览器版引入常驻本地代理或新的账号授权流程。

## 4. 机械工作

### 阶段 A：锁定合同与失败边界

1. 扩展 `scripts/spike-codex-mcp-config.ts`：
   - 验证自动合并不会覆盖已有 MCP server；
   - 验证 start/resume 都能发现 `rocketx_business`；
   - 验证通用 `localCodex` / `sharedAgent` 默认没有业务 MCP；
   - 验证命令参数和临时 Codex Home 中没有测试凭据。
2. 为 MCP JSON-RPC 核心增加 Rust 单元测试：
   - initialize、tools/list、未知工具、非法参数、配置缺失；
   - stdout 只输出 MCP 帧，诊断只走 stderr；
   - 工具清单不触网。
3. 给 WinHTTP 增加显式 DNS/连接/发送/接收超时，并增加不可达地址的有界失败测试。
4. 把 ADO runner 的超时参数化：
   - 现有 Host Tool 保持当前兼容超时；
   - 对话 MCP 单次调用最长 15 秒；
   - 超时后清理 PowerShell 子进程。
5. 本地 launch config、MCP initialize、`tools/list` 和未配置错误均不得触网，并在
   1 秒内完成。

### 阶段 B：内部 MCP 进程与自动配置

1. 在桌面入口增加 `--business-mcp`，与 `--mcp` 在创建 Tauri App 前分流。
2. 从现有 `mcp.rs` 提取最小共享协议循环，外部入口行为保持不变。
3. 增加内部配置的 Tauri commands：
   - 返回 launch config；
   - 同步/清除 Rocket.Chat 凭据；
   - 同步/清除 ADO 配置；
   - 只向前端返回非敏感状态。
   - 内部 Rocket.Chat 使用
     `com.lusipad.rocketx.business-mcp.rocket-chat/active`；
   - 内部 ADO 使用
     `com.lusipad.rocketx.business-mcp.azure-devops/active`；
   - 现有外部 `com.lusipad.rocketx.mcp/active` 不迁移、不复用、不交叉删除。
4. 新增 Web 侧中央 MCP 配置合并函数，带短本地 deadline 和缓存。
5. 接入 Butler resident、ephemeral、transcript-rebuilt start 与 Errand
   start/resume；失败时继续原任务并写诊断。
6. Errand 恢复后若原线程仍在等待审批或用户输入，保持现有 `paused` 和人工接管语义；
   不为“无感”自动批准、自动重放或新建替代线程。

### 阶段 C：Rocket.Chat 查询等价

1. 复用现有 REST URL、token header 和响应解析函数。
2. 补齐分页、时间范围和结果完整性字段，不能把首屏结果冒充全量。
3. 将现有 Butler 工具的语义样例转换成 MCP 契约测试：
   - 消息搜索；
   - 房间历史；
   - 线程上下文；
   - 人员/房间搜索。
4. 模拟 401、403、404、网络断开、超时和畸形 JSON。

### 阶段 D：Azure DevOps Server 查询等价

1. 把现有 ADO 请求验证器和 runner 提取为 MCP 与 Tauri command 共享函数。
   - 当前 adapter 路径依赖 Tauri `AppHandle`；需提取一个在 UI 初始化前也能解析
     受管资源的函数，不能为了 MCP 启动完整 Tauri App。
2. MCP 工具参数只包含查询意图，不包含连接地址或凭据：
   - `area`、`resource`、`project`、`team`、`query`；
   - `apiVersion`、`serverVersionHint`、`allowConditionalArea`。
3. Host 从内部配置注入 `collectionUrl`、`authMode` 和可选 PAT。
4. 保留现有约束：
   - 强制 GET；
   - area 白名单；
   - resource/query 长度与形状校验；
   - stdout/stderr 上限；
   - PAT 脱敏；
   - PowerShell 解析和受管脚本来源。
5. 在 Windows 上验证默认凭据；PAT 只做已有配置兼容回归。

### 阶段 E：Skill 切换与旧路径退场

1. 更新 RocketX 自有 Skill：
   - `pr-comparison`
   - `host/azure-devops-server`
   - 使用 Rocket.Chat 查询的核心 Skills
2. 更新 `butlerArchive.ts` 生成的运行说明，停止要求
   `run_azure_devops_server_cli`。
3. 完整 vendored `azure-devops-server` Skill 尽量保持上游正文不变；只在 RocketX
   自有薄 Skill 中描述 MCP 入口，避免维护上游分叉。
4. 在双路径回归通过后停止默认注册重复业务 Dynamic Tools。
5. 删除仅为旧业务动态工具存在的标签、schema 和执行分支；不清理无关代码。

### Keep / Adapt / Drop

**Keep**

- Codex 原生 Skill、工具选择、沙箱、审批、Thread、Goal 和 Subagent。
- 现有 `rcx-mcp` 外部只读能力及显式授权 UI。
- ADO Host Adapter 的 GET-only、安全校验、版本兼容、超时和脱敏。
- Host-local Dynamic Tools，包括 `list_mentions`。

**Adapt**

- `mcp.rs`：提取共享协议核，新增内部业务入口。
- 登录/Workbench 配置：自动同步到内部专用凭据项。
- Butler/Errand 业务线程 start/resume：通过中央函数自动合并 MCP 配置。
- Rocket.Chat/ADO 业务 Dynamic Tools：先成为等价基线，再迁到 MCP。
- 自有 Skills：从旧 Dynamic Tool 名切换到稳定 MCP 工具名。

**Drop**

- 用户手动启用内部业务 MCP 的设置流程。
- 业务 MCP 的配置 JSON 复制说明。
- 把 PAT 当作 ADO 必填项。
- 在 Thread 配置、Prompt 或工具参数里传真实凭据。
- 为业务查询再建 Router、Agent Runtime 或常驻网络服务。
- 未完成等价验证前一次性删除旧工具。

## 5. 验证

### 5.1 用户可见验收

1. 桌面端正常登录后，在 Butler 直接问“昨天某房间说了什么”，Codex 能调用 MCP 并
   返回真实消息；用户未打开任何 MCP 设置页。
2. 配置过 ADO 地址的 Windows 用户直接问工作项/PR/构建，默认使用当前 Windows 身份；
   未配置 PAT 仍可成功。
3. 用户切换 Rocket.Chat 账号后，同一已恢复的 Butler 任务读取新账号权限范围，不能继续
   读旧账号数据。
4. ADO 地址或认证模式修改后，无需重启 RocketX 或 Codex。
5. 断网、ADO 主机不可达或 Rocket.Chat token 失效时，普通聊天立即可用；相关工具在
   有界时间内返回明确原因，不无限 loading，不返回伪空结果。
6. 浏览器版、内部 MCP 启动失败或系统凭据库不可用时，RocketX 主聊天仍可发送和回复。
7. 现有外部 MCP 设置默认保持关闭；内部业务 MCP 可用不改变其状态。
8. Butler resident 恢复失败并重建 transcript 时仍带业务 MCP；Errand 等待审批或输入时
   仍停在 `paused`，不会因自动 MCP 而跳过用户接管。
9. 通用 `localCodex` / `sharedAgent` 默认不发现 `rocketx_business`。
10. 未配置错误在 1 秒内返回；Rocket.Chat/ADO 不可达或超时在 15 秒内结束工具调用，
    普通对话不得一直处于 loading。

### 5.2 安全验收

- Codex thread config、命令行、stdout/stderr、应用日志和临时 Codex Home 中均搜索不到
  测试 token/PAT。
- `rocketx_azure_devops_server_read` 无法发送 POST/PATCH/DELETE，无法通过 resource
  逃逸，无法提交嵌套任意对象 query。
- 所有 MCP 工具声明 `readOnlyHint: true`、`destructiveHint: false`。
- 登出和账号切换后的旧 Rocket.Chat token 已从内部凭据项删除。
- 外部 `--mcp` 无法读取内部业务 MCP 的专用凭据项。
- 关闭外部 MCP 只删除 `com.lusipad.rocketx.mcp/active`，不影响内部两项。
- RocketX 登出、切号或清除 ADO 配置只更新内部项，不删除用户显式授权的外部项。
- 现有外部单项配置不复制成内部授权；内部项只由成功登录和 Workbench 配置同步产生。

### 5.3 自动化门禁

最少运行：

```text
pnpm codex:protocol:check
pnpm spike:codex-mcp-config
pnpm exec tsx --test <业务 MCP 与 Butler 相关定向回归>
pnpm --filter @rcx/web typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm build
```

再执行一轮 Windows 桌面 dogfooding，记录：

- MCP 初始化耗时；
- 首次/后续 Rocket.Chat 查询耗时；
- ADO 默认凭据成功路径；
- 离线和不可达主机失败耗时；
- 账号切换后的权限隔离；
- 外部 MCP 状态未被改变。

只有上述门禁通过，且 Skill 已默认走 MCP，才能删除重复业务 Dynamic Tools。
