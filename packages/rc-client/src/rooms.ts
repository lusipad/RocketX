import type {
  RcDate,
  RcRoom,
  RcRoomRole,
  RcSubscription,
  RcTeam,
  RcTeamMember,
  RcTeamRoom,
  RcUser,
  RoomType,
} from './types';
import { RcApiError, type RcRestEndpointContext } from './request';
import { slugifyRoomName } from './roomName';

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
  // 团队名同样受房间名 slug 校验约束（issue #392），中文名/带空格的名字必须清洗。
  const response = await context.request<{ team: RcTeam }>('POST', 'teams.create', {
    name: slugifyRoomName(name, 'team'),
    type: priv ? 1 : 0,
    members,
  });
  return response.team;
}

export async function listTeamRooms(context: RcRestEndpointContext, teamId: string, count = 50): Promise<RcTeamRoom[]> {
  const response = await context.request<{ rooms: RcTeamRoom[] }>('GET', 'teams.listRooms', undefined, { teamId, count });
  const rooms = response.rooms ?? [];
  // `teams.listRooms` 的返回里**没有** teamId / isDefault（真机实测），而界面要靠
  // isDefault 标出主频道、靠 teamId 判断归属，所以逐个补一次 rooms.info。
  return Promise.all(
    rooms.map(async (room) => {
      try {
        const info = await context.request<{ room: RcTeamRoom }>('GET', 'rooms.info', undefined, {
          roomId: room._id,
        });
        return { ...room, teamId: info.room?.teamId, isDefault: info.room?.teamMain };
      } catch {
        return room;
      }
    }),
  );
}

/**
 * 团队下的房间。
 *
 * 真机实测（RC 8.6）：
 *   - `teams.listRooms` 在**团队创建者**名下也返回 0 条（`total=0`），不能作为
 *     「列出团队房间」的主路径；
 *   - `teams.listChildren` 传 `teamId` 可以正常列出团队房间（服务端会解析到团队主频道），
 *     传主频道的 `roomId` 结果相同；传非团队房间的 roomId 会 400。
 * 所以这里以 `listChildren` 为主，并用 `rooms.info` 补出 `teamMain`（主频道标记）。
 */
export async function listTeamRoomsViaChildren(
  context: RcRestEndpointContext,
  teamId: string,
  count = 100,
): Promise<RcTeamRoom[]> {
  const response = await context.request<{ data: RcTeamRoom[] }>('GET', 'teams.listChildren', undefined, {
    teamId,
    count,
  });
  const rooms = response.data ?? [];
  return Promise.all(
    rooms.map(async (room) => {
      try {
        const info = await context.request<{ room: RcTeamRoom }>('GET', 'rooms.info', undefined, {
          roomId: room._id,
        });
        return { ...room, teamId: info.room?.teamId, isDefault: info.room?.teamMain };
      } catch {
        return room;
      }
    }),
  );
}

/**
 * 某个团队房间下的子房间。
 *
 * `teams.listChildren` 收的是**父房间 id**（`roomId`），不是团队 id。
 */
export async function listTeamChildren(
  context: RcRestEndpointContext,
  parentRoomId: string,
  count = 100,
): Promise<RcTeamRoom[]> {
  const response = await context.request<{ data: RcTeamRoom[] }>('GET', 'teams.listChildren', undefined, {
    roomId: parentRoomId,
    count,
  });
  return response.data ?? [];
}

/**
 * 团队信息。
 *
 * **响应字段是 `teamInfo` 而不是 `team`**（RC 8.6 实测），照 REST 命名的直觉写成
 * `response.team` 会拿到 undefined。
 */
export async function getTeamInfo(context: RcRestEndpointContext, teamId: string): Promise<RcTeam> {
  const response = await context.request<{ teamInfo: RcTeam; team?: RcTeam }>('GET', 'teams.info', undefined, {
    teamId,
  });
  return response.teamInfo ?? response.team!;
}

/**
 * 团队成员列表。
 *
 * **服务端返回的是 `{ user, roles, createdAt }` 包装**（不是扁平用户对象），
 * 团队角色在 `roles` 上而不是 `user.roles` 上。这里在客户端拍平，界面才能当用户用。
 */
export async function listTeamMembers(
  context: RcRestEndpointContext,
  teamId: string,
  count = 100,
): Promise<RcTeamMember[]> {
  const response = await context.request<{
    members: Array<{ user: RcUser; roles?: string[]; createdAt?: RcDate }>;
  }>('GET', 'teams.members', undefined, { teamId, count });
  return (response.members ?? [])
    .filter((entry) => !!entry?.user?._id)
    .map((entry) => ({ ...entry.user, roles: entry.roles ?? [], ts: entry.createdAt }));
}

