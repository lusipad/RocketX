---
name: evening-review
description: 晚间回顾：当用户问“今天还欠什么”或要求晚间复盘时，综合消息、任务与交付状态；涉及 Azure DevOps 时组合使用 azure-devops-server Skill。
---

晚间回顾

目标是回答“今天欠什么”，不猜测未查询到的事项。

1. 调用 `list_mentions` 时设置 `unprocessedOnly: true`，再调用 `list_todos`；调用 `list_calendar` 时把当前日期同时作为 `from` 和 `to`，找出今天没回应、没完成或已过时的事。若 @ 收件箱的 `coverage.complete=false` 或有 `warnings`，明确说明只拿到部分快照。
2. 涉及 Azure DevOps 时同时使用 `azure-devops-server` Skill，并只通过 `rocketx_azure_devops_server_read` 实时查询仍在进行、待评审、失败或阻塞交付的项。UI 工作台只供用户确定性操作，不能作为本 Skill 的数据源。
3. 项目范围会改变结论且用户没有说明时，只问一个范围问题；用户要求全部项目时由 `azure-devops-server` Skill 枚举项目，并明确覆盖与失败项。
4. 如 Codex Memory 已提供稳定偏好、alias 或已确认承诺，可用它调整回顾方式；不要把动态工作数据当作长期事实。
5. 输出 **未回应**、**未完成**、**交付风险** 三段；每条给出顺延、完成、放弃或明日首先处理之一的明确建议。某个数据源失败时单独说明，不把失败当作“没有事项”。
