# ado-bridge — Azure DevOps Server 2022 通知入口

这个服务现在只做一件事：

- 接收 ADO Service Hooks（工作项、PR、推送、构建、发布等）
- 转成 Rocket.Chat 消息
- 投递到指定频道或私聊

它不再提供任何 `/api/ado/*` 查询代理，也不再保存 ADO 查询凭据。

## 准备机器人账号

1. 在 Rocket.Chat 管理后台创建一个专用账号（如 `devops-bot`），加入目标频道；
2. 用该账号登录 → 我的账户 → 个人访问令牌 → 生成；
3. 把得到的 `userId` 和 `token` 填入 `.env`（参考 `.env.example`）。

## 启动

```bash
cp .env.example .env
pnpm --filter @rcx/ado-bridge dev
```

## 环境变量

- `RC_BASE_URL`：Rocket.Chat 地址
- `RC_AUTH_TOKEN` / `RC_USER_ID`：机器人账号凭据
- `DEFAULT_CHANNEL`：webhook URL 未指定频道时的默认目标
- `WEBHOOK_TOKEN`：ADO 回调校验令牌；留空表示不校验
- `RC_ALIAS`：消息别名，需要 `message-impersonate` 权限
- `PORT`：监听端口

## Azure DevOps Server 2022 配置

项目设置 → Service hooks → 新建 **Web Hooks** 订阅，URL 填：

```text
http://<bridge>:8377/webhooks/ado?channel=devops&token=<WEBHOOK_TOKEN>
```

- `channel` 可填频道名（不带 `#`）或 `@用户名`
- `token` 需与服务端 `WEBHOOK_TOKEN` 一致

可以按事件类型拆多个订阅，分别投递到不同频道。

## 保留接口

- `GET /healthz`
- `POST /webhooks/ado`

## 支持的事件

已识别并配色的事件包括：

- `workitem.created`
- `workitem.updated`
- `workitem.commented`
- `workitem.deleted`
- `workitem.restored`
- `git.push`
- `git.pullrequest.created`
- `git.pullrequest.updated`
- `git.pullrequest.merged`
- `ms.vss-code.git-pullrequest-comment-event`
- `build.complete`
- `ms.vss-release.release-created-event`
- `ms.vss-release.deployment-completed-event`

未识别事件也会回退到 ADO 自带消息文本进行投递。
