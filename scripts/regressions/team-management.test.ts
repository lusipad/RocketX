import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { RcTeamMember, RcTeamRoom } from '../../packages/rc-client/src/index';
import { canManageTeam, mergeTeamRooms, sortTeamRooms, teamTypeLabel } from '../../apps/web/src/lib/teams';

const room = (id: string, name: string, extra: Partial<RcTeamRoom> = {}): RcTeamRoom =>
  ({ _id: id, t: 'p', name, ...extra }) as RcTeamRoom;

test('团队房间分出主频道，其余按名字排序', () => {
  const { main, others } = sortTeamRooms([
    room('r2', 'beta'),
    room('r1', 'alpha'),
    room('r0', 'main', { isDefault: true }),
  ]);
  assert.equal(main?._id, 'r0');
  assert.deepEqual(others.map((item) => item._id), ['r1', 'r2']);
  // 没有主频道时 main 为 undefined，不能抛错
  assert.equal(sortTeamRooms([room('r1', 'a')]).main, undefined);
});

test('mergeTeamRooms 按 id 去重（listRooms 与 listChildren 可能重叠）', () => {
  const merged = mergeTeamRooms([room('a', 'A'), room('b', 'B')], [room('b', 'B'), room('c', 'C')]);
  assert.deepEqual(merged.map((item) => item._id).sort(), ['a', 'b', 'c']);
});

/**
 * 团队管理权限：服务端要求 `edit-team` 等权限，与创建者/所有者强相关。
 * 拿不到团队信息时返回 false —— 不为「先显示按钮」去猜，免得点了才吃 403。
 */
test('只有创建者 / 团队 owner / 全局管理员能管理团队', () => {
  const team = { createdBy: { _id: 'me', username: 'me' } };
  assert.equal(canManageTeam({ _id: 'me' }, team, []), true, '创建者可以管理');
  assert.equal(
    canManageTeam({ _id: 'me' }, { createdBy: { _id: 'other', username: 'o' } }, []),
    false,
    '非创建者、无 owner 角色 → 不能管理',
  );
  assert.equal(
    canManageTeam(
      { _id: 'me' },
      { createdBy: { _id: 'other', username: 'o' } },
      [{ _id: 'me', username: 'me', roles: ['owner'] } as RcTeamMember],
    ),
    true,
    '团队 owner 能管理',
  );
  assert.equal(
    canManageTeam(
      { _id: 'me', roles: ['admin'] },
      { createdBy: { _id: 'other', username: 'o' } },
      [],
    ),
    true,
    '全局管理员能管理',
  );
  assert.equal(canManageTeam(null, team, []), false, '未登录不能管理');
  assert.equal(canManageTeam({ _id: 'me' }, undefined, []), false, '没有团队信息时不放行');
});

test('团队类型文案', () => {
  assert.equal(teamTypeLabel(0), '公开团队');
  assert.equal(teamTypeLabel(1), '私有团队');
  assert.equal(teamTypeLabel(undefined), '私有团队');
});

/**
 * 三条用真机踩出来的接口约束，必须体现在实现里，否则又是「看着对、一跑就错」：
 *   1. `groups.create` / `channels.create` 不接受 teamId（handler 不读），
 *      团队频道要「先建房间再 addRooms」两步走；
 *   2. `teams.listRooms` 在真机上返回空，团队房间要经 `listChildren` 取；
 *   3. `teams.update` 的改动要包在 `data` 里；`teams.updateRoom` 不收 teamId。
 */
test('团队接口的真实约束都写在实现里（真机实测）', async () => {
  const rooms = await readFile(
    new URL('../../packages/rc-client/src/rooms.ts', import.meta.url),
    'utf8',
  );
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );

  // 1. 两步法建团队频道
  assert.match(chatStore, /const room = await rest\.createGroup\(name, \[\], priv\);/);
  assert.match(chatStore, /await rest\.addTeamRooms\(teamId, \[room\._id\]\);/);
  assert.match(rooms, /不要试图用 `teamId` 直接建团队频道/);
  // createGroup 不再暴露 teamId 选项
  assert.doesNotMatch(rooms, /options: \{ teamId\?: string; readOnly\?: boolean \}/);

  // 2. 团队房间经 listChildren 取
  assert.match(chatStore, /rest\.listTeamRoomsViaChildren\(teamId, 100\)/);
  assert.match(rooms, /listTeamRoomsViaChildren/);

  // 3. update 的 data 包装 + updateRoom 不收 teamId
  assert.match(rooms, /data: rest,/);
  assert.match(rooms, /'teams\.updateRoom', \{ roomId, isDefault \}/);
});

test('三个入口都接上了：团队面板、批量加人、频道转团队', async () => {
  const roomInfo = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );
  const members = await readFile(
    new URL('../../apps/web/src/components/MembersPanel.tsx', import.meta.url),
    'utf8',
  );
  const teamPanel = await readFile(
    new URL('../../apps/web/src/components/TeamPanel.tsx', import.meta.url),
    'utf8',
  );
  const app = await readFile(new URL('../../apps/web/src/App.tsx', import.meta.url), 'utf8');

  // 团队面板挂到根部，入口在群信息
  assert.match(app, /<TeamPanelHost \/>/);
  assert.match(roomInfo, /管理所属团队/);
  assert.match(roomInfo, /openTeamPanel\(\{ teamId: conv\.teamId \}\)/);
  // 非团队房间可以升级为团队
  assert.match(roomInfo, /把这个频道转换为团队/);
  assert.match(roomInfo, /convertRoomToTeam\(rid, conv\.type/);
  // 团队面板覆盖成员 / 房间 / 解散退出
  assert.match(teamPanel, /添加成员/);
  assert.match(teamPanel, /新建团队频道/);
  assert.match(teamPanel, /解散团队/);
  assert.match(teamPanel, /退出团队/);
  // 批量加人入口（讨论与 DM 不给）
  assert.match(members, /channels\.addAll|addAllUsersToRoom\(rid, type, activeOnly\)/);
  assert.match(members, /\(type === 'c' \|\| type === 'p'\) && !room\?\.prid/);
  assert.match(members, /只加在线用户（推荐）/);
});
