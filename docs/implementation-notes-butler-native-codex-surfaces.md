# Implementation notes — 管家采用 Codex 交互并支持双向切换

> 文档状态：**历史实施记录**。本文说明该切片如何落地，不承担当前功能合同；现状见[管家任务](specs/butler-tasks.md)。

Plan: `docs/butler-native-codex-surfaces-plan.md`

## Summary

已完成 RocketX 内嵌任务、已安排、插件三个工作面，并实现与 Codex App 的同线程切换和回切恢复。

## Decisions

- 主导航中的“已安排 / 插件”是 RocketX 内嵌页面；外部 Codex 只作为明确的次要切换动作。
- 当前任务已有 resident Codex thread id 时，优先按 thread id 打开同一任务。
- 成功切到 Codex App 后释放 RocketX 的 app-server 客户端；回到 RocketX 的下一问先 `thread/resume` 同一线程，重新装载另一端新增的上下文。
- 没有可复用线程或打开失败时，才把完整记录和工作区带入 Codex 新任务。
- 内嵌插件页只调用稳定的 `skills/list` / `skills/config/write`；实验性插件市场协议不进入生产 UI。

## Deviations

- 原计划把管理入口全部做成 Codex deep link；用户澄清 UI 必须留在 RocketX，因此撤回 surface 外跳，只保留任务交接。

## Surprises

- 桌面 URL 闸门需要同时区分既有线程、新任务和少量精确管理页面；当前只放行这些 Codex deep link，其他 scheme/path/query 继续拒绝。
- Codex App Server 的 Plugin 管理方法仍标记为 under development，官方要求生产客户端不要调用。
- Codex App Server 当前没有 Scheduled CRUD；原生管理必须通过 Codex App surface 完成。
- OpenAI Docs 明确 App Server 用于在第三方产品内嵌任务历史、审批与流式事件，支持当前内嵌方向。
- 真正双向接续不能只打开同一 thread；RocketX 必须释放本地客户端，并在回切后显式 resume。

## Verification

- `pnpm test:regression`：983 / 983 通过。
- `pnpm test:ui`：87 / 87 通过，覆盖任务、已安排、插件及三类 Codex deep link。
- `pnpm typecheck` 与 `pnpm --filter @rcx/web build` 通过。
- 真实 Codex 0.144.4 生命周期冒烟通过：中断本地客户端后，以同一 thread id 恢复，保留旧轮次并继续新轮次。
- 已安排真实新建、启停、立即运行及最近结果流程通过；插件读取与开关流程通过，并断言未请求 `plugin/list`。
- 桌面 deep link 白名单 Rust 测试通过；视觉门禁 94 / 100，通过。

## Questions for review

- Codex App Server 提供稳定 Scheduled CRUD 后，再单独决定旧 RocketX routines 的迁移或导出；本轮不删除数据。
