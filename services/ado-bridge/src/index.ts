import Fastify from 'fastify';
import cors from '@fastify/cors';
import { RcRestClient } from '@rcx/rc-client';
import { transformAdoEvent, type AdoEvent } from './transform';
import { AdoClient } from './ado';

const {
  RC_BASE_URL = 'http://localhost:3000',
  RC_AUTH_TOKEN,
  RC_USER_ID,
  DEFAULT_CHANNEL = 'devops',
  WEBHOOK_TOKEN,
  PORT = '8377',
  // 消息显示的发送者别名。需要账号具备 message-impersonate 权限（bot 角色默认有），
  // 普通/管理员账号请留空
  RC_ALIAS = '',
  // 工作台查询代理：ADO 集合地址 + 只读 PAT（不配置则工作台接口返回 503）
  ADO_BASE_URL = '',
  ADO_PAT = '',
} = process.env;

if (!RC_AUTH_TOKEN || !RC_USER_ID) {
  console.error(
    '缺少 RC_AUTH_TOKEN / RC_USER_ID 环境变量。\n' +
      '请在 Rocket.Chat 中创建机器人账号，然后在「我的账户 → 个人访问令牌」生成 token。',
  );
  process.exit(1);
}

const rest = new RcRestClient({ baseUrl: RC_BASE_URL });
rest.setAuth(RC_AUTH_TOKEN, RC_USER_ID);

// PAT 可留空：内网 Windows 集成认证场景（由运行服务的账号协商）
const ado = ADO_BASE_URL ? new AdoClient({ baseUrl: ADO_BASE_URL, pat: ADO_PAT }) : null;

const app = Fastify({ logger: true });
// 工作台前端（Web/桌面端）跨域调用
await app.register(cors, { origin: true });

app.get('/healthz', async () => ({ ok: true }));

// ---- 工作台查询代理 ----

/** 客户端需要的 ADO 基本信息（web 链接前缀等） */
app.get('/api/ado/config', async (_req, reply) => {
  if (!ado) return reply.code(503).send({ error: 'ADO_BASE_URL / ADO_PAT 未配置' });
  return { webBase: ado.webBase };
});

app.get<{ Querystring: { assignedTo?: string } }>('/api/ado/workitems', async (req, reply) => {
  if (!ado) return reply.code(503).send({ error: 'ADO_BASE_URL / ADO_PAT 未配置' });
  try {
    return { items: await ado.getWorkItems(req.query.assignedTo) };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'ADO 查询失败' });
  }
});

app.get('/api/ado/pullrequests', async (req, reply) => {
  if (!ado) return reply.code(503).send({ error: 'ADO_BASE_URL / ADO_PAT 未配置' });
  try {
    return { items: await ado.getActivePullRequests() };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'ADO 查询失败' });
  }
});

/** 单工作项详情（聊天 #号 悬停卡片） */
app.get<{ Params: { id: string } }>('/api/ado/workitem/:id', async (req, reply) => {
  if (!ado) return reply.code(503).send({ error: 'ADO_BASE_URL / ADO_PAT 未配置' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '无效的工作项 id' });
  try {
    const item = await ado.getWorkItem(id);
    if (!item) return reply.code(404).send({ error: `工作项 #${id} 不存在` });
    return { item };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'ADO 查询失败' });
  }
});

/** 给工作项添加讨论评论 */
app.post<{ Params: { id: string }; Body: { text?: string; author?: string } }>(
  '/api/ado/workitem/:id/comment',
  async (req, reply) => {
    if (!ado) return reply.code(503).send({ error: 'ADO_BASE_URL / ADO_PAT 未配置' });
    const id = Number(req.params.id);
    const text = req.body?.text?.trim();
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '无效的工作项 id' });
    if (!text) return reply.code(400).send({ error: '评论内容不能为空' });
    try {
      await ado.addWorkItemComment(id, text, req.body?.author);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'ADO 评论失败' });
    }
  },
);

/** 最近构建 */
app.get('/api/ado/builds', async (req, reply) => {
  if (!ado) return reply.code(503).send({ error: 'ADO_BASE_URL / ADO_PAT 未配置' });
  try {
    return { items: await ado.getRecentBuilds() };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'ADO 查询失败' });
  }
});

/**
 * Azure DevOps Server 2022 Service Hooks 入口。
 * 用法：项目设置 → Service hooks → Web Hooks →
 *   URL: http://<bridge>:8377/webhooks/ado?channel=devops&token=<WEBHOOK_TOKEN>
 */
app.post<{
  Querystring: { channel?: string; token?: string };
  Body: AdoEvent;
}>('/webhooks/ado', async (req, reply) => {
  if (WEBHOOK_TOKEN && req.query.token !== WEBHOOK_TOKEN) {
    return reply.code(401).send({ error: 'invalid token' });
  }

  const card = transformAdoEvent(req.body ?? {});
  if (!card) {
    return reply.code(204).send();
  }

  const channel = req.query.channel || DEFAULT_CHANNEL;
  await rest.postMessage({
    channel: channel.startsWith('#') || channel.startsWith('@') ? channel : `#${channel}`,
    text: card.text,
    ...(RC_ALIAS ? { alias: RC_ALIAS } : {}),
    attachments: card.attachments,
  });

  return { ok: true };
});

const port = Number(PORT);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`ado-bridge 已启动: http://0.0.0.0:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
