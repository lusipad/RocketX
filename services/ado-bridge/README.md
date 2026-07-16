# ado-bridge — Azure DevOps Server 2022 集成服务

两个职责：

1. **事件桥**：接收 ADO Service Hooks（工作项、PR、推送、构建、发布），
   转成飞书风格消息卡片发进 Rocket.Chat 频道；
2. **工作台代理**：为客户端提供工作项、PR、构建、详情与评论接口，
   PAT 保存在服务端，客户端不接触凭据。

## 工作台代理配置

`.env` 里配置 `ADO_BASE_URL`（集合地址，如 `http://ado:8080/tfs/DefaultCollection`）
和 `ADO_PAT`。需授予 Work Items Read & Write、Code Read、Build Read。接口：

- `GET /api/ado/config` → Web 地址与当前 ADO 身份
- `GET /api/ado/workitems?assignedTo=<邮箱或域账号>` → 未关闭工作项及其 `parentId`（不传时使用 `@Me`）
- `GET /api/ado/pullrequests` → 与当前用户相关的 PR
- `GET /api/ado/builds` → 当前用户最近发起的构建
- `GET /api/ado/workitem/:id` → 工作项详情
- `GET /api/ado/pullrequest/:id` → 拉取请求详情（ID 在集合内全局查询）
- `GET /api/ado/build/:id?project=<项目>` → 指定项目的构建详情
- `POST /api/ado/workitem/:id/comment` → 添加工作项评论

本地联调可用 mock：`node mock/mock-ado.mjs`（端口 8378），
然后 `ADO_BASE_URL=http://localhost:8378/DefaultCollection ADO_PAT=mock` 启动本服务。

## 准备机器人账号

1. 在 Rocket.Chat 管理后台创建一个专用账号（如 `devops-bot`），加入目标频道；
2. 用该账号登录 → 我的账户 → 个人访问令牌 → 生成（勾选「忽略双重验证」）；
3. 把得到的 `userId` 和 `token` 填入 `.env`（参考 `.env.example`）。

## 启动

```bash
cp .env.example .env   # 填好 RC_AUTH_TOKEN / RC_USER_ID
pnpm --filter @rcx/ado-bridge dev
```

## 在 Azure DevOps Server 2022 上配置

对每个想要通知的项目：

1. 项目设置 → Service hooks → `+`（创建订阅）；
2. 服务选择 **Web Hooks**；
3. 触发事件按需选择：工作项已创建/已更新、拉取请求已创建/已更新、代码已推送、生成完成 等；
4. URL 填：

   ```
   http://<桥接服务地址>:8377/webhooks/ado?channel=devops&token=<WEBHOOK_TOKEN>
   ```

   - `channel`：目标频道名（不带 #），也可以是 `@用户名` 私聊；
   - `token`：与 `.env` 中 `WEBHOOK_TOKEN` 一致；
5. 其余保持默认，测试（Test）应返回 200。

不同事件可以建多个订阅、投递到不同频道，比如构建结果进 `#ci`，工作项变更进 `#sprint`。

## 支持的事件

已识别并配色的事件：`workitem.created/updated/commented/deleted/restored`、
`git.push`、`git.pullrequest.created/updated/merged`、PR 评论、`build.complete`
（失败自动红色）、发布/部署事件。未识别的事件类型也会用 ADO 自带的消息文本兜底投递。
