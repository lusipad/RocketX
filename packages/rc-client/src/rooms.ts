import type { RcRoom, RcRoomRole, RcSubscription, RcTeam, RcUser, RoomType } from './types';
import { RcApiError, type RcRestEndpointContext } from './request';

export interface RocketChatRoomsDomain {
  getSubscriptions(): Promise<RcSubscription[]>;
  getRooms(): Promise<RcRoom[]>;
  getMembers(rid: string, type: RoomType, count?: number): Promise<RcUser[]>;
  listTeams(count?: number): Promise<RcTeam[]>;
  listTeamRooms(teamId: string, count?: number): Promise<RcRoom[]>;
  createDirectMessage(usernames: string | string[]): Promise<RcRoom>;
  createGroup(name: string, members: string[], priv?: boolean): Promise<RcRoom>;
  getRoomInfo(rid: string): Promise<RcRoom>;
  getRoomRoles(rid: string, type: RoomType): Promise<RcRoomRole[]>;
  favoriteRoom(roomId: string, favorite: boolean): Promise<unknown>;
  muteRoom(roomId: string, mute: boolean): Promise<unknown>;
  hideRoom(roomId: string, type: RoomType): Promise<unknown>;
  openRoom(roomId: string, type: RoomType): Promise<unknown>;
}

export type RocketChatRoomsSource = Partial<RocketChatRoomsDomain>;

export async function listTeams(context: RcRestEndpointContext, count = 50): Promise<RcTeam[]> {
  const response = await context.request<{ teams: RcTeam[] }>('GET', 'teams.list', undefined, { count });
  return response.teams ?? [];
}

export async function createTeam(context: RcRestEndpointContext, name: string, members: string[], priv = true): Promise<RcTeam> {
  const response = await context.request<{ team: RcTeam }>('POST', 'teams.create', { name, type: priv ? 1 : 0, members });
  return response.team;
}

export async function listTeamRooms(context: RcRestEndpointContext, teamId: string, count = 50): Promise<RcRoom[]> {
  const response = await context.request<{ rooms: RcRoom[] }>('GET', 'teams.listRooms', undefined, { teamId, count });
  return response.rooms ?? [];
}

export async function getSubscriptions(context: RcRestEndpointContext): Promise<RcSubscription[]> {
  const response = await context.request<{ update: RcSubscription[] }>('GET', 'subscriptions.get');
  return response.update ?? [];
}

export async function getRooms(context: RcRestEndpointContext): Promise<RcRoom[]> {
  const response = await context.request<{ update: RcRoom[] }>('GET', 'rooms.get');
  return response.update ?? [];
}

export function markRead(context: RcRestEndpointContext, rid: string): Promise<unknown> {
  return context.request('POST', 'subscriptions.read', { rid });
}

export async function createDirectMessage(context: RcRestEndpointContext, usernames: string | string[]): Promise<RcRoom> {
  const list = Array.isArray(usernames) ? usernames : [usernames];
  const response = await context.request<{ room: RcRoom }>('POST', 'im.create', list.length > 1
    ? { usernames: list.join(',') }
    : { username: list[0] });
  return response.room;
}

export function openDirectMessage(context: RcRestEndpointContext, roomId: string): Promise<unknown> {
  return context.request('POST', 'im.open', { roomId });
}

export async function createGroup(context: RcRestEndpointContext, name: string, members: string[], priv = true): Promise<RcRoom> {
  if (priv) {
    const response = await context.request<{ group: RcRoom }>('POST', 'groups.create', { name, members });
    return response.group;
  }
  const response = await context.request<{ channel: RcRoom }>('POST', 'channels.create', { name, members });
  return response.channel;
}

