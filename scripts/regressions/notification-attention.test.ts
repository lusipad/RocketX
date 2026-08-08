import assert from 'node:assert/strict';
import test from 'node:test';
import { RcRestClient } from '../../packages/rc-client/src/rest';
import {
  conversationIsActivelyViewed,
  messageIsNotificationCandidate,
  messageIsFromCurrentUser,
  notificationAttentionPolicy,
  threadReplyShouldNotify,
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

test('后台停留在当前会话时，新消息保持未读以显示任务栏数字角标', () => {
  assert.equal(conversationIsActivelyViewed('room-1', 'room-1', false), false);
  assert.equal(conversationIsActivelyViewed('room-1', 'room-1', true), true);
  assert.equal(conversationIsActivelyViewed('room-2', 'room-1', true), false);
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

test('过期文件清理只更新旧消息，不触发新消息提醒', () => {
  assert.equal(messageIsNotificationCandidate({ attachments: [{ type: 'removed-file' }] }), false);
  assert.equal(messageIsNotificationCandidate({ t: 'message_pinned' }), false);
  assert.equal(messageIsNotificationCandidate({ attachments: [{ type: 'file' }] }), true);
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

test('讨论串只提醒关注者、根消息作者的首条回复和被直接提及的人（issue #278）', () => {
  const me = { _id: 'user-me', username: 'tester' };
  const reply = {
    tmid: 'thread-root',
    msg: '普通回复',
    mentions: [],
  };

  assert.equal(threadReplyShouldNotify(reply, {
    u: { _id: 'user-alice', username: 'alice' },
    replies: ['user-me'],
    tcount: 3,
  }, me), true);
  assert.equal(threadReplyShouldNotify(reply, {
    u: { _id: 'user-alice', username: 'alice' },
    replies: ['user-bob'],
    tcount: 3,
  }, me), false);
  assert.equal(threadReplyShouldNotify(reply, {
    u: me,
    replies: [],
  }, me), true);
  assert.equal(threadReplyShouldNotify({
    ...reply,
    msg: '@tester 请看',
    mentions: [me],
  }, {
    u: { _id: 'user-alice', username: 'alice' },
    replies: [],
    tcount: 3,
  }, me), true);
  assert.equal(threadReplyShouldNotify({ ...reply, tmid: undefined }, undefined, me), true);
});

test('讨论串关注开关使用 Rocket.Chat 官方 follow/unfollow 接口（issue #278）', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example.test',
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await client.followMessage('thread-root');
  await client.unfollowMessage('thread-root');

  assert.deepEqual(requests, [
    {
      url: 'https://chat.example.test/api/v1/chat.followMessage',
      body: { mid: 'thread-root' },
    },
    {
      url: 'https://chat.example.test/api/v1/chat.unfollowMessage',
      body: { mid: 'thread-root' },
    },
  ]);
});
