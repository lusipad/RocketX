export const NOTIFICATION_AGGREGATION_VERSION = 1 as const;

export interface NotificationUrgentRules {
  directMessages: boolean;
  directMentions: boolean;
  broadcastMentions: boolean;
  priorityOne: boolean;
  keywords: string[];
}

export interface NotificationAggregationConfig {
  enabled: boolean;
  windowMinutes: number;
  urgent: NotificationUrgentRules;
}

export type NotificationAggregationConfigPatch = Partial<
  Omit<NotificationAggregationConfig, 'urgent'>
> & { urgent?: Partial<NotificationUrgentRules> };

export const DEFAULT_NOTIFICATION_AGGREGATION_CONFIG: NotificationAggregationConfig = {
  enabled: true,
  windowMinutes: 5,
  urgent: {
    directMessages: false,
    directMentions: true,
    broadcastMentions: false,
    priorityOne: true,
    keywords: ['紧急', 'urgent', 'P0'],
  },
};

export interface NotificationAggregationInput {
  id: string;
  roomId: string;
  roomName: string;
  senderName: string;
  text: string;
  timestamp: number;
  directMessage: boolean;
  directMention: boolean;
  broadcastMention: boolean;
  priority?: number;
}

export type NotificationRoute =
  | { mode: 'aggregate' }
  | {
      mode: 'passthrough';
      reason:
        | 'aggregation-disabled'
        | 'direct-message'
        | 'direct-mention'
        | 'broadcast-mention'
        | 'priority-one'
        | 'keyword';
    };

export function normalizeNotificationAggregationConfig(
  value: NotificationAggregationConfigPatch | null | undefined,
): NotificationAggregationConfig {
  const windowMinutes = Number(value?.windowMinutes);
  const keywords = value?.urgent?.keywords;
  return {
    enabled:
      typeof value?.enabled === 'boolean'
        ? value.enabled
        : DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.enabled,
    windowMinutes:
      Number.isFinite(windowMinutes) && windowMinutes >= 1 && windowMinutes <= 60
        ? Math.round(windowMinutes)
        : DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.windowMinutes,
    urgent: {
      directMessages:
        typeof value?.urgent?.directMessages === 'boolean'
          ? value.urgent.directMessages
          : DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent.directMessages,
      directMentions:
        typeof value?.urgent?.directMentions === 'boolean'
          ? value.urgent.directMentions
          : DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent.directMentions,
      broadcastMentions:
        typeof value?.urgent?.broadcastMentions === 'boolean'
          ? value.urgent.broadcastMentions
          : DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent.broadcastMentions,
      priorityOne:
        typeof value?.urgent?.priorityOne === 'boolean'
          ? value.urgent.priorityOne
          : DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent.priorityOne,
      keywords: Array.isArray(keywords)
        ? [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 20)
        : [...DEFAULT_NOTIFICATION_AGGREGATION_CONFIG.urgent.keywords],
    },
  };
}

export function routeNotification(
  input: NotificationAggregationInput,
  config: NotificationAggregationConfig,
): NotificationRoute {
  if (!config.enabled) return { mode: 'passthrough', reason: 'aggregation-disabled' };
  if (config.urgent.directMessages && input.directMessage) {
    return { mode: 'passthrough', reason: 'direct-message' };
  }
  if (config.urgent.directMentions && input.directMention) {
    return { mode: 'passthrough', reason: 'direct-mention' };
  }
  if (config.urgent.broadcastMentions && input.broadcastMention) {
    return { mode: 'passthrough', reason: 'broadcast-mention' };
  }
  if (config.urgent.priorityOne && input.priority === 1) {
    return { mode: 'passthrough', reason: 'priority-one' };
  }
  const text = input.text.toLocaleLowerCase();
  if (config.urgent.keywords.some((keyword) => text.includes(keyword.toLocaleLowerCase()))) {
    return { mode: 'passthrough', reason: 'keyword' };
  }
  return { mode: 'aggregate' };
}

export interface NotificationBucket {
  roomId: string;
  roomName: string;
  count: number;
  messageIds: string[];
  latestMessageId: string;
  latestSenderName: string;
  latestText: string;
  firstAt: number;
  lastAt: number;
  expiresAt: number;
}