export async function getMembers(context: RcRestEndpointContext, rid: string, type: RoomType, count = 200): Promise<RcUser[]> {
  const endpoint = type === 'c' ? 'channels.members' : type === 'p' ? 'groups.members' : 'im.members';
  const pageSize = Number.isFinite(count) ? Math.max(1, count) : 200;
  const maxPages = 1_000;
  const members = new Map<string, RcUser>();
  let offset = 0;
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const response = await context.request<{ members: RcUser[]; total?: number }>('GET', endpoint, undefined, {
      roomId: rid,
      count: pageSize,
      offset,
    });
    const page = response.members ?? [];
    if (Number.isFinite(response.total) && response.total! >= 0) total = Math.floor(response.total!);
    const before = members.size;
    for (const member of page) members.set(member._id, member);
    if (page.length === 0) {
      if (total !== undefined && members.size < total) {
        throw new RcApiError(`成员列表不完整：服务端报告 ${total} 人，只返回 ${members.size} 人`, 502, 'members-pagination-incomplete');
      }
      return [...members.values()];
    }
    if (members.size === before) throw new RcApiError(`成员列表分页没有新增成员（offset ${offset}）`, 502, 'members-pagination-stalled');
    offset += page.length;
    if (total !== undefined) {
      if (members.size >= total) return [...members.values()];
      if (offset >= total) throw new RcApiError(`成员列表不完整：服务端报告 ${total} 人，只返回 ${members.size} 个唯一成员`, 502, 'members-pagination-incomplete');
    } else if (page.length < pageSize) {
      return [...members.values()];
    }
  }
  throw new RcApiError(`成员列表分页请求达到 ${maxPages} 页上限`, 502, 'members-pagination-limit');
}

export async function getRoomInfo(context: RcRestEndpointContext, rid: string): Promise<RcRoom> {
  const response = await context.request<{ room: RcRoom }>('GET', 'rooms.info', undefined, { roomId: rid });
  return response.room;
}

export async function saveRoomSettings(
  context: RcRestEndpointContext,
  rid: string,
  settings: { topic?: string; announcement?: string; description?: string; name?: string },
): Promise<void> {
  const body: Record<string, string> = { rid };
  if (settings.topic !== undefined) body.roomTopic = settings.topic;
  if (settings.announcement !== undefined) body.roomAnnouncement = settings.announcement;
  if (settings.description !== undefined) body.roomDescription = settings.description;
  if (settings.name !== undefined) body.roomName = settings.name;
  await context.request('POST', 'rooms.saveRoomSettings', body);
}

export async function leaveRoom(context: RcRestEndpointContext, rid: string, type: RoomType): Promise<void> {
  await context.request('POST', type === 'c' ? 'channels.leave' : 'groups.leave', { roomId: rid });
}

export async function deleteRoom(context: RcRestEndpointContext, rid: string, type: RoomType): Promise<void> {
  await context.request('POST', type === 'c' ? 'channels.delete' : 'groups.delete', { roomId: rid });
}

export async function getRoomRoles(context: RcRestEndpointContext, rid: string, type: RoomType): Promise<RcRoomRole[]> {
  const response = await context.request<{ roles: RcRoomRole[] }>('GET', type === 'c' ? 'channels.roles' : 'groups.roles', undefined, { roomId: rid });
  return response.roles ?? [];
}

export function kickFromRoom(context: RcRestEndpointContext, rid: string, type: RoomType, userId: string): Promise<unknown> {
  return context.request('POST', type === 'c' ? 'channels.kick' : 'groups.kick', { roomId: rid, userId });
}

export function setRoomRole(
  context: RcRestEndpointContext,
  rid: string,
  type: RoomType,
  userId: string,
  role: 'owner' | 'moderator' | 'leader',
  grant: boolean,
): Promise<unknown> {
  const suffix = role === 'owner' ? 'Owner' : role === 'moderator' ? 'Moderator' : 'Leader';
  return context.request('POST', `${type === 'c' ? 'channels' : 'groups'}.${grant ? 'add' : 'remove'}${suffix}`, { roomId: rid, userId });
}

export function muteUser(context: RcRestEndpointContext, rid: string, username: string, mute: boolean): Promise<unknown> {
  return context.request('POST', 'commands.run', { command: mute ? 'mute' : 'unmute', roomId: rid, params: `@${username}` });
}

export function archiveRoom(context: RcRestEndpointContext, rid: string, type: RoomType, archive: boolean): Promise<unknown> {
  return context.request('POST', `${type === 'c' ? 'channels' : 'groups'}.${archive ? 'archive' : 'unarchive'}`, { roomId: rid });
}

