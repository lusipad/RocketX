import type { RcMessage, RcRoom, RcUser } from './types';
import type { RcRestEndpointContext } from './request';

export interface RocketChatSearchDomain {
  directory(type: 'users' | 'channels', text?: string, count?: number, offset?: number): Promise<{ result: (RcUser & RcRoom)[]; total: number }>;
  spotlight(query: string): Promise<{ users: RcUser[]; rooms: RcRoom[] }>;
  searchMessages(rid: string, searchText: string, count?: number, offset?: number): Promise<RcMessage[]>;
  getMentionedMessages(rid: string, count?: number): Promise<RcMessage[]>;
}

export type RocketChatSearchSource = Partial<RocketChatSearchDomain>;

function wrapCjkAsRegex(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const hasCjk = /[一-鿿぀-ヿ가-힯]/.test(trimmed);
  const alreadyRegex = /^\/.*\/$/.test(trimmed);
  if (!hasCjk || alreadyRegex) return text;
  return `/${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`;
}

export async function directory(
  context: RcRestEndpointContext,
  type: 'users' | 'channels',
  text = '',
  count = 50,
  offset = 0,
): Promise<{ result: (RcUser & RcRoom)[]; total: number }> {
  const response = await context.request<{ result: (RcUser & RcRoom)[]; total: number }>('GET', 'directory', undefined, {
    text,
    type,
    count,
    offset,
    sort: '{"username":1}',
  });
  return { result: response.result ?? [], total: response.total ?? 0 };
}

export function spotlight(context: RcRestEndpointContext, query: string): Promise<{ users: RcUser[]; rooms: RcRoom[] }> {
  return context.request('GET', 'spotlight', undefined, { query });
}

export async function searchMessages(
  context: RcRestEndpointContext,
  rid: string,
  searchText: string,
  count = 30,
  offset = 0,
): Promise<RcMessage[]> {
  const response = await context.request<{ messages: RcMessage[] }>('GET', 'chat.search', undefined, {
    roomId: rid,
    searchText: wrapCjkAsRegex(searchText),
    count,
    offset,
  });
  return response.messages ?? [];
}

export async function getMentionedMessagesPage(
  context: RcRestEndpointContext,
  rid: string,
  offset = 0,
  count = 50,
): Promise<{ messages: RcMessage[]; count: number; offset: number; total: number }> {
  const response = await context.request<{
    messages: RcMessage[];
    count?: number;
    offset?: number;
    total?: number;
  }>('GET', 'chat.getMentionedMessages', undefined, {
    roomId: rid,
    offset,
    count,
    sort: JSON.stringify({ ts: -1 }),
  });
  const messages = response.messages ?? [];
  return {
    messages,
    count: response.count ?? messages.length,
    offset: response.offset ?? offset,
    total: response.total ?? offset + messages.length,
  };
}

export async function getMentionedMessages(context: RcRestEndpointContext, rid: string, count = 50): Promise<RcMessage[]> {
  return (await getMentionedMessagesPage(context, rid, 0, count)).messages;
}

function required<K extends keyof RocketChatSearchDomain>(source: RocketChatSearchSource, key: K): NonNullable<RocketChatSearchDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat search domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatSearchDomain[K]>;
}

export function createRocketChatSearchDomain(source: RocketChatSearchSource): RocketChatSearchDomain {
  return {
    directory: (type, text, count, offset) => required(source, 'directory')(type, text ?? '', Math.max(1, count ?? 50), Math.max(0, offset ?? 0)),
    spotlight: (query) => required(source, 'spotlight')(query),
    searchMessages: (rid, searchText, count, offset) => required(source, 'searchMessages')(rid, searchText, Math.max(1, count ?? 30), Math.max(0, offset ?? 0)),
    getMentionedMessages: (rid, count) => required(source, 'getMentionedMessages')(rid, Math.max(1, count ?? 50)),
  };
}