export interface NotificationAggregateSummary {
  roomId: string;
  roomName: string;
  count: number;
  latestMessageId: string;
  latestSenderName: string;
  latestText: string;
  firstAt: number;
  lastAt: number;
}

export function addToNotificationBuckets(
  buckets: NotificationBucket[],
  input: NotificationAggregationInput,
  windowMinutes: number,
): NotificationBucket[] {
  const existingIndex = buckets.findIndex(
    (bucket) => bucket.roomId === input.roomId && input.timestamp < bucket.expiresAt,
  );
  if (existingIndex < 0) {
    return [
      ...buckets,
      {
        roomId: input.roomId,
        roomName: input.roomName,
        count: 1,
        messageIds: [input.id],
        latestMessageId: input.id,
        latestSenderName: input.senderName,
        latestText: input.text,
        firstAt: input.timestamp,
        lastAt: input.timestamp,
        expiresAt: input.timestamp + Math.max(1, windowMinutes) * 60_000,
      },
    ];
  }
  const existing = buckets[existingIndex];
  if (existing.messageIds.includes(input.id)) return buckets;
  const isLatest = input.timestamp >= existing.lastAt;
  const next = {
    ...existing,
    roomName: input.roomName || existing.roomName,
    count: existing.count + 1,
    messageIds: [...existing.messageIds, input.id],
    firstAt: Math.min(existing.firstAt, input.timestamp),
    lastAt: Math.max(existing.lastAt, input.timestamp),
    ...(isLatest
      ? {
          latestMessageId: input.id,
          latestSenderName: input.senderName,
          latestText: input.text,
        }
      : {}),
  };
  return buckets.map((bucket, index) => (index === existingIndex ? next : bucket));
}

export function flushNotificationBuckets(
  buckets: NotificationBucket[],
  now: number,
): { summaries: NotificationAggregateSummary[]; pending: NotificationBucket[] } {
  const due = buckets.filter((bucket) => bucket.expiresAt <= now);
  return {
    summaries: due.map(({ messageIds: _messageIds, expiresAt: _expiresAt, ...summary }) => summary),
    pending: buckets.filter((bucket) => bucket.expiresAt > now),
  };
}

export type AttentionMeasurementPhase = 'baseline' | 'dogfood';
export type NotificationPopupKind = 'passthrough' | 'aggregate';

export interface AttentionDailyCount {
  date: string;
  candidates: number;
  popups: number;
  passthroughPopups: number;
  aggregatePopups: number;
}

export interface AttentionMeasurementPeriod {
  startedOn: string | null;
  endedOn: string | null;
  days: AttentionDailyCount[];
}

export interface AttentionMetricsState {
  activePhase: AttentionMeasurementPhase | null;
  baseline: AttentionMeasurementPeriod;
  dogfood: AttentionMeasurementPeriod;
}

export interface NotificationAggregationStateV1 {
  version: typeof NOTIFICATION_AGGREGATION_VERSION;
  config: NotificationAggregationConfig;
  metrics: AttentionMetricsState;
  buckets: NotificationBucket[];
}

function emptyPeriod(): AttentionMeasurementPeriod {
  return { startedOn: null, endedOn: null, days: [] };
}

export function defaultNotificationAggregationState(): NotificationAggregationStateV1 {
  return {
    version: NOTIFICATION_AGGREGATION_VERSION,
    config: normalizeNotificationAggregationConfig(null),
    metrics: { activePhase: null, baseline: emptyPeriod(), dogfood: emptyPeriod() },
    buckets: [],
  };
}

function validDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function previousDate(value: string): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export function beginAttentionMeasurement(
  state: AttentionMetricsState,
  phase: AttentionMeasurementPhase,
  startedOn: string,
): AttentionMetricsState {
  if (!validDateKey(startedOn)) return state;
  const next = {
    ...state,
    activePhase: phase,
    [phase]: { startedOn, endedOn: null, days: [] },
  };
  if (phase === 'dogfood' && next.baseline.startedOn && !next.baseline.endedOn) {
    next.baseline = { ...next.baseline, endedOn: previousDate(startedOn) };
  }
  return next;
}

