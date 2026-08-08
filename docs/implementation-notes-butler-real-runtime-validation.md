# 管家真实运行时验证实施记录

## Decisions

- 复用委托任务卡片承载运行中人工交互，避免引入与任务上下文脱离的全局弹窗。
- 保持现有审批状态兼容，在同一状态下区分审批与用户输入，减少候选版本改动面。
- 最终验收必须使用真实 Codex app-server 和生产调用链。
- `request_user_input` 的真实协议验收使用 Codex Plan 模式；普通委托完成另用 Default 模式验证，避免把 Plan item 误判为普通最终答复。
- 定时任务使用系统允许的最短 15 分钟 interval，并利用首次运行立即到期语义完成短时验证。
- Node 烟测按仓库既有约定注入 `createMemoryBackend()`，仅替代浏览器 IndexedDB；Codex transport、委托 store、workflow 和 Skill runner 保持生产实现。

## Deviations

- 为避免读取或修改真实群数据，`room-digest` 未配置房间；真实 Skill 被调度并返回“缺少房间范围”的边界结果。该场景验证的是调度、workflow、Skill 装载与结果落库，不声称验证 Rocket.Chat 房间内容读取。
- MCP 标准 elicitation 使用真实生产状态层和浏览器交互回归验证；本轮没有可安全触发 elicitation 的外部 MCP 服务，因此没有把外部 MCP 请求纳入 app-server smoke。

## Surprises

- Default 模式不会仅因提示词主动暴露 `request_user_input`；Plan 模式会按官方协议发出 `item/tool/requestUserInput`。
- app-server 在回答后会发出 `serverRequest/resolved` 并完成原 turn，但 Plan 输出不一定形成普通 `agentMessage`，因此不能用委托卡最终回复作为 host-input 协议的唯一成功条件。
- Node 环境没有 IndexedDB，未注入仓库提供的内存后端时 workflow 会在进入 Skill 前失败；这属于烟测环境缺失，不是桌面端运行缺陷。
- 已注册工作区必须复用其 id，不能再次按 pending 路径落库；真实 smoke 已按生产白名单约束修正。

## Questions

- 暂无。
