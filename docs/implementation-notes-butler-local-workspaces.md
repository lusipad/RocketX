# Implementation notes — 管家本地工作区配置

> 文档状态：**历史实施记录**。当前工作区选择、共享 Agent 环境与权限边界分别见[管家任务](specs/butler-tasks.md)、[聊天 AI 托管与委托](specs/delegation-and-shared-agent.md)和[权限与审批](specs/approvals-and-permissions.md)。

Plan: 当前 Codex 任务计划

## Summary

目标是让用户在“设置 → 工作区”里直接添加、查看和管理管家派活使用的本地目录，并通过真实桌面任务验证目录选择、白名单持久化和只读派发链路。

## Decisions

- 复用 `agentEnvironments` 作为唯一的本地工作区白名单，不新增第二套目录状态。
- 复用现有系统目录选择器；模型提供的 `workspaceHint` 仍只参与已注册目录排序，不能授权任意路径。
- 将现有本地目录管理组件从“AI”设置移到“工作区”设置；团队 `rcx.workspace.json` 导入继续保留为同页的独立配置组。
- 回归验证覆盖正确的信息架构、系统目录选择、localStorage 持久化和现有派发白名单测试。

## Deviations

- 不把团队配置文件扩展为本地绝对路径分发机制。本地路径是设备私有信息，也不应由团队配置远程授权。
- 不增加手工路径文本框；目录必须经桌面系统选择器添加。

## Surprises

- 本地目录管理和派发白名单已经完整存在，但入口一直放在“设置 → AI”；任务卡只提示去“设置”，而“设置 → 工作区”只显示团队配置导入，造成首用链路断裂。

## Questions for review

- 无。
