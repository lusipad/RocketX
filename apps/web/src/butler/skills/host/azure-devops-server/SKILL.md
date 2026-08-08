---
name: azure-devops-server
description: Azure DevOps Server 查询与受控状态修改：通过 RocketX 业务 MCP 只读查询项目、代码、工作项、构建、Wiki 和测试数据；用户明确要求修改工作项状态时生成 Host 确认卡。
---

Azure DevOps Server 查询与受控状态修改

1. 只调用 `rocketx_azure_devops_server_read`，不要直接执行 PowerShell、命令行或网络请求。
2. 普通读取使用 GET；WIQL 等原 Skill 明确列入安全只读白名单的路由使用 `method: "POST"` 并传 `body`。不得尝试其他 POST，也不得请求 `AllowWrite`。
3. 集合级项目列表使用 `resource: "projects"`；代码仓库和拉取请求使用 `area: "git"`；工作项使用 `area: "wit"`；构建使用 `area: "build"`。
4. 查询未关闭工作项时，先确定项目范围。全部项目先 GET `projects`，再按项目 POST `area: "wit"`、`resource: "wiql"`、`body: { query: "..." }`；WIQL 必须使用用户要求的范围，不要默认加 `@Me`。
5. 用户要求明细时，从 WIQL 结果取得 ID，再 GET `resource: "workitems"` 并通过 `query` 传入 ID 和所需字段。所有结论只基于工具返回值，覆盖不完整时明确说明。
6. 不请求写操作，不索取或输出凭据；工具报告能力、版本或认证不足时，明确说明缺失条件。
7. 用户明确要求“把 #123 改成已解决”这类状态修改时，调用 `draft_ado_state` 生成 RocketX Host 确认卡；确认前不声称已修改，也绝不通过只读 MCP 发送 PATCH。
