# RocketX Codex-native 实施记录

> 文档状态：**历史实施记录**。本文解释原生 Codex 迁移如何完成，但不再是唯一运行时合同；当前行为以[功能规格](specs/README.md)、[Codex Runtime](specs/codex-runtime.md)和[权限与审批](specs/approvals-and-permissions.md)为准。

计划：`.omx/plans/autopilot-spec.md`、`.omx/plans/autopilot-impl.md`

## Decisions

- 内部导航使用 Codex 的新对话、拉取请求、已安排、插件和项目对话历史；拉取请求进入 RocketX 确定性的 ADO 工作台，动态和设置嵌入任务上下文。
- App Server 是唯一智能运行时；RocketX 业务能力通过 Skill、App/MCP 或确定性 Host adapter 接入。
- 默认权限“替我审批”采用工作区权限边界内的 `guardian_subagent`，不再使用只读沙箱伪装可执行能力。
- 运行中后续输入默认 Steer，可显式切换 Queue，与当前 Codex App 行为一致。
- RocketX 与 Codex App 按顺序使用同一原生 Thread；标题栏的“从 Codex 刷新”会停止旧 Controller、重新连接并 `thread/resume` 同一 `threadId`，再加载外部新增 Turns。运行中或等待确认时禁止刷新。
- 直接以当前 Codex Runtime 为协议基线，插件管理、Skills 与 Apps/MCP 全部按 Codex App 语义实现；不兼容旧 Runtime。
- Scheduled 暂由 RocketX 本地宿主保存，并显式标注来源。
- 旧 Butler/Codex 双轨 Store、页面和回归契约直接退出，不做状态迁移或兼容桥。

## Deviations

- Apps 远端目录可因账号或 Cloudflare 返回 403；该目录现在独立失败并在 Apps 页签提示，不再阻断其他 Codex 能力。
- Codex App 的“站点”没有对应的真实 RocketX 能力与稳定路由，因此本轮没有添加假入口。

## Surprises

- 现有任务面把旧审批 reviewer 与 `readOnly` 同时硬编码，导致“替我审批”看似放权但实际无法执行。
- 现有协议生成物已经包含所需模型、权限、App 和原生审批类型，缺口主要位于手写客户端与 Store。
- pinned Codex 0.144.4 真实验证返回 7 个模型、3 个权限档、79 个 Skills 和 2531 个插件；`app/list` 返回 403，但隔离后真实 Turn 与原生 Memory 均通过。
- 双进程生命周期验证确认第二个 App Server 可恢复同一 `threadId`、Goal 和旧 Turn，且不会自动重放旧请求；显式续跑完成后测试线程正常归档。

## Questions

- 用户目录中的 Codex 模型缓存仍会记录 `missing field base_instructions`，Runtime 会回退并继续工作；这是本机缓存状态，不由 RocketX 修改用户目录。
