import type { RcMessage, RoomType } from './types';

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