function recordDaily(
  state: AttentionMetricsState,
  phase: AttentionMeasurementPhase,
  timestamp: number,
  patch: Partial<Omit<AttentionDailyCount, 'date'>>,
): AttentionMetricsState {
  const period = state[phase];
  if (!period.startedOn || !Number.isFinite(timestamp)) return state;
  const date = dateKey(timestamp);
  if (date < period.startedOn || (period.endedOn && date > period.endedOn)) return state;
  const index = period.days.findIndex((day) => day.date === date);
  const current = index >= 0
    ? period.days[index]
    : { date, candidates: 0, popups: 0, passthroughPopups: 0, aggregatePopups: 0 };
  const nextDay = {
    ...current,
    candidates: current.candidates + (patch.candidates ?? 0),
    popups: current.popups + (patch.popups ?? 0),
    passthroughPopups: current.passthroughPopups + (patch.passthroughPopups ?? 0),
    aggregatePopups: current.aggregatePopups + (patch.aggregatePopups ?? 0),
  };
  const days = index >= 0
    ? period.days.map((day, dayIndex) => (dayIndex === index ? nextDay : day))
    : [...period.days, nextDay].sort((a, b) => a.date.localeCompare(b.date));
  return { ...state, [phase]: { ...period, days } };
}

function positiveCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function recordNotificationCandidate(
  state: AttentionMetricsState,
  phase: AttentionMeasurementPhase,
  timestamp: number,
  count = 1,
): AttentionMetricsState {
  const delta = positiveCount(count);
  return delta ? recordDaily(state, phase, timestamp, { candidates: delta }) : state;
}

export function recordNotificationPopup(
  state: AttentionMetricsState,
  phase: AttentionMeasurementPhase,
  timestamp: number,
  kind: NotificationPopupKind,
  count = 1,
): AttentionMetricsState {
  const delta = positiveCount(count);
  if (!delta) return state;
  return recordDaily(state, phase, timestamp, {
    popups: delta,
    ...(kind === 'passthrough'
      ? { passthroughPopups: delta }
      : { aggregatePopups: delta }),
  });
}

