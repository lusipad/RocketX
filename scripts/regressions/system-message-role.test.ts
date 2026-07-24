import assert from 'node:assert/strict';
import test from 'node:test';
import { systemMessageText } from '../../apps/web/src/lib/format';

test('角色系统消息使用服务端 role，而不是把操作者显示成角色（issue #220）', () => {
  assert.equal(
    systemMessageText('subscription-role-added', '群主B', '成员A', 'owner'),
    '成员A 被设置为群主',
  );
  assert.equal(
    systemMessageText('subscription-role-added', '管理员B', '成员A', 'moderator'),
    '成员A 被设置为管理员',
  );
  assert.equal(
    systemMessageText('subscription-role-added', '群主B', '成员A', 'leader'),
    '成员A 被设置为负责人',
  );
});

test('旧消息缺少 role 时不把操作者误报为角色', () => {
  assert.equal(
    systemMessageText('subscription-role-added', '群主B', '成员A'),
    '成员A 的会话角色已更新',
  );
});
