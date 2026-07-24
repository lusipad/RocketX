import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { RcRestClient, type RcMessageAttachment } from '@rcx/rc-client';
import { transformAdoEvent, type AdoEvent } from './transform';

export interface BridgeEnv {
  rcBaseUrl?: string;
  rcAuthToken: string;
  rcUserId: string;
  defaultChannel?: string;
  webhookToken?: string;
  port?: string;
  rcAlias?: string;
}

export interface PostMessagePayload {
  channel: string;
  text: string;
  alias?: string;
  attachments: RcMessageAttachment[];
}

export interface BridgeOptions {
  env: BridgeEnv;
  postMessage: (payload: PostMessagePayload) => Promise<unknown>;
}

function normalizeChannel(channel: string): string {
  return channel.startsWith('#') || channel.startsWith('@') ? channel : `#${channel}`;
}

export function buildApp({ env, postMessage }: BridgeOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const defaultChannel = env.defaultChannel || 'devops';
  const alias = env.rcAlias?.trim();

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
    if (env.webhookToken && req.query.token !== env.webhookToken) {
      return reply.code(401).send({ error: 'invalid token' });
    }

    const card = transformAdoEvent(req.body ?? {});
    if (!card) {
      return reply.code(204).send();
    }

    const channel = normalizeChannel(req.query.channel || defaultChannel);
    await postMessage({
      channel,
      text: card.text,
      ...(alias ? { alias } : {}),
      attachments: card.attachments,
    });

    return { ok: true };
  });

  return app;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): BridgeEnv {
  return {
    rcBaseUrl: source.RC_BASE_URL || 'http://localhost:3000',
    rcAuthToken: source.RC_AUTH_TOKEN ?? '',
    rcUserId: source.RC_USER_ID ?? '',
    defaultChannel: source.DEFAULT_CHANNEL || 'devops',
    webhookToken: source.WEBHOOK_TOKEN ?? '',
    port: source.PORT || '8377',
    rcAlias: source.RC_ALIAS ?? '',
  };
}

export function createRocketChatPoster(env: BridgeEnv): (payload: PostMessagePayload) => Promise<unknown> {
  const rest = new RcRestClient({ baseUrl: env.rcBaseUrl });
  rest.setAuth(env.rcAuthToken, env.rcUserId);
  return async (payload) => await rest.postMessage(payload);
}

export async function startServer(env: BridgeEnv = readEnv()): Promise<FastifyInstance> {
  if (!env.rcAuthToken || !env.rcUserId) {
    console.error(
      '缺少 RC_AUTH_TOKEN / RC_USER_ID 环境变量。\n' +
        '请在 Rocket.Chat 中创建机器人账号，然后在「我的账户 → 个人访问令牌」生成 token。',
    );
    process.exit(1);
  }

  const app = buildApp({ env, postMessage: createRocketChatPoster(env) });
  const port = Number(env.port || '8377');
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`ado-bridge 已启动: http://0.0.0.0:${port}`);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
