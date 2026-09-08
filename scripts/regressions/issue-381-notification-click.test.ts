import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  notificationTarget,
  queueNotificationTarget,
  takeQueuedNotificationTarget,
} from '../../apps/web/src/lib/notificationNavigation';

test('通知导航接受原生补拉的 id，并拒绝非法 payload', () => {
  assert.deepEqual(
    notificationTarget({ id: 'native-1', rid: 'room-123', mid: 'message-456' }),
    { id: 'native-1', rid: 'room-123', mid: 'message-456' },
  );
  assert.deepEqual(
    notificationTarget({ rid: 'room-123', mid: 'message-456' }),
    { rid: 'room-123', mid: 'message-456' },
  );
  assert.equal(notificationTarget({ id: '', rid: 'room-123', mid: 'message-456' }), null);
  assert.equal(notificationTarget({ id: 'native\n1', rid: 'room-123', mid: 'message-456' }), null);
});

test('聊天通知在 auth 或 chat.ready 未完成前保留，条件满足后再消费', () => {
  const target = notificationTarget({ id: 'native-1', rid: 'room-123', mid: 'message-456' });
  assert.ok(target);

  let queue = queueNotificationTarget([], target);
  let next = takeQueuedNotificationTarget(queue, 'boot', false);
  assert.equal(next.target, null);
  queue = next.queue;

  next = takeQueuedNotificationTarget(queue, 'authed', false);
  assert.equal(next.target, null);
  queue = next.queue;

  next = takeQueuedNotificationTarget(queue, 'authed', true);
  assert.deepEqual(next.target, target);
  assert.deepEqual(next.queue, []);
});

test('多条聊天通知在 ready 后按点击顺序逐条消费', () => {
  const first = notificationTarget({ id: 'native-1', rid: 'room-123', mid: 'message-456' });
  const second = notificationTarget({ id: 'native-2', rid: 'room-123', mid: 'message-789' });
  assert.ok(first);
  assert.ok(second);

  let queue = queueNotificationTarget(queueNotificationTarget([], first), second);
  let next = takeQueuedNotificationTarget(queue, 'authed', true);
  assert.deepEqual(next.target, first);
  queue = next.queue;

  next = takeQueuedNotificationTarget(queue, 'authed', true);
  assert.deepEqual(next.target, second);
  assert.deepEqual(next.queue, []);
});

test('管家通知只等登录完成，不依赖 chat.ready', () => {
  const target = notificationTarget({ id: 'native-2', rid: 'butler', mid: 'message-789' });
  assert.ok(target);

  let next = takeQueuedNotificationTarget([target], 'authing', false);
  assert.equal(next.target, null);

  next = takeQueuedNotificationTarget([target], 'authed', false);
  assert.deepEqual(next.target, target);
  assert.deepEqual(next.queue, []);
});

test('同一条原生通知被事件监听和补拉同时收到时只保留一次', () => {
  const target = notificationTarget({ id: 'native-3', rid: 'room-123', mid: 'message-456' });
  assert.ok(target);

  const queue = queueNotificationTarget(queueNotificationTarget([], target), target);
  assert.deepEqual(queue, [target]);
});

test('即时事件已开始定位后，补拉旧通知不能覆盖较新的点击', () => {
  const first = { id: 'native-a', rid: 'room-123', mid: 'message-a' };
  const second = { id: 'native-b', rid: 'room-123', mid: 'message-b' };
  const acceptedIds = new Set<string>();
  let queue = queueNotificationTarget([], first, acceptedIds);
  const started = takeQueuedNotificationTarget(queue, 'authed', true);
  queue = queueNotificationTarget(started.queue, second, acceptedIds);
  queue = queueNotificationTarget(queue, first, acceptedIds);
  queue = queueNotificationTarget(queue, second, acceptedIds);
  assert.deepEqual([started.target, ...queue], [first, second]);

  queue = takeQueuedNotificationTarget(queue, 'authed', true).queue;
  assert.deepEqual(queueNotificationTarget(queue, second, acceptedIds), []);
});