function periodDays(period: AttentionMeasurementPeriod, asOf: string): number {
  if (!period.startedOn) return 0;
  const end = period.endedOn && period.endedOn < asOf ? period.endedOn : asOf;
  const startTime = Date.parse(`${period.startedOn}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return endTime < startTime ? 0 : Math.floor((endTime - startTime) / 86_400_000) + 1;
}

function popupAverage(
  period: AttentionMeasurementPeriod,
  days: number,
  asOf: string,
): number | null {
  if (!days) return null;
  const end = period.endedOn && period.endedOn < asOf ? period.endedOn : asOf;
  return period.days
    .filter((day) => !!period.startedOn && day.date >= period.startedOn && day.date <= end)
    .reduce((sum, day) => sum + day.popups, 0) / days;
}

export interface AttentionReductionResult {
  baselineDays: number;
  dogfoodDays: number;
  baselineDailyAverage: number | null;
  dogfoodDailyAverage: number | null;
  reductionRate: number | null;
  targetRate: number;
  eligible: boolean;
  targetMet: boolean | null;
}

export function attentionReduction(
  state: AttentionMetricsState,
  asOf: string,
  options: { minimumBaselineDays?: number; minimumDogfoodDays?: number; targetRate?: number } = {},
): AttentionReductionResult {
  const minimumBaselineDays = options.minimumBaselineDays ?? 7;
  const minimumDogfoodDays = options.minimumDogfoodDays ?? 14;
  const targetRate = options.targetRate ?? 0.5;
  const baselineDays = validDateKey(asOf) ? periodDays(state.baseline, asOf) : 0;
  const dogfoodDays = validDateKey(asOf) ? periodDays(state.dogfood, asOf) : 0;
  const baselineDailyAverage = popupAverage(state.baseline, baselineDays, asOf);
  const dogfoodDailyAverage = popupAverage(state.dogfood, dogfoodDays, asOf);
  const reductionRate =
    baselineDailyAverage !== null && baselineDailyAverage > 0 && dogfoodDailyAverage !== null
      ? (baselineDailyAverage - dogfoodDailyAverage) / baselineDailyAverage
      : null;
  const eligible =
    baselineDays >= minimumBaselineDays &&
    dogfoodDays >= minimumDogfoodDays &&
    reductionRate !== null;
  return {
    baselineDays,
    dogfoodDays,
    baselineDailyAverage,
    dogfoodDailyAverage,
    reductionRate,
    targetRate,
    eligible,
    targetMet: eligible ? reductionRate >= targetRate : null,
  };
}

export function notificationAggregationStorageKey(server: string, userId: string): string {
  const normalizedServer = server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
  return `rcx-notification-aggregation-v${NOTIFICATION_AGGREGATION_VERSION}:${encodeURIComponent(normalizedServer)}:${encodeURIComponent(userId)}`;
}

function parseDailyCount(value: unknown): AttentionDailyCount | null {
  if (!value || typeof value !== 'object') return null;
  const day = value as Partial<AttentionDailyCount>;
  if (!validDateKey(day.date)) return null;
  const number = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.floor(input) : 0;
  return {
    date: day.date,
    candidates: number(day.candidates),
    popups: number(day.popups),
    passthroughPopups: number(day.passthroughPopups),
    aggregatePopups: number(day.aggregatePopups),
  };
}

function parsePeriod(value: unknown): AttentionMeasurementPeriod {
  const period = value && typeof value === 'object'
    ? (value as Partial<AttentionMeasurementPeriod>)
    : {};
  return {
    startedOn: validDateKey(period.startedOn) ? period.startedOn : null,
    endedOn: validDateKey(period.endedOn) ? period.endedOn : null,
    days: Array.isArray(period.days)
      ? period.days.map(parseDailyCount).filter((day): day is AttentionDailyCount => !!day)
      : [],
  };
}

function parseBucket(value: unknown): NotificationBucket | null {
  if (!value || typeof value !== 'object') return null;
  const bucket = value as Partial<NotificationBucket>;
  if (
    typeof bucket.roomId !== 'string' ||
    !bucket.roomId ||
    !Array.isArray(bucket.messageIds) ||
    typeof bucket.latestMessageId !== 'string' ||
    !Number.isFinite(bucket.firstAt) ||
    !Number.isFinite(bucket.lastAt) ||
    !Number.isFinite(bucket.expiresAt)
  ) return null;
  const messageIds = bucket.messageIds.filter((id): id is string => typeof id === 'string');
  if (!messageIds.length) return null;
  return {
    roomId: bucket.roomId,
    roomName: typeof bucket.roomName === 'string' ? bucket.roomName : '',
    count: messageIds.length,
    messageIds,
    latestMessageId: bucket.latestMessageId,
    latestSenderName: typeof bucket.latestSenderName === 'string' ? bucket.latestSenderName : '',
    latestText: typeof bucket.latestText === 'string' ? bucket.latestText : '',
    firstAt: bucket.firstAt!,
    lastAt: bucket.lastAt!,
    expiresAt: bucket.expiresAt!,
  };
}

export function parseNotificationAggregationState(
  raw: string | null,
): NotificationAggregationStateV1 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<NotificationAggregationStateV1>;
    if (value.version !== NOTIFICATION_AGGREGATION_VERSION) return null;
    return {
      version: NOTIFICATION_AGGREGATION_VERSION,
      config: normalizeNotificationAggregationConfig(value.config),
      metrics: {
        activePhase:
          value.metrics?.activePhase === 'baseline' || value.metrics?.activePhase === 'dogfood'
            ? value.metrics.activePhase
            : null,
        baseline: parsePeriod(value.metrics?.baseline),
        dogfood: parsePeriod(value.metrics?.dogfood),
      },
      buckets: Array.isArray(value.buckets)
        ? value.buckets.map(parseBucket).filter((bucket): bucket is NotificationBucket => !!bucket)
        : [],
    };
  } catch {
    return null;
  }
}
