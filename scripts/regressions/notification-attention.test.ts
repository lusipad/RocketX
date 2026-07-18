import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationHasFocus,
  messageIsFromCurrentUser,
  notificationAttentionPolicy,
} from '../../apps/web/src/stores/chat';

const base = {
  subscribed: true,
  muted: false,
  mentioned: false,
  focused: false,
  isGroupish: true,
  desktopNotifications: 'all' as const,
  muteFocusedConversations: true,
  taskbarFlash: true,
};

test('只有活动会话且文档真正聚焦时才算正在查看', () => {
  assert.equal(conversationHasFocus('room-1', 'room-1', false), false);
  assert.equal(conversationHasFocus('room-1', 'room-1', true), true);
  assert.equal(conversationHasFocus('room-2', 'room-1', true), false);
});

test('任务栏闪烁不受桌面通知关闭影响', () => {
  assert.deepEqual(
    notificationAttentionPolicy({ ...base, desktopNotifications: 'nothing' }),
    { flashTaskbar: true, showDesktopNotification: false },
  );
});

test('仅提及模式只过滤桌面通知，不过滤普通未读的任务栏闪烁', () => {
  assert.deepEqual(
    notificationAttentionPolicy({ ...base, desktopNotifications: 'mentions' }),
    { flashTaskbar: true, showDesktopNotification: false },
  );
});

test('自己发送的消息同时按登录 ID、当前用户 ID 和用户名识别', () => {
  const currentUser = { _id: 'real-user-id', username: 'admin' };
  assert.equal(
    messageIsFromCurrentUser({ _id: 'cached-user-id', username: 'other' }, 'cached-user-id', currentUser),
    true,
  );
  assert.equal(
    messageIsFromCurrentUser({ _id: 'real-user-id', username: 'other' }, 'stale-user-id', currentUser),
    true,
  );
  assert.equal(
    messageIsFromCurrentUser({ _id: 'unexpected-id', username: 'Admin' }, 'stale-user-id', currentUser),
    true,
  );
  assert.equal(
    messageIsFromCurrentUser({ _id: 'member-id', username: 'member' }, 'stale-user-id', currentUser),
    false,
  );
});

test('用户关闭任务栏闪烁后仍可保留系统通知', () => {
  assert.deepEqual(notificationAttentionPolicy({ ...base, taskbarFlash: false }), {
    flashTaskbar: false,
    showDesktopNotification: true,
  });
});

test('免打扰继续静默，但提及可以穿透到任务栏', () => {
  assert.deepEqual(notificationAttentionPolicy({ ...base, muted: true }), {
    flashTaskbar: false,
    showDesktopNotification: false,
  });
  assert.deepEqual(
    notificationAttentionPolicy({
      ...base,
      muted: true,
      mentioned: true,
      desktopNotifications: 'nothing',
    }),
    { flashTaskbar: true, showDesktopNotification: false },
  );
});

test('当前正在看的会话不闪任务栏', () => {
  assert.deepEqual(
    notificationAttentionPolicy({
      ...base,
      focused: true,
      muteFocusedConversations: false,
    }),
    { flashTaskbar: false, showDesktopNotification: true },
  );
});

test('未订阅房间不触发桌面通知或任务栏闪烁', () => {
  assert.deepEqual(notificationAttentionPolicy({ ...base, subscribed: false }), {
    flashTaskbar: false,
    showDesktopNotification: false,
  });
});
