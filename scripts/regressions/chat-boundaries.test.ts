import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyChatMessage, type NotificationCoordinatorDeps } from '../../apps/web/src/chat/notificationCoordinator';
import type { RcMessage } from '@rcx/rc-client';

function message(id: string, overrides: Partial<RcMessage> = {}): RcMessage {
  return {
    _id: id,
    rid: 'room-1',
    msg: 'hello',
    ts: '2026-08-23T08:00:00.000Z',
    u: { _id: 'other', username: 'other', name: 'Other' },
    ...overrides,
  } as RcMessage;
}

function deps(shown: string[]): NotificationCoordinatorDeps {
  return {
    loadAuth: () => ({ userId: 'me' }),
    currentUser: () => ({ _id: 'me', username: 'me' }),
    consumeExpectedAgentReply: () => false,
    getPrefs: () => ({ desktopNotifications: 'all', muteFocusedConversations: true, notificationsSoundVolume: 50 }),
    taskbarFlash: () => false,
    focus: () => ({ session: null, noteAggregated: () => {}, notePassthrough: () => {} }),
    aggregation: () => ({
      state: null,
      recordCandidate: () => {},
      recordPopup: () => {},
      addAggregate: () => {},
    }),
    fetchMessage: async () => message('root'),
    flashTaskbar: () => {},
    showDesktopNotification: async (options) => {
      shown.push(options.mid);
      return true;
    },
    playNotificationSound: () => {},
    navigateToMessage: () => {},
    documentHasFocus: () => false,
  };
}

const snapshot = {
  subscriptions: { 'room-1': { rid: 'room-1', t: 'c', name: 'general', fname: 'general', unread: 1, alert: true } },
  rooms: { 'room-1': { _id: 'room-1', t: 'c', name: 'general' } },
  messages: {},
  activeRid: null,
};

test('通知协调器保留订阅过滤、消息去重和平台回调边界', async () => {
  const shown: string[] = [];
  const notificationDeps = deps(shown);
  const incoming = message('notification-1');
  await notifyChatMessage(incoming, 'room-1', snapshot, notificationDeps);
  await notifyChatMessage(incoming, 'room-1', snapshot, notificationDeps);
  assert.deepEqual(shown, ['notification-1']);
});
test('通知协调器在已有线程根且未命中时不越过线程策略', async () => {
  const shown: string[] = [];
  const notificationDeps = deps(shown);
  const root = message('root', { tcount: 2 });
  await notifyChatMessage(
    message('thread-reply', { tmid: 'root' }),
    'room-1',
    { ...snapshot, messages: { 'room-1': [root] } },
    notificationDeps,
  );
  assert.deepEqual(shown, []);
});
