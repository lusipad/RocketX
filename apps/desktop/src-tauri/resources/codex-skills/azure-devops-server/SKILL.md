---
name: azure-devops-server
description: Use when a RocketX Codex task needs to query Azure DevOps Server projects, iterations, work items, pull requests, builds, tests, wikis, or related delivery data through the configured Workbench connection.
---

# Azure DevOps Server

这个 Skill 是 RocketX 中 Azure DevOps Server 查询的唯一 AI 入口。工作台负责连接、凭据和确定性操作；Codex 负责理解用户意图并组合查询。

## 工具边界

- 只调用 `rocketx_azure_devops_server_read` 读取实时数据。
- 不要直接执行 PowerShell、命令行或网络请求（包括 `curl`）。
- 不要要求用户在对话中提供集合地址、PAT 或 Windows 凭据；工具会使用工作台当前连接。
- 不要把工作台快照、聊天历史中的旧数字或模型猜测当成实时结果。
- 当前工具是只读的。用户要求修改工作项、调整迭代或安排任务时，先读取并核对目标，再明确说明需要在工作台完成确定性写入，不要伪造成功。

## 查询流程

1. 从用户表述中确定项目、团队、迭代、工作项、PR 或时间范围；缺少会改变查询结果的关键条件时再询问。
2. 使用最窄的资源和查询条件调用 `rocketx_azure_devops_server_read`。
3. 需要跨页统计时持续读取，直到覆盖完整；不能完整覆盖时明确写出范围和缺口。
4. 需要详情时使用前一步返回的真实 ID 继续读取，不猜测 ID、项目名、状态或数量。
5. 回答中给出结论、必要明细和工具返回的可引用链接；没有链接时如实说明。

## 常用资源

- 项目：`resource=projects`
- WIQL：`method=POST`、`area=wit`、`resource=wiql`，在 `body.query` 中提供 WIQL
- 工作项详情：`area=wit`、`resource=workitems/{id}`
- 团队迭代：`area=work`、`resource=teamsettings/iterations`
- 仓库与 PR：`area=git`
- 构建：`area=build`
- 测试、Wiki、发布和搜索：使用工具 schema 允许的对应 area；条件能力失败时直接报告服务端限制

把工具错误翻译成用户可执行的说明，但保留关键错误码或错误摘要，不用臆测结果补齐失败的数据。
