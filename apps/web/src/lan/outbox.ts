import type { RcMessage, RcUser } from '@rcx/rc-client';
import { getServerBase, rest } from '../lib/client';
import { useAuth } from '../stores/auth';

export interface LanOutboxEntry {
  version: 1;
  scope: string;
  messageId: string;
  roomId: string;
  text: string;
  originalTs: number;
  author: Pick<RcUser, '_id' | 'username' | 'name'>;
  direction: 'outgoing' | 'incoming';
  status: 'lan-delivered' | 'received' | 'syncing' | 'synced';
  updatedAt: number;
}

const entries = new Map<string, LanOutboxEntry>();
let customFieldsSupported: boolean | undefined;
const RETAIN_SYNCED_MS = 30 * 24 * 60 * 60 * 1000;

export function lanOutboxCapability(): 'unknown' | 'server-metadata' | 'local-only' {
  if (customFieldsSupported === true) return 'server-metadata';
  if (customFieldsSupported === false) return 'local-only';
  return 'unknown';
}

async function store() {
  return (await import('../kernel/store')).kernelStore;
}

function currentScope(): string {
  const userId = useAuth.getState().user?._id ?? 'guest';
  return `${getServerBase() || 'same-origin'}\0${userId}`;
}

function storeId(scope: string, messageId: string): string {
  return `lan:${encodeURIComponent(scope)}:${messageId}`;
}

export function isLanOutboxEntry(value: unknown): value is LanOutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LanOutboxEntry>;
  return (
    entry.version === 1 &&
    typeof entry.scope === 'string' &&
    typeof entry.messageId === 'string' &&
    !!entry.messageId &&
    typeof entry.roomId === 'string' &&
    !!entry.roomId &&
    typeof entry.text === 'string' &&
    typeof entry.originalTs === 'number' &&
    Number.isFinite(entry.originalTs) &&
    !!entry.author?._id &&
    !!entry.author.username &&
    ['outgoing', 'incoming'].includes(entry.direction ?? '') &&
    ['lan-delivered', 'received', 'syncing', 'synced'].includes(entry.status ?? '') &&
    typeof entry.updatedAt === 'number'
  );
}

async function persist(entry: LanOutboxEntry): Promise<void> {
  entries.set(entry.messageId, entry);
  await (await store()).outbox.set(storeId(entry.scope, entry.messageId), entry);
}

export async function hydrateLanOutbox(): Promise<RcMessage[]> {
  entries.clear();
  customFieldsSupported = undefined;
  const scope = currentScope();
  const cutoff = Date.now() - RETAIN_SYNCED_MS;
  const outbox = (await store()).outbox;
  for (const { id, value } of await outbox.list<unknown>()) {
    if (!isLanOutboxEntry(value)) continue;
    if (value.scope !== scope) continue;
    if (value.status === 'synced' && value.updatedAt < cutoff) {
      await outbox.delete(id);
      continue;
    }
    entries.set(value.messageId, value);
  }
  return [...entries.values()]
    .filter((entry) => entry.status !== 'synced')
    .sort((left, right) => left.originalTs - right.originalTs)
    .map(entryToMessage);
}

function entryToMessage(entry: LanOutboxEntry): RcMessage {
  return {
    _id: entry.messageId,
    rid: entry.roomId,
    msg: entry.text,
    ts: new Date(entry.originalTs).toISOString(),
    u: entry.author,
    rocketxOriginalTs: entry.originalTs,
    rocketxOffline: entry.status !== 'synced',
  };
}

export async function recordLanOutgoing(
  message: Pick<RcMessage, '_id' | 'rid' | 'msg' | 'u'> & { originalTs: number },
): Promise<void> {
  await persist({
    version: 1,
    scope: currentScope(),
    messageId: message._id,
    roomId: message.rid,
    text: message.msg,
    originalTs: message.originalTs,
    author: message.u,
    direction: 'outgoing',
    status: 'lan-delivered',
    updatedAt: Date.now(),
  });
}

export async function recordLanIncoming(
  message: Pick<RcMessage, '_id' | 'rid' | 'msg' | 'u'> & { originalTs: number },
): Promise<void> {
  await persist({
    version: 1,
    scope: currentScope(),
    messageId: message._id,
    roomId: message.rid,
    text: message.msg,
    originalTs: message.originalTs,
    author: message.u,
    direction: 'incoming',
    status: 'received',
    updatedAt: Date.now(),
  });
}

function customOriginalTs(message: RcMessage): number | undefined {
  const value = message.customFields?.rocketxOriginalTs;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function selectLanReplayEntries(
  values: Iterable<LanOutboxEntry>,
): LanOutboxEntry[] {
  return [...values]
    .filter((entry) => entry.direction === 'outgoing' && entry.status !== 'synced')
    .sort((left, right) => left.originalTs - right.originalTs);
}

export function decorateLanMessage(message: RcMessage): RcMessage {
  const originalTs = customOriginalTs(message) ?? entries.get(message._id)?.originalTs;
  if (originalTs == null) return message;
  const entry = entries.get(message._id);
  if (entry && entry.status !== 'synced') {
    void persist({ ...entry, status: 'synced', updatedAt: Date.now() });
  }
  return {
    ...message,
    rocketxOriginalTs: originalTs,
    rocketxOffline: false,
  };
}

async function sendAndReconcile(entry: LanOutboxEntry): Promise<RcMessage> {
  const message = {
    _id: entry.messageId,
    rid: entry.roomId,
    msg: entry.text,
  };
  try {
    if (customFieldsSupported !== false) {
      try {
        const sent = await rest.sendMessageRaw({
          ...message,
          customFields: {
            rocketxOriginalTs: new Date(entry.originalTs).toISOString(),
            rocketxOffline: true,
          },
        });
        customFieldsSupported = true;
        return sent;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!/custom fields/i.test(detail)) throw error;
        customFieldsSupported = false;
      }
    }
    return await rest.sendMessageRaw(message);
  } catch (error) {
    try {
      const existing = await rest.getMessage(entry.messageId);
      if (existing.rid === entry.roomId) return existing;
    } catch {
      /* 服务端确实没有这条，保留原始发送错误供下次恢复重试 */
    }
    throw error;
  }
}

export async function flushLanOutbox(
  onSynced: (message: RcMessage) => void,
): Promise<number> {
  const pending = selectLanReplayEntries(entries.values());
  let synced = 0;
  for (const entry of pending) {
    await persist({ ...entry, status: 'syncing', updatedAt: Date.now() });
    try {
      const message = decorateLanMessage(await sendAndReconcile(entry));
      const current = entries.get(entry.messageId) ?? entry;
      await persist({ ...current, status: 'synced', updatedAt: Date.now() });
      onSynced(message);
      synced += 1;
    } catch {
      await persist({ ...entry, status: 'lan-delivered', updatedAt: Date.now() });
      break;
    }
  }
  return synced;
}
