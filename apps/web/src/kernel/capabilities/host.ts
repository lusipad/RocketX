import type { RcMessage, RcMessageAttachment } from '@rcx/rc-client';
import type { CapabilityBus } from './bus';
import type { KernelHost } from '../host';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface HostCapabilityOptions {
  serverBase?: () => string;
  now?: () => number;
  createMessageId?: () => string;
}

function stringParam(params: unknown, key: string, fallback = ''): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : fallback;
}

function plainMessage(message: RcMessage): RcMessage {
  return structuredClone(message);
}

export function isCurrentServerFilePath(path: string, serverBase: string): boolean {
  return path.startsWith('/') || (!!serverBase && path.startsWith(`${serverBase}/`));
}

function encodeBlob(blob: Blob): Promise<{ type: string; size: number; base64: string }> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { type: blob.type, size: blob.size, base64: btoa(binary) };
  });
}

/**
 * Register capabilities whose data and side effects are supplied by narrow
 * host ports. Permission checks remain in CapabilityBus; scope checks stay
 * here so every host implementation receives the same boundary behavior.
 */
export function registerHostCapabilities(
  capabilityBus: CapabilityBus,
  host: KernelHost,
  options: HostCapabilityOptions = {},
): Array<() => void> {
  const serverBase = options.serverBase ?? (() => '');
  const cleanups: Array<() => void> = [];

  cleanups.push(
    capabilityBus.register('chat.current', 'chat:read', () => {
      const current = host.chat.current();
      return {
        rid: current.rid,
        messages: current.messages.map(plainMessage),
      };
    }),
  );
  cleanups.push(
    capabilityBus.register('chat.history', 'chat:history', (params) => {
      const current = host.chat.current();
      const rid = stringParam(params, 'rid', current.rid ?? '');
      const count = Math.min(200, Math.max(1, Number((params as { count?: unknown } | undefined)?.count) || 50));
      if (!rid || (!host.rooms.isMember(rid) && rid !== current.rid)) throw new Error('无权读取这个会话');
      return host.chat.history(rid, count).map(plainMessage);
    }),
  );
  cleanups.push(
    capabilityBus.register('chat.postMessage', 'chat:write', async (params) => {
      const rid = stringParam(params, 'rid', host.chat.current().rid ?? '');
      const text = stringParam(params, 'text');
      const tmid = stringParam(params, 'tmid') || undefined;
      if (!rid || !host.rooms.isMember(rid)) throw new Error('只能向已加入的会话发送消息');
      if (!text.trim()) throw new Error('消息不能为空');
      return host.chat.postMessage(rid, text, tmid);
    }),
  );
  // 表情回应落在消息所属的房间，宿主不预取 rid，成员校验交给服务端；
  // 这是应用做投票/互动类功能的基础能力，与 chat.postMessage 同属 chat:write
  cleanups.push(
    capabilityBus.register('chat.react', 'chat:write', async (params) => {
      const messageId = stringParam(params, 'messageId');
      const emoji = stringParam(params, 'emoji');
      const shouldReact = (params as { shouldReact?: unknown } | undefined)?.shouldReact;
      if (!messageId || !emoji) throw new Error('chat.react 需要 messageId 和 emoji');
      if (!emoji.startsWith(':') || !emoji.endsWith(':') || emoji.length < 3) {
        throw new Error('emoji 必须是 :name: 短名格式');
      }
      await host.chat.react(messageId, emoji, typeof shouldReact === 'boolean' ? shouldReact : undefined);
      return { ok: true };
    }),
  );
  cleanups.push(
    capabilityBus.register('chat.send', 'chat:write', async (params) => {
      const rid = stringParam(params, 'rid', host.chat.current().rid ?? '');
      const msg = stringParam(params, 'msg');
      const tmid = stringParam(params, 'tmid') || undefined;
      const rawAttachments = (params as { attachments?: unknown } | undefined)?.attachments;
      if (!rid || !host.rooms.isMember(rid)) throw new Error('只能向已加入的会话发送消息');
      if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
        throw new Error('attachments 必须是数组');
      }
      if (!msg.trim() && !Array.isArray(rawAttachments)) throw new Error('消息不能为空');
      if (Array.isArray(rawAttachments) && JSON.stringify(rawAttachments).length > 32_768) {
        throw new Error('附件载荷超出 32 KB 上限');
      }
      const message = await host.chat.send({
        rid,
        ...(msg ? { msg } : {}),
        ...(tmid ? { tmid } : {}),
        ...(Array.isArray(rawAttachments) ? { attachments: rawAttachments as RcMessageAttachment[] } : {}),
      });
      return plainMessage(message);
    }),
  );
  cleanups.push(
    capabilityBus.register('chat.threads', 'chat:history', async (params) => {
      const tmid = stringParam(params, 'tmid');
      if (!tmid) throw new Error('chat.threads 需要 tmid');
      const messages = await host.chat.thread(tmid);
      const rid = messages[0]?.rid;
      if (!rid || !host.rooms.isMember(rid)) throw new Error('只能读取已加入会话的话题');
      return { messages: messages.map(plainMessage) };
    }),
  );
  cleanups.push(
    capabilityBus.register('rooms.list', 'rooms:list', () => host.rooms.list()),
  );
  cleanups.push(
    capabilityBus.register('users.read', 'users:read', (params) => {
      const current = host.chat.current();
      const rid = stringParam(params, 'rid', current.rid ?? '');
      if (!rid || (!host.rooms.isMember(rid) && rid !== current.rid)) throw new Error('只能读取已加入会话的成员');
      return host.users.read(rid);
    }),
  );
  cleanups.push(
    capabilityBus.register('files.list', 'files:read', async (params) => {
      const rid = stringParam(params, 'rid', host.chat.current().rid ?? '');
      const type = host.rooms.typeOf(rid);
      if (!rid || !type) throw new Error('只能读取已加入会话的文件');
      const count = Math.min(200, Math.max(1, Number((params as { count?: unknown } | undefined)?.count) || 50));
      return host.files.list(rid, type, count);
    }),
  );
  cleanups.push(
    capabilityBus.register('files.read', 'files:read', async (params) => {
      const path = stringParam(params, 'path');
      if (!isCurrentServerFilePath(path, serverBase())) {
        throw new Error('只能读取当前 Rocket.Chat 服务器的文件');
      }
      const blob = await host.files.read(path);
      if (blob.size > MAX_FILE_BYTES) throw new Error('Bridge 单次文件读取上限为 10 MB');
      return encodeBlob(blob);
    }),
  );
  cleanups.push(
    capabilityBus.register('lan.peers', 'lan:discover', () => host.lan.listPeers()),
  );
  return cleanups;
}
