import Fastify from 'fastify';
import { RcRestClient } from '@rcx/rc-client';
import { transformAdoEvent, type AdoEvent } from './transform';

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

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true }));

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
