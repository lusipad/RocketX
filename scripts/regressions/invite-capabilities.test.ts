import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { RcUser } from '../../packages/rc-client/src/index';
import { canInviteMembers } from '../../apps/web/src/lib/roomAdmin';

const me: RcUser = { _id: 'me', username: 'me' };

/**
 * 加人判定的策略（与用户确认过的取舍）：
 * **只在讨论里收口，其他房间保持宽松**。「加人」本来就由服务端的 `add-user`
 * 权限决定，客户端提前禁用会在「管理员手工给 user 配了 add-user」的部署上误伤。
 */
test('非讨论房间保持宽松：不在客户端提前禁用加人', () => {
  const admin = { ...me, roles: ['admin'] };
  // 普通成员、频道、群组、私聊 —— 一律放行，交给服务端判定
  assert.equal(canInviteMembers(me, { _id: 'c', t: 'c' }), true, '公开频道放行');
  assert.equal(canInviteMembers(me, { _id: 'g', t: 'p' }), true, '私有群组放行');
  // 私聊：加人走「新建一个包含所有人的会话」，界面不该禁用（老行为）
  assert.equal(canInviteMembers(me, { _id: 'dm', t: 'd' }), true, '私聊放行，由 inviteMembers 分流');
  assert.equal(canInviteMembers(admin, { _id: 'g', t: 'p' }), true);
  // 只有「不知道房间」和「没登录」才不放行
  assert.equal(canInviteMembers(me, undefined), true, '房间信息还没到也不能禁用（宽松优先）');
  assert.equal(canInviteMembers(null, { _id: 'g', t: 'p' }), false, '没登录不能加人');
});

/**
 * 讨论（t='p' + prid）：**只有创建者**能加人。
 *
 * 实测（RC 8.6）：讨论创建者 `groups.invite` 成功；父群成员（非讨论成员）与讨论
 * 普通成员都是 `error-not-allowed`；`add-user` 权限默认 roles=[] 也不影响创建者，
 * 说明这是 RC 对讨论创建者的特殊放行 —— 所以这里可以放心提前禁用。
 */
test('讨论里只有创建者能加人（真机实测的权限边界）', () => {
  assert.equal(
    canInviteMembers(me, { _id: 'disc', prid: 'parent', u: { _id: 'me' } }),
    true,
    '创建者可以加人',
  );
  assert.equal(
    canInviteMembers(me, { _id: 'disc', prid: 'parent', u: { _id: 'other' } }),
    false,
    '普通成员不能加人（服务端 error-not-allowed）',
  );
  // 讨论信息还没到（拿不到创建者）时同样收口：讨论里的失败是确定的
  assert.equal(canInviteMembers(me, { _id: 'disc', prid: 'parent' }), false);
  // 全局管理员仍放行（服务端对 admin 不拦）
  assert.equal(
    canInviteMembers({ ...me, roles: ['admin'] }, { _id: 'disc', prid: 'parent', u: { _id: 'other' } }),
    true,
  );
});

test('成员面板只按讨论判定收口，并说明为什么不能加人', async () => {
  const panel = await readFile(
    new URL('../../apps/web/src/components/MembersPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(panel, /const canInvite = canInviteMembers\(me, room\)/);
  // 「添加成员」「从其他频道导入」「批量加人」都按同一个判定禁用
  assert.equal([...panel.matchAll(/disabled=\{!canInvite\}/g)].length, 3);
  assert.match(panel, /只有讨论的创建者能往讨论里加人/);
  // 禁用时给出原因，而不是让用户点完才发现
  assert.match(panel, /inviteBlockedReason && \(/);
  // 禁用不能改掉按钮自己的标识（否则连「添加成员」都找不到了）
  assert.equal([...panel.matchAll(/title="添加成员"/g)].length, 1);
  assert.doesNotMatch(panel, /title=\{canInvite/);
  // 不再按房间类型/角色提前禁用非讨论房间
  assert.doesNotMatch(panel, /canInviteMembers\(me, roomRoles, membersType, room\)/);
});