/**
 * 团队维度的成员管理。
 *
 * 注意这不是频道级的 `groups.invite`：`teams.addMembers` 会把成员加进**团队主频道**，
 * 而 `teams.removeMember` 默认把他们从**团队的所有频道**里移除（可用 `rooms` 限定范围）。
 * 加进全部子频道由 `teams.updateMember` 负责。
 */
export function addTeamMembers(
  context: RcRestEndpointContext,
  teamId: string,
  members: Array<{ userId: string; roles?: string[] }>,
): Promise<unknown> {
  return context.request('POST', 'teams.addMembers', { teamId, members });
}

export function removeTeamMember(
  context: RcRestEndpointContext,
  teamId: string,
  userId: string,
  rooms?: string[],
): Promise<unknown> {
  return context.request('POST', 'teams.removeMember', {
    teamId,
    userId,
    ...(rooms && rooms.length > 0 ? { rooms } : {}),
  });
}

/** 团队成员改角色（roles 为空数组即清空该成员在团队里的角色） */
export function updateTeamMember(
  context: RcRestEndpointContext,
  teamId: string,
  userId: string,
  roles: string[],
): Promise<unknown> {
  return context.request('POST', 'teams.updateMember', { teamId, member: { userId, roles } });
}

/** 把已有房间挂到团队下 */
export function addTeamRooms(
  context: RcRestEndpointContext,
  teamId: string,
  rooms: string[],
): Promise<unknown> {
  return context.request('POST', 'teams.addRooms', { teamId, rooms });
}

/** 把房间移出团队（房间本身保留，只是不再属于该团队） */
export function removeTeamRoom(
  context: RcRestEndpointContext,
  teamId: string,
  roomId: string,
): Promise<unknown> {
  return context.request('POST', 'teams.removeRoom', { teamId, roomId });
}

/**
 * 团队房间设置：`isDefault` 用来指定/取消团队主频道。
 *
 * `teamId` 服务端接受但**根本不使用**（源码里带 TODO 注明），所以这里不传。
 */
export function updateTeamRoom(
  context: RcRestEndpointContext,
  roomId: string,
  isDefault: boolean,
): Promise<unknown> {
  return context.request('POST', 'teams.updateRoom', { roomId, isDefault });
}

/**
 * 改团队名 / 类型。
 *
 * `teams.update` 要求把改动包在 `data` 里（真机实测：直接传 `{ name }` 会
 * `must have required property 'data'`）。
 */
export function updateTeam(
  context: RcRestEndpointContext,
  teamId: string,
  data: { name?: string; type?: 0 | 1; updateRoom?: boolean },
): Promise<unknown> {
  const patch: Record<string, unknown> = { ...data };
  if (typeof patch.name === 'string') patch.name = slugifyRoomName(patch.name, 'team');
  const { updateRoom, ...rest } = patch;
  return context.request('POST', 'teams.update', {
    teamId,
    data: rest,
    ...(updateRoom === undefined ? {} : { updateRoom }),
  });
}

/** 退出团队（`rooms` 限定只退出这些房间；不传表示退出团队全部房间） */
export function leaveTeam(
  context: RcRestEndpointContext,
  teamId: string,
  rooms?: string[],
): Promise<unknown> {
  return context.request('POST', 'teams.leave', {
    teamId,
    ...(rooms && rooms.length > 0 ? { rooms } : {}),
  });
}

/**
 * 解散团队。
 *
 * `roomsToRemove` 是**要一并删除的团队房间**；不传时只解散团队、房间变成普通房间。
 * 这个区分很重要，所以界面上要给用户明确选。
 */
export function deleteTeam(
  context: RcRestEndpointContext,
  teamId: string,
  roomsToRemove?: string[],
): Promise<unknown> {
  return context.request('POST', 'teams.delete', {
    teamId,
    ...(roomsToRemove && roomsToRemove.length > 0 ? { roomsToRemove } : {}),
  });
}

/**
 * 频道 / 群组 → 团队。
 *
 * **入参是房间 id（或名字），没有 teamName**：真机实测传 `roomId` 会报
 * `must have required property 'channelId'` —— 公开频道端点的字段名是
 * `channelId` / `channelName`，私有群组端点是 `roomId` / `roomName`。
 * 团队名直接沿用房间名，不由调用方指定。
 */
export function convertRoomToTeam(
  context: RcRestEndpointContext,
  rid: string,
  type: RoomType,
): Promise<unknown> {
  const body = type === 'c' ? { channelId: rid } : { roomId: rid };
  return context.request('POST', type === 'c' ? 'channels.convertToTeam' : 'groups.convertToTeam', body);
}

