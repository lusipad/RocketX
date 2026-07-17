import { RcRestClient, tsMs, type RcMessage } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';
const USER2 = process.env.RC_USER2 ?? 'zhangsan';
const TOKEN = process.env.RC_TOKEN;
const UID = process.env.RC_UID;

interface SendMessageResponse {
  message?: RcMessage & { customFields?: Record<string, unknown> };
  error?: string;
  messageText?: string;
}

async function main(): Promise<void> {
  const rest = new RcRestClient({ baseUrl: BASE });
  let authToken = TOKEN;
  let userId = UID;
  if (authToken && userId) {
    rest.setAuth(authToken, userId);
    await rest.me();
  } else {
    const login = await rest.login(USER, PASS);
    authToken = login.authToken;
    userId = login.userId;
  }

  const stamp = Date.now().toString(36);
  const room = await rest.createGroup(`M9回灌契约-${stamp}`, [USER2], false);

  const sendRaw = async (message: Record<string, unknown>): Promise<SendMessageResponse> => {
    const response = await fetch(`${BASE}/api/v1/chat.sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': authToken!,
        'X-User-Id': userId!,
      },
      body: JSON.stringify({ message }),
    });
    const body = (await response.json()) as SendMessageResponse;
    if (!response.ok) {
      throw new Error(body.messageText ?? body.error ?? `HTTP ${response.status}`);
    }
    if (!body.message) throw new Error('chat.sendMessage 未返回 message');
    return body;
  };

  try {
    const idempotentId = `m9idem${stamp}`;
    const first = await sendRaw({ _id: idempotentId, rid: room._id, msg: 'M9 幂等契约探针' });
    let retryAccepted = false;
    let retryError: string | undefined;
    try {
      const second = await sendRaw({ _id: idempotentId, rid: room._id, msg: 'M9 幂等契约探针' });
      retryAccepted = second.message?._id === idempotentId;
    } catch (error) {
      retryError = error instanceof Error ? error.message : String(error);
    }
    const afterRetry = await rest.getHistory(room._id, 'c', 50);
    const idempotentCount = afterRetry.filter((message) => message._id === idempotentId).length;
    const idempotent = first.message?._id === idempotentId && idempotentCount === 1;

    const originalTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const timestampId = `m9time${stamp}`;
    let timestampAccepted = false;
    let timestampReturned: string | undefined;
    let timestampPreserved = false;
    let timestampError: string | undefined;
    try {
      const timestamp = await sendRaw({
        _id: timestampId,
        rid: room._id,
        msg: 'M9 时间戳契约探针',
        ts: originalTs,
      });
      timestampAccepted = true;
      timestampReturned = new Date(tsMs(timestamp.message?.ts)).toISOString();
      timestampPreserved = Math.abs(tsMs(timestamp.message?.ts) - Date.parse(originalTs)) < 1_000;
    } catch (error) {
      timestampError = error instanceof Error ? error.message : String(error);
    }

    const customId = `m9meta${stamp}`;
    let customFieldsAccepted = false;
    let customFieldsPreserved = false;
    let customFieldsError: string | undefined;
    try {
      const custom = await sendRaw({
        _id: customId,
        rid: room._id,
        msg: 'M9 自定义字段契约探针',
        customFields: { rocketxOriginalTs: originalTs, rocketxOffline: true },
      });
      customFieldsAccepted = true;
      customFieldsPreserved =
        custom.message?.customFields?.rocketxOriginalTs === originalTs &&
        custom.message?.customFields?.rocketxOffline === true;
    } catch (error) {
      customFieldsError = error instanceof Error ? error.message : String(error);
    }

    console.log(
      JSON.stringify(
        {
          server: BASE,
          idempotent: {
            acceptedStableId: first.message?._id === idempotentId,
            retryAccepted,
            historyCount: idempotentCount,
            result: idempotent,
            ...(retryError ? { retryError } : {}),
          },
          timestamp: {
            submitted: originalTs,
            accepted: timestampAccepted,
            ...(timestampReturned ? { returned: timestampReturned } : {}),
            preserved: timestampPreserved,
            ...(timestampError ? { error: timestampError } : {}),
          },
          customFields: {
            accepted: customFieldsAccepted,
            preserved: customFieldsPreserved,
            ...(customFieldsError ? { error: customFieldsError } : {}),
          },
        },
        null,
        2,
      ),
    );

    if (!idempotent) throw new Error('当前 Rocket.Chat 实例不满足稳定 _id 幂等契约');
  } finally {
    await rest.deleteRoom(room._id, 'c');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
