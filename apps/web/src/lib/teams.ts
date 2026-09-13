import type { RcTeam, RcTeamMember, RcTeamRoom, RcUser } from '@rcx/rc-client';

/**
 * 团队（Team）的判定与整理逻辑。
 *
 * Rocket.Chat 的团队是「主频道 + 一组频道」的容器：`teamId` 标记归属，
 * `isDefault` 标记哪一个是主频道。成员、房间都挂在团队维度上，和频道级
 * （`groups.invite` / `channels.invite`）是两套不同的权限与端点。
 */

/** 能把团队房间按「主频道 / 其他房间」分开，并在组内按名字排序 */
export function sortTeamRooms(rooms: RcTeamRoom[]): {
  main: RcTeamRoom | undefined;
  others: RcTeamRoom[];
} {
  const sorted = [...rooms].sort((left, right) =>
    roomLabel(left).localeCompare(roomLabel(right), 'zh-CN'),
  );
  const main = sorted.find((room) => room.isDefault);
  return { main, others: sorted.filter((room) => room !== main) };
}

export function roomLabel(room: { fname?: string; name?: string; _id: string }): string {
  return room.fname || room.name || room._id;
}

/**
 * 我能不能管理这个团队。
 *
 * 判定依据（服务端实际要求 `edit-team` / `remove-team` 等权限，与创建者/所有者强相关）：
 *   - 全局管理员；
 *   - 团队创建者（`createdBy._id`）；
 *   - 团队成员里带着 owner 角色的自己。
 *
 * 拿不到团队信息时返回 false——团队面板本来就依赖团队信息，避免为了「先显示按钮」
 * 去猜，让用户在点了之后才吃 403。
 */
export function canManageTeam(
  me: Pick<RcUser, '_id' | 'roles'> | null | undefined,
  team: Pick<RcTeam, 'createdBy'> | null | undefined,
  members: RcTeamMember[] | undefined,
): boolean {
  if (!me) return false;
  if (me.roles?.includes('admin')) return true;
  if (team?.createdBy?._id === me._id) return true;
  const mine = members?.find((member) => member._id === me._id);
  return !!mine?.roles?.includes('owner');
}

/** 团队类型：0 公开 / 1 私有（与 `teams.create` 的 type 一致） */
export function teamTypeLabel(type: number | undefined): string {
  return type === 0 ? '公开团队' : '私有团队';
}

/**
 * 把 `teams.listRooms` 与 `teams.listChildren` 合并去重。
 * 前者给团队直属房间，后者给挂在团队房间下的子房间。
 */
export function mergeTeamRooms(parents: RcTeamRoom[], children: RcTeamRoom[]): RcTeamRoom[] {
  const byId = new Map<string, RcTeamRoom>();
  for (const room of [...parents, ...children]) byId.set(room._id, room);
  return [...byId.values()];
}