export function setReadOnly(context: RcRestEndpointContext, rid: string, type: RoomType, readOnly: boolean): Promise<unknown> {
  return context.request('POST', `${type === 'c' ? 'channels' : 'groups'}.setReadOnly`, { roomId: rid, readOnly });
}

export async function createDiscussion(context: RcRestEndpointContext, prid: string, name: string, pmid?: string): Promise<RcRoom> {
  const response = await context.request<{ discussion: RcRoom }>('POST', 'rooms.createDiscussion', {
    prid,
    t_name: name,
    ...(pmid ? { pmid } : {}),
  });
  return response.discussion;
}

export function favoriteRoom(context: RcRestEndpointContext, roomId: string, favorite: boolean): Promise<unknown> {
  return context.request('POST', 'rooms.favorite', { roomId, favorite });
}

export function muteRoom(context: RcRestEndpointContext, roomId: string, mute: boolean): Promise<unknown> {
  return context.request('POST', 'rooms.saveNotification', { roomId, notifications: { disableNotifications: mute ? '1' : '0' } });
}

export function hideRoom(context: RcRestEndpointContext, roomId: string, type: RoomType): Promise<unknown> {
  return context.request('POST', type === 'c' ? 'channels.close' : type === 'p' ? 'groups.close' : 'im.close', { roomId });
}

export function openRoom(context: RcRestEndpointContext, roomId: string, type: RoomType): Promise<unknown> {
  return context.request('POST', type === 'c' ? 'channels.open' : type === 'p' ? 'groups.open' : 'im.open', { roomId });
}

export function joinChannel(context: RcRestEndpointContext, rid: string): Promise<unknown> {
  return context.request('POST', 'channels.join', { roomId: rid });
}

export function joinRoom(context: RcRestEndpointContext, rid: string): Promise<unknown> {
  return context.request('POST', 'rooms.join', { roomId: rid });
}

export function inviteToRoom(context: RcRestEndpointContext, rid: string, type: RoomType, userId: string): Promise<unknown> {
  return context.request('POST', type === 'c' ? 'channels.invite' : 'groups.invite', { roomId: rid, userId });
}

function required<K extends keyof RocketChatRoomsDomain>(source: RocketChatRoomsSource, key: K): NonNullable<RocketChatRoomsDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat rooms domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatRoomsDomain[K]>;
}

function requiredId(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} 不能为空`);
  return value;
}

export function createRocketChatRoomsDomain(source: RocketChatRoomsSource): RocketChatRoomsDomain {
  return {
    getSubscriptions: () => required(source, 'getSubscriptions')(),
    getRooms: () => required(source, 'getRooms')(),
    getMembers: (rid, type, count) => required(source, 'getMembers')(requiredId(rid, 'roomId'), type, Math.max(1, count ?? 200)),
    listTeams: (count) => required(source, 'listTeams')(Math.max(1, count ?? 50)),
    listTeamRooms: (teamId, count) => required(source, 'listTeamRooms')(requiredId(teamId, 'teamId'), Math.max(1, count ?? 50)),
    createDirectMessage: (usernames) => required(source, 'createDirectMessage')(usernames),
    createGroup: (name, members, priv) => required(source, 'createGroup')(requiredId(name, 'name'), members, priv),
    getRoomInfo: (rid) => required(source, 'getRoomInfo')(requiredId(rid, 'roomId')),
    getRoomRoles: (rid, type) => required(source, 'getRoomRoles')(requiredId(rid, 'roomId'), type),
    favoriteRoom: (roomId, favorite) => required(source, 'favoriteRoom')(requiredId(roomId, 'roomId'), favorite),
    muteRoom: (roomId, mute) => required(source, 'muteRoom')(requiredId(roomId, 'roomId'), mute),
    hideRoom: (roomId, type) => required(source, 'hideRoom')(requiredId(roomId, 'roomId'), type),
    openRoom: (roomId, type) => required(source, 'openRoom')(requiredId(roomId, 'roomId'), type),
  };
}
