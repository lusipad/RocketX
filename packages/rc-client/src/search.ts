import type { RcMessage, RcRoom, RcUser } from './types';

export interface RocketChatSearchDomain {
  directory(type: 'users' | 'channels', text?: string, count?: number, offset?: number): Promise<{ result: (RcUser & RcRoom)[]; total: number }>;
  spotlight(query: string): Promise<{ users: RcUser[]; rooms: RcRoom[] }>;
  searchMessages(rid: string, searchText: string, count?: number, offset?: number): Promise<RcMessage[]>;
  getMentionedMessages(rid: string, count?: number): Promise<RcMessage[]>;
}

export type RocketChatSearchSource = Partial<RocketChatSearchDomain>;

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