test('同一消息的新原生点击和不带 ID 的后续点击仍可再次导航', () => {
  const acceptedIds = new Set<string>();
  const target = { rid: 'room-123', mid: 'message-456' };
  queueNotificationTarget([], { ...target, id: 'native-a' }, acceptedIds);
  assert.deepEqual(
    queueNotificationTarget([], { ...target, id: 'native-b' }, acceptedIds),
    [{ ...target, id: 'native-b' }],
  );
  queueNotificationTarget([], target, acceptedIds);
  assert.deepEqual(queueNotificationTarget([], target, acceptedIds), [target]);
});

test('原生通知去重历史有界且保留最近处理的目标', () => {
  const acceptedIds = new Set<string>();
  for (let i = 0; i < 300; i++) {
    queueNotificationTarget([], { id: `native-${i}`, rid: 'room', mid: `message-${i}` }, acceptedIds);
  }
  assert.equal(acceptedIds.size, 256);
  assert.equal(acceptedIds.has('native-0'), false);
  assert.deepEqual(
    queueNotificationTarget([], { id: 'native-299', rid: 'room', mid: 'message-299' }, acceptedIds),
    [],
  );
});

test('Windows 原生通知点击链路保留补拉兜底，避免 listener 或 ready 过早丢事件', async () => {
  const [notifySource, bridgeSource, commandsSource, mainSource] = await Promise.all([
    readFile(new URL('../../apps/web/src/lib/notify.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NotificationNavigationBridge.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/platform/desktopCommands.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/desktop/src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(notifySource, /invoke\('show_message_notification', \{/);
  assert.match(notifySource, /rid: opts\.rid/);
  assert.match(notifySource, /mid: opts\.mid/);

  assert.match(bridgeSource, /takePendingNotificationNavigation/);
  assert.match(bridgeSource, /queueNotificationTarget/);
  assert.match(bridgeSource, /queueNotificationTarget\(\s*pendingTargetsRef\.current,\s*target,\s*acceptedIdsRef\.current/);
  assert.match(bridgeSource, /takeQueuedNotificationTarget/);
  assert.match(bridgeSource, /useAuth\(\(s\) => s\.status\)/);
  assert.match(bridgeSource, /useChat\(\(s\) => s\.ready\)/);
  assert.match(
    bridgeSource,
    /while \(!cancelled\) \{[\s\S]*takePendingNotificationNavigation\(\)[\s\S]*if \(payload == null\) return;[\s\S]*enqueuePayload\(payload\);[\s\S]*\}/,
  );
  assert.match(
    commandsSource,
    /invoke<unknown \| null>\('take_pending_notification_navigation'\)/,
  );
  assert.match(bridgeSource, /if \(pendingRead\) return pendingRead;/);
  assert.match(bridgeSource, /finally\(\(\) => \{[\s\S]*pendingRead = null/);
  assert.match(bridgeSource, /listenDesktopEvent<unknown>\(NOTIFICATION_OPEN_ROOM_EVENT/);
  assert.match(bridgeSource, /jumpToMessage\(target\.mid, target\.rid\)/);

  assert.match(mainSource, /const PENDING_NOTIFICATION_NAVIGATION_LIMIT: usize = 32;/);
  assert.match(
    mainSource,
    /if pending\.len\(\) >= PENDING_NOTIFICATION_NAVIGATION_LIMIT \{[\s\S]*pending\.pop_front\(\);[\s\S]*\}[\s\S]*pending\.push_back\(payload\);/,
  );
  assert.match(mainSource, /fn take_pending_notification_navigation\(\) -> Result<Option<NotificationRoomPayload>, String>/);
  assert.match(mainSource, /queue_pending_notification_navigation\(payload\.clone\(\)\)/);
  assert.match(mainSource, /show_main\(&app\);[\s\S]*app\.emit\(\s*"notification-open-room"/);
});
