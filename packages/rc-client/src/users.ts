import type { RcUser } from './types';
import { RcApiError, postMultipart, type RcRestEndpointContext } from './request';

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

async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new RcApiError(
      '当前不是安全上下文，无法加密密码。请通过 https 访问，或改用桌面客户端。',
      400,
    );
  }
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getPresences(context: RcRestEndpointContext): Promise<{ username: string; status?: string }[]> {
  return context.request<{ users: { username: string; status?: string }[] }>('GET', 'users.presence')
    .then((response) => response.users ?? []);
}

export function setStatus(context: RcRestEndpointContext, status: string, message?: string): Promise<unknown> {
  return context.request('POST', 'users.setStatus', { status, ...(message !== undefined ? { message } : {}) });
}

export function listUsers(
  context: RcRestEndpointContext,
  count = 100,
  offset = 0,
): Promise<{ users: RcUser[]; total: number }> {
  return context.request<{ users: RcUser[]; total: number }>('GET', 'users.list', undefined, { count, offset })
    .then((response) => ({ users: response.users ?? [], total: response.total ?? 0 }));
}

export async function searchUsers(
  context: RcRestEndpointContext,
  text = '',
  count = 100,
  offset = 0,
): Promise<{ users: RcUser[]; total: number; via: string }> {
  const errors: string[] = [];
  try {
    const response = await context.request<{ result: RcUser[]; total: number }>('GET', 'directory', undefined, {
      text,
      type: 'users',
      count,
      offset,
      sort: '{"username":1}',
    });
    if (response.result?.length > 0) return { users: response.result, total: response.total ?? 0, via: 'directory' };
    errors.push('directory 返回空');
  } catch (error) {
    errors.push(`directory: ${error instanceof Error ? error.message : error}`);
  }
  try {
    const response = await listUsers(context, count, offset);
    const normalized = text.toLowerCase();
    const filtered = text
      ? response.users.filter((user) => user.username?.toLowerCase().includes(normalized) || user.name?.toLowerCase().includes(normalized))
      : response.users;
    if (filtered.length > 0) return { users: filtered, total: response.total || filtered.length, via: 'users.list' };
    if (offset > 0) return { users: [], total: response.total, via: 'users.list' };
    errors.push('users.list 返回空');
  } catch (error) {
    errors.push(`users.list: ${error instanceof Error ? error.message : error}`);
  }
  if (offset > 0) return { users: [], total: 0, via: 'spotlight' };
  try {
    const response = await context.request<{ users: RcUser[] }>('GET', 'spotlight', undefined, { query: text });
    if (response.users?.length > 0) return { users: response.users, total: response.users.length, via: 'spotlight' };
    errors.push('spotlight 返回空');
  } catch (error) {
    errors.push(`spotlight: ${error instanceof Error ? error.message : error}`);
  }
  throw new Error(errors.join('；'));
}

export async function updateOwnBasicInfo(
  context: RcRestEndpointContext,
  data: { name?: string; email?: string; username?: string; newPassword?: string; currentPassword?: string },
): Promise<RcUser> {
  const { currentPassword, ...rest } = data;
  const response = await context.request<{ user: RcUser }>('POST', 'users.updateOwnBasicInfo', {
    data: { ...rest, ...(currentPassword ? { currentPassword: await sha256Hex(currentPassword) } : {}) },
  });
  return response.user;
}

export async function setAvatar(context: RcRestEndpointContext, file: Blob, fileName = 'avatar.png'): Promise<void> {
  await postMultipart(context, 'users.setAvatar', 'image', file, fileName);
}

export async function resetAvatar(context: RcRestEndpointContext, userId?: string): Promise<void> {
  const target = userId ?? context.currentUserId();
  if (!target) throw new RcApiError('未登录', 401);
  await context.request('POST', 'users.resetAvatar', { userId: target });
}

export async function getUserInfo(context: RcRestEndpointContext, usernameOrId: string): Promise<RcUser> {
  const key = /^[a-zA-Z0-9]{17}$/.test(usernameOrId) ? 'userId' : 'username';
  const response = await context.request<{ user: RcUser }>('GET', 'users.info', undefined, { [key]: usernameOrId });
  return response.user;
}

export async function getUserInfoById(context: RcRestEndpointContext, userId: string): Promise<RcUser> {
  const response = await context.request<{ user: RcUser }>('GET', 'users.info', undefined, { userId });
  return response.user;
}

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
