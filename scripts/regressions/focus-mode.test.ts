import assert from 'node:assert/strict';
import test from 'node:test';
import { rest } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  emptyFocusStats,
  focusAggregationConfig,
  useFocus,
} from '../../apps/web/src/stores/focus';
import { DEFAULT_NOTIFICATION_AGGREGATION_CONFIG } from '../../apps/web/src/lib/notificationAggregation';

const originalSetStatus = rest.setStatus;
const originalUser = useAuth.getState().user;

/** 记录专注会话对服务端状态的操作 */
let statusCalls: string[] = [];

function reset(status: 'online' | 'away' | 'busy' = 'online') {
  useFocus.setState({ session: null, stats: emptyFocusStats(), digest: null });
  useAuth.setState({
    user: { _id: 'u1', username: 'me', name: '我', status },
  } as typeof originalUser);
  statusCalls = [];
  rest.setStatus = async (next: string) => {
    statusCalls.push(next);
  };
}

test.afterEach(() => {
  rest.setStatus = originalSetStatus;
  useAuth.setState({ user: originalUser });
  useFocus.setState({ session: null, stats: emptyFocusStats(), digest: null });
});

test('开始专注：记录进入前状态，切 busy；结束时恢复并生成消化卡', async () => {
  reset('away');

  await useFocus.getState().start(25);
  const session = useFocus.getState().session;
  assert.ok(session);
  assert.equal(session.prevStatus, 'away');
  assert.equal(session.endsAt! - session.startedAt, 25 * 60_000);
  assert.deepEqual(statusCalls, ['busy']);
  // 开始新会话时清空上次的消化卡
  assert.equal(useFocus.getState().digest, null);

  await useFocus.getState().end();
  assert.equal(useFocus.getState().session, null);
  assert.deepEqual(statusCalls, ['busy', 'away']);
  const digest = useFocus.getState().digest;
  assert.ok(digest);
  assert.ok(digest.durationMinutes >= 1);
});

test('已有会话时 start 是 no-op，不重复切状态', async () => {
  reset();
  await useFocus.getState().start(25);
  const first = useFocus.getState().session;
  await useFocus.getState().start(50);
  assert.equal(useFocus.getState().session, first);
  assert.deepEqual(statusCalls, ['busy']);
});

test('不限时会话：endsAt 为 null，只能手动结束', async () => {
  reset();
  await useFocus.getState().start(null);
  assert.equal(useFocus.getState().session?.endsAt, null);
  await useFocus.getState().end();
  assert.equal(useFocus.getState().session, null);
});

test('延长：从原结束点顺延，不限时从当前时刻起算', async () => {
  reset();
  await useFocus.getState().start(25);
  const before = useFocus.getState().session!.endsAt!;
  useFocus.getState().extend(25);
  assert.equal(useFocus.getState().session!.endsAt, before + 25 * 60_000);
  await useFocus.getState().end();
});

test('会话统计：聚合计数、会话去重、@我 与其他穿透分开；结束后不再计数', async () => {
  reset();
  await useFocus.getState().start(25);
  const base = {
    id: 'm1', roomId: 'r1', roomName: '群', senderName: '张三',
    text: 'hi', timestamp: Date.now(), directMessage: false,
    directMention: false, broadcastMention: false,
  };
  const s = useFocus.getState();
  s.noteAggregated(base);
  s.noteAggregated({ ...base, id: 'm2' });
  s.noteAggregated({ ...base, id: 'm3', roomId: 'r2' });
  s.notePassthrough({ ...base, id: 'm4', directMention: true });
  s.notePassthrough({ ...base, id: 'm5', text: 'P0 故障' });

  const stats = useFocus.getState().stats;
  assert.equal(stats.aggregated, 3);
  assert.deepEqual(stats.roomIds, ['r1', 'r2']);
  assert.equal(stats.mentionPassthrough, 1);
  assert.equal(stats.otherPassthrough, 1);

  await useFocus.getState().end();
  // 消化卡的统计就是会话期间统计的快照
  assert.deepEqual(useFocus.getState().digest!.stats, stats);
  useFocus.getState().noteAggregated({ ...base, id: 'm6' });
  assert.equal(useFocus.getState().digest!.stats.aggregated, 3);
});

test('到点自动结束：状态恢复、消化卡生成', async () => {
  reset();
  await useFocus.getState().start(0.01); // 0.6 秒
  assert.ok(useFocus.getState().session);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(useFocus.getState().session, null);
  assert.deepEqual(statusCalls, ['busy', 'online']);
  assert.ok(useFocus.getState().digest);
});

test('状态切换失败不阻断会话：通知聚合是本机行为，busy 只是给别人的信号', async () => {
  reset();
  rest.setStatus = async () => {
    throw new Error('网络错误');
  };
  await useFocus.getState().start(25);
  assert.ok(useFocus.getState().session);
  await useFocus.getState().end();
  assert.equal(useFocus.getState().session, null);
});

test('专注期间的路由配置：强制聚合，但沿用禅模式的穿透白名单', () => {
  // 无禅模式配置时用默认规则开聚合
  const fromNull = focusAggregationConfig(null);
  assert.equal(fromNull.enabled, true);
  assert.deepEqual(fromNull.urgent, DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent);
  // 用户关掉了 @我 穿透时，专注不能偷偷改回来
  const custom = {
    ...DEFAULT_NOTIFICATION_AGGREGATION_CONFIG,
    urgent: { ...DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent, directMentions: false },
  };
  const fromBase = focusAggregationConfig(custom);
  assert.equal(fromBase.enabled, true);
  assert.equal(fromBase.urgent.directMentions, false);
});
