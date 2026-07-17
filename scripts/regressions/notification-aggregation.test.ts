import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NOTIFICATION_AGGREGATION_CONFIG,
  addToNotificationBuckets,
  attentionReduction,
  beginAttentionMeasurement,
  defaultNotificationAggregationState,
  flushNotificationBuckets,
  notificationAggregationStorageKey,
  parseNotificationAggregationState,
  recordNotificationCandidate,
  recordNotificationPopup,
  routeNotification,
  type AttentionMetricsState,
  type NotificationAggregationInput,
} from '../../apps/web/src/lib/notificationAggregation';

const normal: NotificationAggregationInput = {
  id: 'm1',
  roomId: 'r1',
  roomName: '项目群',
  senderName: '张三',
  text: '构建完成了',
  timestamp: Date.parse('2026-07-17T09:00:00Z'),
  directMessage: false,
  directMention: false,
  broadcastMention: false,
};

test('默认聚合普通通知，仅直接提及、P1 和紧急关键字穿透', () => {
  assert.deepEqual(routeNotification(normal, DEFAULT_NOTIFICATION_AGGREGATION_CONFIG), {
    mode: 'aggregate',
  });
  assert.deepEqual(
    routeNotification({ ...normal, directMention: true }, DEFAULT_NOTIFICATION_AGGREGATION_CONFIG),
    { mode: 'passthrough', reason: 'direct-mention' },
  );
  assert.deepEqual(
    routeNotification({ ...normal, priority: 1 }, DEFAULT_NOTIFICATION_AGGREGATION_CONFIG),
    { mode: 'passthrough', reason: 'priority-one' },
  );
  assert.deepEqual(
    routeNotification({ ...normal, text: 'P0 故障，请立即处理' }, DEFAULT_NOTIFICATION_AGGREGATION_CONFIG),
    { mode: 'passthrough', reason: 'keyword' },
  );
  assert.deepEqual(
    routeNotification({ ...normal, broadcastMention: true }, DEFAULT_NOTIFICATION_AGGREGATION_CONFIG),
    { mode: 'aggregate' },
  );
});

test('关闭聚合恢复逐条弹出；穿透规则可独立配置', () => {
  assert.deepEqual(
    routeNotification(normal, { ...DEFAULT_NOTIFICATION_AGGREGATION_CONFIG, enabled: false }),
    { mode: 'passthrough', reason: 'aggregation-disabled' },
  );
  assert.deepEqual(
    routeNotification(
      { ...normal, directMessage: true, broadcastMention: true },
      {
        ...DEFAULT_NOTIFICATION_AGGREGATION_CONFIG,
        urgent: {
          ...DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent,
          directMessages: true,
          broadcastMentions: true,
        },
      },
    ),
    { mode: 'passthrough', reason: 'direct-message' },
  );
});

test('同房间在窗口内合并，跨房间分桶，到期只产生摘要数据而不发送系统通知', () => {
  let buckets = addToNotificationBuckets([], normal, 5);
  buckets = addToNotificationBuckets(
    buckets,
    { ...normal, id: 'm2', timestamp: normal.timestamp + 60_000, text: '第二条' },
    5,
  );
  buckets = addToNotificationBuckets(
    buckets,
    { ...normal, id: 'm3', roomId: 'r2', roomName: '运维群' },
    5,
  );
  assert.equal(buckets.length, 2);
  assert.equal(buckets.find((bucket) => bucket.roomId === 'r1')?.count, 2);

  const early = flushNotificationBuckets(buckets, normal.timestamp + 299_999);
  assert.equal(early.summaries.length, 0);
  const due = flushNotificationBuckets(buckets, normal.timestamp + 300_000);
  assert.equal(due.summaries.length, 2);
  assert.deepEqual(due.summaries.find((summary) => summary.roomId === 'r1'), {
    roomId: 'r1',
    roomName: '项目群',
    count: 2,
    latestMessageId: 'm2',
    latestSenderName: '张三',
    latestText: '第二条',
    firstAt: normal.timestamp,
    lastAt: normal.timestamp + 60_000,
  });
  assert.equal(due.pending.length, 0);
});