/**
 * 把服务器上所有用户加进房间（`channels.addAll` / `groups.addAll`）。
 *
 * `activeUsersOnly` 只在私聊/群组端点上可用，且服务端接受 boolean/数字/字符串三种形态。
 */
export function addAllUsersToRoom(
  context: RcRestEndpointContext,
  rid: string,
  type: RoomType,
  activeUsersOnly = false,
): Promise<unknown> {
  const endpoint = type === 'c' ? 'channels.addAll' : 'groups.addAll';
  return context.request('POST', endpoint, {
    roomId: rid,
    activeUsersOnly: activeUsersOnly ? 1 : 0,
  });
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

/**
 * 取某个房间的订阅（含服务端草稿）。
 *
 * 草稿在 `subscriptions.get` / `getOne` 里都有；这个按房间的入口用于「打开房间时
 * 补一次」，因为列表接口的草稿只在登录/刷新时拉一次，之后别的设备可能改过。
 */
export async function getSubscription(
  context: RcRestEndpointContext,
  rid: string,
): Promise<RcSubscription | null> {
  const response = await context.request<{ subscription: RcSubscription }>('GET', 'subscriptions.getOne', undefined, {
    roomId: rid,
  });
  return response.subscription ?? null;
}

/**
 * 把草稿存到服务端（跨设备可见）。
 *
 * 空字符串表示清空草稿——服务端会把 draft 置为 undefined，所以「清空」也要发一次。
 * `tmid` 用于话题串内的草稿（旧服务端可能不支持，调用方自行降级）。
 */
export function saveDraft(
  context: RcRestEndpointContext,
  rid: string,
  draft: string,
  tmid?: string,
): Promise<unknown> {
  return context.request('POST', 'rooms.saveDraft', {
    rid,
    draft,
    ...(tmid ? { tmid } : {}),
  });
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

/**
 * 创建群组 / 频道。
 *
 * **不要试图用 `teamId` 直接建团队频道**：REST 的 `groups.create` / `channels.create`
 * 的 schema 里虽然有 `teamId`，但 handler 根本不读它（真机实测：带上它建出来的房间
 * 没有 teamId）。团队频道要「先建房间再 `teams.addRooms`」两步走。
 */
export async function createGroup(
  context: RcRestEndpointContext,
  name: string,
  members: string[],
  priv = true,
  options: { readOnly?: boolean } = {},
): Promise<RcRoom> {
  // 群名此前只把空格换成 `-`，中文群名仍会被服务端拒（issue #392）。
  const roomName = slugifyRoomName(name, 'group');
  const body: Record<string, unknown> = { name: roomName, members };
  if (options.readOnly !== undefined) body.readOnly = options.readOnly;
  if (priv) {
    const response = await context.request<{ group: RcRoom }>('POST', 'groups.create', body);
    return response.group;
  }
  const response = await context.request<{ channel: RcRoom }>('POST', 'channels.create', body);
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
  if (settings.name !== undefined) body.roomName = slugifyRoomName(settings.name, 'room');
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

/**
 * 创建讨论组（issue #392）。
 *
 * `name` 必须过服务端 slug 校验，否则 REST 返回
 * `X is not a valid room name. [error-invalid-room-name]`。
 * 调用方传消息原文或「#123 标题」时必然带空格/中文，所以这里统一清洗。
 */
export async function createDiscussion(context: RcRestEndpointContext, prid: string, name: string, pmid?: string): Promise<RcRoom> {
  const response = await context.request<{ discussion: RcRoom }>('POST', 'rooms.createDiscussion', {
    prid,
    t_name: slugifyRoomName(name, 'discussion'),
    ...(pmid ? { pmid } : {}),
  });
  return response.discussion;
}

/**
 * 注意：Rocket.Chat **没有**「讨论 → 频道」的 REST 端点。
 *
 * `channels.convertToChannel` / `groups.convertToChannel` 都不存在（8.6 实测 404）；
 * 官方只有 `channels.convertToTeam` / `groups.convertToTeam`（频道 → 团队）。
 * 所以这个功能不能靠一个接口实现，需要自建频道 + 搬迁消息与成员，属于独立工作项。
 */

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

/**
 * 逐个邀请用户进房。
 *
 * **没有** inviteAll 可用：`channels.inviteAll` / `groups.inviteAll` 在
 * RC 8.6.1 都是 404（实测，同 muteUser 一类缺失端点），批量邀请只能循环本方法。
 */
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
