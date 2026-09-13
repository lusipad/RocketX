import type { RcRoomRole, RcUser, RoomRole, RoomType } from '@rcx/rc-client';

/**
 * 群里的权限判断。
 *
 * Rocket.Chat 有两层角色：
 *   - 全局角色（user.roles）：admin 通吃所有房间
 *   - 房间角色（channels.roles）：owner / moderator / leader，只在这个房间里有效
 * 判断「能不能管这个群」两层都要看。
 *
 * 还有第三个条件：**房间类型**。单聊和多人聊天在 RC 里都是 t='d'，它们**没有**频道那套
 * 管理能力 —— 实测过，对 DM 调 groups.kick / groups.roles / groups.addModerator 一律
 * 400，/mute 直接报「d is not a valid room type」。
 *
 * 这个判断必须在这里做，不能指望每个面板自己记得加 `!isDM`：全局 admin 的 roles 里有
 * 'admin'，下面几个函数会无条件放行，于是管理员在多人聊天的成员列表里就看到了
 * 「移出群聊 / 禁言 / 设管理员」，点一个报一个。
 */

export const ROLE_LABELS: Record<RoomRole, string> = {
  owner: '群主',
  moderator: '管理员',
  leader: '负责人',
};

/** 某人在这个房间里的角色。没角色就是普通成员，返回空数组 */
export function rolesOf(roomRoles: RcRoomRole[], userId: string): RoomRole[] {
  return roomRoles.find((r) => r.u._id === userId)?.roles ?? [];
}

/** DM（单聊和多人聊天，t='d'）没有任何群管理能力 */
function isManageableType(type: RoomType): boolean {
  return type === 'c' || type === 'p';
}

/** 我能不能管理这个群（改设置、踢人、禁言、归档） */
export function canManageRoom(
  me: RcUser | null,
  roomRoles: RcRoomRole[],
  type: RoomType,
): boolean {
  if (!me || !isManageableType(type)) return false;
  if (me.roles?.includes('admin')) return true;
  const mine = rolesOf(roomRoles, me._id);
  return mine.includes('owner') || mine.includes('moderator');
}

/** 只有群主（和全局管理员）能做的事：设/撤群主、删群 */
export function canTransferOwnership(
  me: RcUser | null,
  roomRoles: RcRoomRole[],
  type: RoomType,
): boolean {
  if (!me || !isManageableType(type)) return false;
  if (me.roles?.includes('admin')) return true;
  return rolesOf(roomRoles, me._id).includes('owner');
}

/**
 * 能不能对某个成员动手（踢 / 禁言 / 改角色）。
 *
 * 两条红线：不能动自己（想走用「退出群组」），也不能动比自己权限高的人
 * ——管理员不能踢群主，否则谁先动手谁赢。
 */
export function canActOn(
  me: RcUser | null,
  target: RcUser,
  roomRoles: RcRoomRole[],
  type: RoomType,
): boolean {
  if (!me || target._id === me._id) return false;
  if (!canManageRoom(me, roomRoles, type)) return false;
  if (me.roles?.includes('admin')) return true;
  const targetIsOwner = rolesOf(roomRoles, target._id).includes('owner');
  return targetIsOwner ? rolesOf(roomRoles, me._id).includes('owner') : true;
}

/** 这个人被禁言了吗（room.muted 存的是 username） */
export function isMuted(muted: string[] | undefined, username: string): boolean {
  return (muted ?? []).includes(username);
}

/**
 * 能不能往这个房间加人。
 *
 * 只对**讨论**做收口，其余房间保持宽松 —— 「加人」本来就由服务端的 `add-user`
 * 权限决定，RocketX 不再自作主张地提前禁用：
 *
 *   - 讨论（t='p' + prid）：**只有创建者能加人**。实测（RC 8.6）讨论创建者
 *     `groups.invite` 成功；父群成员（非讨论成员）与讨论普通成员都是
 *     `error-not-allowed`，而且 `add-user` 权限默认 roles=[] 也不影响创建者，
 *     说明是 RC 对讨论创建者的特殊放行。所以这里可以放心地提前禁用并说明原因。
 *   - 其他房间（频道 / 群组 / 私聊 / 多人聊天）：一律返回 true，包括私聊 ——
 *     私聊的「加人」本来就不是 invite，而是新建一个包含所有人的会话，
 *     由 `inviteMembers` 自己分流，界面不必禁用（老行为也是如此）。
 *     这里是刻意保守的选择：如果某个部署手工给 `user` 角色配了 `add-user`，
 *     提前禁用会误伤，而放着让服务端判定的代价只是多一次明确的错误提示。
 */
export function canInviteMembers(
  me: RcUser | null,
  room: { prid?: string; u?: { _id: string } } | undefined,
): boolean {
  if (!me) return false;
  if (!room?.prid) return true;
  if (me.roles?.includes('admin')) return true;
  return room.u?._id === me._id;
}

/** 成员排序：群主 → 管理员 → 负责人 → 普通成员，同级按名字 */
export function sortMembers(members: RcUser[], roomRoles: RcRoomRole[]): RcUser[] {
  const rank = (u: RcUser) => {
    const rs = rolesOf(roomRoles, u._id);
    if (rs.includes('owner')) return 0;
    if (rs.includes('moderator')) return 1;
    if (rs.includes('leader')) return 2;
    return 3;
  };
  return [...members].sort(
    (a, b) => rank(a) - rank(b) || (a.name || a.username).localeCompare(b.name || b.username),
  );
}
