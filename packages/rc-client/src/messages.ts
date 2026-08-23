import { tsMs } from './types';
import type { RcMessage, RcMessageAttachment, RcSlashCommand, RcUser, RcDate, RoomType } from './types';
import { RcApiError, type RcRestEndpointContext } from './request';

export interface RocketChatMessagesDomain {
  getHistory(rid: string, type: RoomType, count?: number, latest?: string): Promise<RcMessage[]>;
  getThreadMessages(tmid: string, count?: number): Promise<RcMessage[]>;
  sendMessage(rid: string, msg: string, tmid?: string): Promise<RcMessage>;
  sendMessageRaw(message: { _id?: string; rid: string; msg?: string; tmid?: string }): Promise<RcMessage>;
  getMessage(msgId: string): Promise<RcMessage>;
  updateMessage(rid: string, msgId: string, text: string): Promise<RcMessage>;
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

export async function updateMessage(context: RcRestEndpointContext, rid: string, msgId: string, text: string): Promise<RcMessage> {
  const response = await context.request<{ message: RcMessage }>('POST', 'chat.update', { roomId: rid, msgId, text });
  return response.message;
}

export async function deleteMessage(context: RcRestEndpointContext, rid: string, msgId: string): Promise<void> {
  const response = await context.request<{ success?: boolean }>('POST', 'chat.delete', { roomId: rid, msgId, asUser: true });
  if (response?.success !== true) throw new RcApiError('服务器未确认消息删除', 502);
}

export async function getThreadMessages(context: RcRestEndpointContext, tmid: string, count = 100): Promise<RcMessage[]> {
  const response = await context.request<{ messages: RcMessage[] }>('GET', 'chat.getThreadMessages', undefined, { tmid, count });
  const messages = response.messages ?? [];
  messages.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  return messages;
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
