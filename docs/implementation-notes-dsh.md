# Implementation notes — DSH 独立后端与视图

Plan: 当前任务内的 DSH 纵切计划

## Summary

RocketX 保留既有 Codex 前端与运行时，另建一条直接消费 DSH Web Host API 的独立视图。模型、Agent preset 与权限 preset 直接走 DSH 原生目录、Settings 和会话 RPC；RocketX 只负责本地进程生命周期、协议桥、业务 MCP patch 和界面投影，不复制 DSH agent 内核。

## Decisions

- **Keep:** `dsh web` 的 session、history、mux、approval、question 与 credentials 语义。
- **Adapt:** 通过 Tauri 托管 Node bridge，WebView 不直接跨 origin 访问 DSH loopback。
- **Drop:** DSH 自带 Web UI、ACP fresh-session 替代方案、通用 runtime registry/capability 层。
- 正式发行拆成 slim 探测层与 Windows full 私有运行时层：slim 只探测已安装的系统 Codex / DSH，Windows full 才把官方 npm `@deepseek-ai/dsh@0.1.0-rc.6`、固定 Codex、兼容 Node 和 OCR 以私有资源方式安装到应用数据目录。
- slim 不再把系统 Node.js 作为 RocketX 自身前置条件；如果用户接入外部 DSH 安装，只按外部安装自己的运行要求处理。Windows full 的私有运行时升级需要安装新的 full，slim updater 不会更新这些私有资源。
- 启动顺序优先使用系统 DSH，只有系统安装不可用且存在 full 私有运行时回退时才用私有资源。
- DSH 使用稳定的 RocketX 私有 `DSH_HOME`；连接目录只保存可删除的临时 patch，会话与凭据不能随 bridge stop 删除。
- RocketX 现有只读 business MCP 通过 DSH 自带 `@deepseek-ai/dsh-mcp-client` 注入；有副作用的计划任务工具本轮不接入。
- DSH 凭据只经 `credentials.describe/set/unset` 单向写入 DSH 自己的 `$DSH_HOME/.credentials.yaml`；前端不得持久化、回显或记录密钥值。上游 rc.6 在 POSIX 使用 `0700/0600`，Windows 依赖用户应用数据目录 ACL，并非系统 Keychain。
- AI 托管会话只持久化 `backend` 与该后端的原生会话 ID；旧记录缺少 `backend` 时按 Codex 读取，活动会话不做跨后端迁移。
- Rocket.Chat 的租约、成员放行、消息上下文、串行队列、状态卡和回帖继续共用；Codex 与 DSH 只在控制器、审批/提问响应和署名处显式分支。
- DeepSeek 独立会话与 AI 托管共享 DSH 自己持久化的默认模型、Agent preset 和权限 preset；RocketX 不映射 Codex 的模型、推理强度或权限预设，也不在本地复制一份配置。
- 模型切换遵循 DSH 的 `session.selectModel` 语义：应用到当前会话并由 DSH 保存后续默认；Agent preset 写入 `agent-presets` 默认值且只重组空白会话；权限 preset 写入 `permission` 默认值，并通过原生 `commands/execute` 执行 `/permission` 同步当前会话。

## Deviations

- 原计划只做会话纵切。真实 prompt smoke 在私有 `DSH_HOME` 返回 `MISSING_CREDENTIAL`，因此加入最小凭据配置，否则首次使用无法完成一轮对话。
- Windows 关闭单个 Node 子进程可能遗留 DSH 派生进程，因此 bridge 关闭需要清理整棵进程树。
- DSH 托管首版为每个活跃 Rocket.Chat 托管会话启动独立连接，以换取隔离和更小实现；若真实并发证明进程成本不可接受，再基于数据合并 sidecar，当前不预建池化层。
- DSH Web API 没有创建期模型参数；为保持上游校验与默认值持久化，RocketX 在尚无会话时选择模型会先创建／复用一个空白会话，再调用 `session.selectModel`，没有伪造 `session.create` 字段。

## Surprises

- DSH launcher 参数和 Web app 参数有明确边界：`--patch` 必须在 app 参数 `--port` 之前被 launcher 消费。真实源码 smoke 必须覆盖此顺序，fake CLI 测试不能替代。
- `session.history` 会包含 `source.kind = agent-instructions/plugin` 的 `user/message`；RocketX 对话视图只应展示真正的人类消息，不能把系统上下文显示成用户发言。
- `assistant/chunk` 可能是 finish/error 控制块而非文本增量；事件投影必须按 chunk 类型处理。
- DSH 的三个配置生命周期不同：模型可切当前会话，Agent preset 只能切空白会话，权限既有后续默认又有当前会话命令。把它们压成一个通用“运行参数”对象会丢失上游语义，因此界面分别说明生效范围。

## Upstream upgrades

DSH Web API 尚无独立协议版本，所以升级单位是 Windows full 里的固定 npm 运行时，而不是 RocketX 内的一组复制模块：

1. 修改 [apps/dsh-runtime/package.json](../apps/dsh-runtime/package.json) 里的 `@deepseek-ai/dsh` 精确版本。
2. 运行 `pnpm install`，让 `pnpm-lock.yaml` 固定新的全依赖树。
3. 运行 `pnpm run prepare:dsh-runtime`，确认部署目录、bridge 复制、`--version` 和 `--dump-default-config` 探测都通过。
4. 运行 bridge 回归、Host API smoke、默认 Agent 会话创建、`llm.models`／`session.selectModel`、`agentPreset.*`、`settings.*`、history/mux、审批/问题和 business MCP 工具清单门禁。
5. 保留 RocketX 的稳定 `DSH_HOME`，只重启 sidecar；会话和凭据不随临时 patch 删除。
6. 若上游 wire contract 变化，只修改 `dsh_bridge.mjs` 与 DSH 专用 store/view；不要向 Codex 路径或通用 runtime 层扩散兼容代码。
