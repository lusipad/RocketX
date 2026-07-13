import type { RcRoomRole, RcUser, RoomRole } from '@rcx/rc-client';

/**
 * 群里的权限判断。
 *
 * Rocket.Chat 有两层角色：
 *   - 全局角色（user.roles）：admin 通吃所有房间
 *   - 房间角色（channels.roles）：owner / moderator / leader，只在这个房间里有效
 * 判断「能不能管这个群」两层都要看。
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

/** 我能不能管理这个群（改设置、踢人、禁言、归档） */
export function canManageRoom(me: RcUser | null, roomRoles: RcRoomRole[]): boolean {
  if (!me) return false;
  if (me.roles?.includes('admin')) return true;
  const mine = rolesOf(roomRoles, me._id);
  return mine.includes('owner') || mine.includes('moderator');
}

/** 只有群主（和全局管理员）能做的事：设/撤群主、删群 */
export function canTransferOwnership(me: RcUser | null, roomRoles: RcRoomRole[]): boolean {
  if (!me) return false;
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
): boolean {
  if (!me || target._id === me._id) return false;
  if (!canManageRoom(me, roomRoles)) return false;
  if (me.roles?.includes('admin')) return true;
  const targetIsOwner = rolesOf(roomRoles, target._id).includes('owner');
  return targetIsOwner ? rolesOf(roomRoles, me._id).includes('owner') : true;
}

/** 这个人被禁言了吗（room.muted 存的是 username） */
export function isMuted(muted: string[] | undefined, username: string): boolean {
  return (muted ?? []).includes(username);
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
