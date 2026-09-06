import { tsMs } from './types';
import type { RcMessage, RcMessageAttachment, RcSlashCommand, RcUser, RcDate, RoomType } from './types';
import { RcApiError, type RcRestEndpointContext } from './request';

export interface RocketChatMessagesDomain {
  getHistory(rid: string, type: RoomType, count?: number, latest?: string): Promise<RcMessage[]>;
  getThreadMessages(tmid: string, count?: number): Promise<RcMessage[]>;
  sendMessage(rid: string, msg: string, tmid?: string): Promise<RcMessage>;
  sendMessageRaw(message: { _id?: string; rid: string; msg?: string; tmid?: string }): Promise<RcMessage>;
  getMessage(msgId: string): Promise<RcMessage>;
  updateMessage(rid: string, msgId: string, text: string, attachments?: RcMessageAttachment[]): Promise<RcMessage>;
  deleteMessage(rid: string, msgId: string): Promise<void>;
  react(messageId: string, emoji: string, shouldReact?: boolean): Promise<unknown>;
}

export type RocketChatMessagesSource = Partial<RocketChatMessagesDomain>;

export async function getHistory(
  context: RcRestEndpointContext,
  rid: string,
  type: RoomType,
  count = 50,
  latest?: string,
): Promise<RcMessage[]> {
  const endpoint = type === 'c' ? 'channels.history' : type === 'p' ? 'groups.history' : 'im.history';
  const response = await context.request<{ messages: RcMessage[] }>('GET', endpoint, undefined, {
    roomId: rid,
    count,
    latest,
  });
  return (response.messages ?? []).reverse();
}

export async function sendMessage(context: RcRestEndpointContext, rid: string, msg: string, tmid?: string): Promise<RcMessage> {
  const response = await context.request<{ message: RcMessage }>('POST', 'chat.sendMessage', {
    message: { rid, msg, ...(tmid ? { tmid } : {}) },
  });
  return response.message;
}

export async function listCommands(context: RcRestEndpointContext): Promise<RcSlashCommand[]> {
  const response = await context.request<{ commands: RcSlashCommand[] }>('GET', 'commands.list', undefined, { count: 100 });
  return response.commands ?? [];
}

export async function runCommand(
  context: RcRestEndpointContext,
  command: string,
  rid: string,
  params = '',
  tmid?: string,
): Promise<void> {
  await context.request('POST', 'commands.run', { command, roomId: rid, params, ...(tmid ? { tmid } : {}) });
}

export async function sendMessageRaw(
  context: RcRestEndpointContext,
  message: {
    _id?: string;
    rid: string;
    msg?: string;
    attachments?: RcMessageAttachment[];
    tmid?: string;
    customFields?: Record<string, unknown>;
  },
): Promise<RcMessage> {
  const response = await context.request<{ message: RcMessage }>('POST', 'chat.sendMessage', { message });
  return response.message;
}

export async function getMessage(context: RcRestEndpointContext, msgId: string): Promise<RcMessage> {
  const response = await context.request<{ message: RcMessage }>('GET', 'chat.getMessage', undefined, { msgId });
  return response.message;
}

export function postMessage(
  context: RcRestEndpointContext,
  params: { channel?: string; roomId?: string; text?: string; alias?: string; avatar?: string; attachments?: RcMessageAttachment[] },
): Promise<unknown> {
  return context.request('POST', 'chat.postMessage', params);
}

export function react(context: RcRestEndpointContext, messageId: string, emoji: string, shouldReact?: boolean): Promise<unknown> {
  return context.request('POST', 'chat.react', { messageId, emoji, shouldReact });
}

/**
 * 编辑消息。
 *
 * **注意**：`chat.update` 对 attachments 做严格 schema 校验（RC 8.6.1 实测），
 * 自定义字段会被整条拒收（Ajv oneOf 报错）。想给消息附加自定义状态
 * （投票结束、看板列变更等）用表情回应或追加事件消息，别走这里改附件。
 */
export async function updateMessage(
  context: RcRestEndpointContext,
  rid: string,
  msgId: string,
  text: string,
  attachments?: RcMessageAttachment[],
): Promise<RcMessage> {
  const response = await context.request<{ message: RcMessage }>('POST', 'chat.update', {
    roomId: rid,
    msgId,
    text,
    ...(attachments ? { attachments } : {}),
  });
  return response.message;
}

export async function deleteMessage(context: RcRestEndpointContext, rid: string, msgId: string): Promise<void> {
  const response = await context.request<{ success?: boolean }>('POST', 'chat.delete', { roomId: rid, msgId, asUser: true });
  if (response?.success !== true) throw new RcApiError('服务器未确认消息删除', 502);
}

/**
 * 拉取话题全部回复，自动翻页直到拉完。
 *
 * 单页拉取会静默截断：看板/值班表把事件流存在话题里，话题只增不减，
 * 超过一页（默认 100 条）就会丢事件。按 _id 去重 + 短页即停，与服务端 total 对账。
 */
