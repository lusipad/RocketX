import type { RcUser } from './types';

export interface RocketChatUsersDomain {
  getPresences(): Promise<{ username: string; status?: string }[]>;
  listUsers(count?: number, offset?: number): Promise<{ users: RcUser[]; total: number }>;
  searchUsers(text?: string, count?: number, offset?: number): Promise<{ users: RcUser[]; total: number; via: string }>;
  getUserInfo(usernameOrId: string): Promise<RcUser>;
  getUserInfoById(userId: string): Promise<RcUser>;
  updateOwnBasicInfo(data: {
    name?: string;
    email?: string;
    username?: string;
    newPassword?: string;
    currentPassword?: string;
  }): Promise<RcUser>;
  setAvatar(file: Blob, fileName?: string): Promise<void>;
  resetAvatar(userId?: string): Promise<void>;
}

export type RocketChatUsersSource = Partial<RocketChatUsersDomain>;

function required<K extends keyof RocketChatUsersDomain>(source: RocketChatUsersSource, key: K): NonNullable<RocketChatUsersDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat users domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatUsersDomain[K]>;
}

export function createRocketChatUsersDomain(source: RocketChatUsersSource): RocketChatUsersDomain {
  return {
    getPresences: () => required(source, 'getPresences')(),
    listUsers: (count, offset) => required(source, 'listUsers')(Math.max(1, count ?? 100), Math.max(0, offset ?? 0)),
    searchUsers: (text, count, offset) => required(source, 'searchUsers')(text ?? '', Math.max(1, count ?? 100), Math.max(0, offset ?? 0)),
    getUserInfo: (value) => required(source, 'getUserInfo')(value),
    getUserInfoById: (value) => required(source, 'getUserInfoById')(value),
    updateOwnBasicInfo: (data) => required(source, 'updateOwnBasicInfo')(data),
    setAvatar: (file, fileName) => required(source, 'setAvatar')(file, fileName),
    resetAvatar: (userId) => required(source, 'resetAvatar')(userId),
  };
}
