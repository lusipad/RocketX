# Implementation notes — DSH 独立后端与视图

Plan: 当前任务内的 DSH 纵切计划

## Summary

RocketX 保留既有 Codex 前端与运行时。DeepSeek 页面改为由官方 DSH Web 提供，并在 Butler 中以 sandbox iframe 嵌入 bridge 校验后的本地 loopback URL；RocketX 只负责本地进程生命周期和宿主。AI 托管与共享 Agent 仍通过 controller/host 模式走 DSH 原生 RPC，不再自绘 DSH 会话/设置 UI。

当前桌面端只保留一个启动级 AI 运行时选择：Codex、DSH 或无 AI。这个选择保存后要重启才生效，RocketX 不做同进程热切换，也不会同时启动两个后端。

## Decisions

- **Keep:** `dsh web` 的 session、history、mux、approval、question 与 credentials 语义，官方 DSH Web 仍是这些配置和会话状态的真源。
- **Adapt:** 通过 Tauri 托管一个共享 Node bridge；它先以 `host.describe` 确认目标确为 DSH Host，再把严格限制为 `127.0.0.1` 的 URL 交给 sandbox iframe，同时为房间与托管控制器复用同一 Host RPC 事件流。RocketX WebView 不直接持有 DSH Host RPC 通道。
- **Drop:** RocketX 自绘 DSH 会话/设置 UI、ACP fresh-session 替代方案、通用 runtime registry/capability 层。
- DSH Web 没有外部输入注入协议；无房间目标的交接只能复制提示词并打开官方 DSH Web，让用户手动粘贴发送。
- 正式发行拆成 slim 探测层与 Windows full 私有运行时层：slim 只探测已安装的系统 Codex / DSH，Windows full 才把官方 npm `@deepseek-ai/dsh@0.1.0-rc.6`、固定 Codex、兼容 Node 和 OCR 以私有资源方式安装到应用数据目录。
- slim 不再把系统 Node.js 作为 RocketX 自身前置条件；如果用户接入外部 DSH 安装，只按外部安装自己的运行要求处理。Windows full 的私有运行时升级需要安装新的 full，slim updater 不会更新这些私有资源。
- 启动顺序优先使用系统 DSH，只有系统安装不可用且存在 full 私有运行时回退时才用私有资源。
- DSH 使用稳定的 RocketX 私有 `DSH_HOME`；同一应用进程只允许一个共享 DSH Host 写入该目录，各 Web／房间／托管入口通过独立租约复用宿主。连接目录只保存可删除的临时 patch 与附件，会话与凭据不能随单个租约释放而删除。
- RocketX 现有只读 business MCP 通过 DSH 自带 `@deepseek-ai/dsh-mcp-client` 注入；有副作用的计划任务工具本轮不接入。
- DSH 凭据只经 `credentials.describe/set/unset` 单向写入 DSH 自己的 `$DSH_HOME/.credentials.yaml`；前端不得持久化、回显或记录密钥值。上游 rc.6 在 POSIX 使用 `0700/0600`，Windows 依赖用户应用数据目录 ACL，并非系统 Keychain。
- AI 托管会话只持久化 `backend` 与该后端的原生会话 ID；旧记录缺少 `backend` 时按 Codex 读取，活动会话不做跨后端迁移。
- Rocket.Chat 的租约、成员放行、消息上下文、串行队列、状态卡和回帖继续共用；Codex 与 DSH 只在控制器、审批/提问响应和署名处显式分支。
- DeepSeek 私人会话由官方 DSH Web 管理默认模型、Agent preset 和权限 preset；共享托管开启页只读取 DSH 原生目录并保存本次会话快照，不在 RocketX 本地复制一份默认配置。
- 共享托管按 `session.create({ agentPreset })` → 可选 `session.selectModel` → 可选 `commands/execute('/permission …')` 的顺序准备空会话。显式模型选择会按 DSH 上游语义同时成为后续默认；Agent 与权限选择只作用于本次 Session，且整个流程不调用 `settings.update` 或 `settings.mutate`。

## Deviations

- 原计划只做会话纵切。真实 prompt smoke 在私有 `DSH_HOME` 返回 `MISSING_CREDENTIAL`，因此加入最小凭据配置，否则首次使用无法完成一轮对话。
- Windows 关闭单个 Node 子进程可能遗留 DSH 派生进程，因此 bridge 关闭需要清理整棵进程树。
- DSH 首版按入口启动独立 Host，但多个 Host 共享 `DSH_HOME` 会违反上游“每个会话单 writer”约束并造成已提交日志序列分叉；现改为单 Host、多 session、多连接租约，只有最后一个租约释放时才停止宿主。
- DSH Web API 没有创建期模型参数；为保持上游校验与默认值持久化，RocketX 在尚无会话时选择模型会先创建／复用一个空白会话，再调用 `session.selectModel`，没有伪造 `session.create` 字段。

## Surprises

- DSH launcher 参数和 Web app 参数有明确边界：`--patch` 必须在 app 参数 `--port` 之前被 launcher 消费。真实源码 smoke 必须覆盖此顺序，fake CLI 测试不能替代。
- `session.history` 会包含 `source.kind = agent-instructions/plugin` 的 `user/message`；RocketX 对话视图只应展示真正的人类消息，不能把系统上下文显示成用户发言。
- `assistant/chunk` 可能是 finish/error 控制块而非文本增量；事件投影必须按 chunk 类型处理。
- DSH 的三个配置生命周期不同：模型可切当前会话且上游会保存后续默认，Agent preset 必须在创建 Session 时提供，权限通过当前 Session 命令应用。开启页分别说明生效范围，不把它们伪装成一套 RocketX 全局配置。

## Upstream upgrades

DSH Web API 尚无独立协议版本，所以升级单位是 Windows full 里的固定 npm 运行时，而不是 RocketX 内的一组复制模块：

1. 修改 [apps/dsh-runtime/package.json](../apps/dsh-runtime/package.json) 里的 `@deepseek-ai/dsh` 精确版本。
2. 运行 `pnpm install`，让 `pnpm-lock.yaml` 固定新的全依赖树。
3. 运行 `pnpm run prepare:dsh-runtime`，确认部署目录、bridge 复制、`--version` 和 `--dump-default-config` 探测都通过。
4. 运行 bridge 回归、Host API smoke、默认 Agent 会话创建、`llm.models`／`session.selectModel`、`agentPreset.*`、`settings.*`、history/mux、审批/问题和 business MCP 工具清单门禁。
5. 保留 RocketX 的稳定 `DSH_HOME`，只重启 sidecar；会话和凭据不随临时 patch 删除。
6. 若上游 wire contract 变化，只修改 `dsh_bridge.mjs` 与 DSH 专用 store/view；不要向 Codex 路径或通用 runtime 层扩散兼容代码。