function recordDay(
  state: AttentionMetricsState,
  phase: 'baseline' | 'dogfood',
  day: number,
  popups: number,
): AttentionMetricsState {
  const timestamp = Date.parse(`2026-07-${String(day).padStart(2, '0')}T12:00:00Z`);
  let next = recordNotificationCandidate(state, phase, timestamp, Math.max(popups, 1));
  next = recordNotificationPopup(next, phase, timestamp, 'passthrough', popups);
  return next;
}

test('注意力指标在基线或 14 天 dogfood 样本不足时不误报达标', () => {
  let metrics = defaultNotificationAggregationState().metrics;
  metrics = beginAttentionMeasurement(metrics, 'baseline', '2026-07-01');
  for (let day = 1; day <= 7; day++) metrics = recordDay(metrics, 'baseline', day, 10);
  metrics = beginAttentionMeasurement(metrics, 'dogfood', '2026-07-08');
  assert.equal(metrics.activePhase, 'dogfood');
  for (let day = 8; day <= 20; day++) metrics = recordDay(metrics, 'dogfood', day, 4);

  const result = attentionReduction(metrics, '2026-07-20');
  assert.equal(result.baselineDays, 7);
  assert.equal(result.dogfoodDays, 13);
  assert.equal(result.reductionRate, 0.6);
  assert.equal(result.eligible, false);
  assert.equal(result.targetMet, null);
});

test('dogfood 满 14 天后按日均真实弹出次数判定下降至少 50%', () => {
  let metrics = defaultNotificationAggregationState().metrics;
  metrics = beginAttentionMeasurement(metrics, 'baseline', '2026-07-01');
  for (let day = 1; day <= 7; day++) metrics = recordDay(metrics, 'baseline', day, 10);
  metrics = beginAttentionMeasurement(metrics, 'dogfood', '2026-07-08');
  for (let day = 8; day <= 21; day++) metrics = recordDay(metrics, 'dogfood', day, 5);

  const result = attentionReduction(metrics, '2026-07-21');
  assert.deepEqual(result, {
    baselineDays: 7,
    dogfoodDays: 14,
    baselineDailyAverage: 10,
    dogfoodDailyAverage: 5,
    reductionRate: 0.5,
    targetRate: 0.5,
    eligible: true,
    targetMet: true,
  });
});

test('配置和统计按服务器/用户隔离持久化，损坏数据回退安全默认值', () => {
  const first = notificationAggregationStorageKey('HTTPS://CHAT.EXAMPLE.COM/', 'user-a');
  assert.equal(
    first,
    notificationAggregationStorageKey('https://chat.example.com', 'user-a'),
  );
  assert.notEqual(first, notificationAggregationStorageKey('https://chat.example.com', 'user-b'));

  const state = defaultNotificationAggregationState();
  assert.deepEqual(parseNotificationAggregationState(JSON.stringify(state)), state);
  const recovered = parseNotificationAggregationState(JSON.stringify({
    ...state,
    config: { enabled: 'yes', windowMinutes: 999, urgent: { keywords: ['', 'P0', 'P0'] } },
    metrics: { activePhase: 'invalid', baseline: { days: [{ date: 'bad', popups: -1 }] } },
    buckets: [{ roomId: '', messageIds: [] }],
  }));
  assert.equal(recovered?.config.enabled, true);
  assert.equal(recovered?.config.windowMinutes, 5);
  assert.deepEqual(recovered?.config.urgent.keywords, ['P0']);
  assert.equal(recovered?.metrics.activePhase, null);
  assert.deepEqual(recovered?.metrics.baseline.days, []);
  assert.deepEqual(recovered?.buckets, []);
  assert.equal(parseNotificationAggregationState('{broken'), null);
  assert.equal(
    parseNotificationAggregationState(JSON.stringify({ ...state, version: 99 })),
    null,
  );
});