export async function getThreadMessages(
  context: RcRestEndpointContext,
  tmid: string,
  count = 100,
): Promise<RcMessage[]> {
  const pageSize = Math.min(Math.max(count, 1), 100);
  const collected = new Map<string, RcMessage>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const response = await context.request<{ messages?: RcMessage[]; total?: number }>(
      'GET',
      'chat.getThreadMessages',
      undefined,
      { tmid, count: pageSize, offset },
    );
    const messages = response.messages ?? [];
    // 只收首次出现的记录：翻页边界抖动可能让同一条消息重复出现，保留首次的时间戳
    for (const message of messages) {
      if (!collected.has(message._id)) collected.set(message._id, message);
    }
    if (messages.length < pageSize) break;
    offset += messages.length;
    if (response.total !== undefined && collected.size >= response.total) break;
  }
  const list = [...collected.values()];
  list.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  return list;
}

/**
 * 组装 RC 官方消息永久链接。
 *
 * c/p 用频道名（channel/<name>、group/<name>），DM 用 rid（direct/<rid>——
 * DM 的房间文档没有 name，名字只在订阅上）。c/p 拿不到 name 时返回空串，
 * 调用方据此放弃给链接（好过给死链）。siteUrl 必须与服务端 Site_Url 精确一致，
 * 否则引用回复不会被服务端展开。
 */
export function buildMessagePermalink(
  siteUrl: string,
  roomType: string,
  roomNameOrId: string,
  messageId: string,
): string {
  const base = siteUrl.replace(/\/+$/, '');
  if (roomType === 'c' || roomType === 'p') {
    if (!roomNameOrId) return '';
    return `${base}/${roomType === 'c' ? 'channel' : 'group'}/${roomNameOrId}?msg=${messageId}`;
  }
  if (roomType === 'd') return `${base}/direct/${roomNameOrId}?msg=${messageId}`;
  return '';
}

export function followMessage(context: RcRestEndpointContext, mid: string): Promise<unknown> {
  return context.request('POST', 'chat.followMessage', { mid });
}

export function unfollowMessage(context: RcRestEndpointContext, mid: string): Promise<unknown> {
  return context.request('POST', 'chat.unfollowMessage', { mid });
}

export function starMessage(context: RcRestEndpointContext, messageId: string): Promise<unknown> {
  return context.request('POST', 'chat.starMessage', { messageId });
}

export function unstarMessage(context: RcRestEndpointContext, messageId: string): Promise<unknown> {
  return context.request('POST', 'chat.unStarMessage', { messageId });
}

export async function getStarredMessages(context: RcRestEndpointContext, rid: string, count = 50): Promise<RcMessage[]> {
  const response = await context.request<{ messages: RcMessage[] }>('GET', 'chat.getStarredMessages', undefined, { roomId: rid, count });
  return response.messages ?? [];
}

export function pinMessage(context: RcRestEndpointContext, messageId: string): Promise<unknown> {
  return context.request('POST', 'chat.pinMessage', { messageId });
}

export function unpinMessage(context: RcRestEndpointContext, messageId: string): Promise<unknown> {
  return context.request('POST', 'chat.unPinMessage', { messageId });
}

export async function getPinnedMessages(context: RcRestEndpointContext, rid: string, count = 50): Promise<RcMessage[]> {
  const response = await context.request<{ messages: RcMessage[] }>('GET', 'chat.getPinnedMessages', undefined, { roomId: rid, count });
  return response.messages ?? [];
}

export async function getReadReceipts(context: RcRestEndpointContext, messageId: string): Promise<{ user: RcUser; ts: RcDate }[]> {
  const response = await context.request<{ receipts: { user: RcUser; ts: RcDate }[] }>(
    'GET',
    'chat.getMessageReadReceipts',
    undefined,
    { messageId },
  );
  return response.receipts ?? [];
}

function required<K extends keyof RocketChatMessagesDomain>(source: RocketChatMessagesSource, key: K): NonNullable<RocketChatMessagesDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat messages domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatMessagesDomain[K]>;
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} 不能为空`);
  return value;
}

export function createRocketChatMessagesDomain(source: RocketChatMessagesSource): RocketChatMessagesDomain {
  return {
    getHistory: (rid, type, count, latest) => required(source, 'getHistory')(requireText(rid, 'roomId'), type, Math.max(1, count ?? 50), latest),
    getThreadMessages: (tmid, count) => required(source, 'getThreadMessages')(requireText(tmid, 'threadId'), Math.max(1, count ?? 100)),
    sendMessage: (rid, msg, tmid) => required(source, 'sendMessage')(requireText(rid, 'roomId'), msg, tmid),
    sendMessageRaw: (message) => required(source, 'sendMessageRaw')({ ...message, rid: requireText(message.rid, 'roomId') }),
    getMessage: (msgId) => required(source, 'getMessage')(requireText(msgId, 'messageId')),
    updateMessage: (rid, msgId, text) => required(source, 'updateMessage')(requireText(rid, 'roomId'), requireText(msgId, 'messageId'), text),
    deleteMessage: (rid, msgId) => required(source, 'deleteMessage')(requireText(rid, 'roomId'), requireText(msgId, 'messageId')),
    react: (messageId, emoji, shouldReact) => required(source, 'react')(requireText(messageId, 'messageId'), requireText(emoji, 'emoji'), shouldReact),
  };
}
