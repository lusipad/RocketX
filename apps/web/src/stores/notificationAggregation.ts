import { create } from 'zustand';
import { getServerBase } from '../lib/client';
import {
  addToNotificationBuckets,
  beginAttentionMeasurement,
  defaultNotificationAggregationState,
  flushNotificationBuckets,
  normalizeNotificationAggregationConfig,
  notificationAggregationStorageKey,
  parseNotificationAggregationState,
  recordNotificationCandidate,
  recordNotificationPopup,
  type AttentionMeasurementPhase,
  type NotificationAggregateSummary,
  type NotificationAggregationConfigPatch,
  type NotificationAggregationInput,
  type NotificationAggregationStateV1,
  type NotificationPopupKind,
} from '../lib/notificationAggregation';

interface NotificationAggregationStore {
  ownerId: string | null;
  ownerServer: string | null;
  state: NotificationAggregationStateV1 | null;
  hydrate: (userId: string) => void;
  updateConfig: (patch: NotificationAggregationConfigPatch) => void;
  beginMeasurement: (phase: AttentionMeasurementPhase, startedOn: string) => void;
  recordCandidate: (phase: AttentionMeasurementPhase, timestamp: number, count?: number) => void;
  recordPopup: (
    phase: AttentionMeasurementPhase,
    timestamp: number,
    kind: NotificationPopupKind,
    count?: number,
  ) => void;
  addAggregate: (input: NotificationAggregationInput) => void;
  flushDue: (now: number) => NotificationAggregateSummary[];
  reset: () => void;
}

function persist(
  server: string,
  ownerId: string,
  state: NotificationAggregationStateV1,
): void {
  try {
    localStorage.setItem(
      notificationAggregationStorageKey(server, ownerId),
      JSON.stringify(state),
    );
  } catch {
    /* 无痕模式或存储已满时仅保留当前会话状态 */
  }
}

export const useNotificationAggregation = create<NotificationAggregationStore>((set, get) => {
  const update = (change: (state: NotificationAggregationStateV1) => NotificationAggregationStateV1) => {
    const { ownerId, ownerServer, state } = get();
    if (!ownerId || ownerServer === null || !state) return;
    const next = change(state);
    if (next === state) return;
    persist(ownerServer, ownerId, next);
    set({ state: next });
  };

  return {
    ownerId: null,
    ownerServer: null,
    state: null,

    hydrate: (userId) => {
      const server = getServerBase();
      if (get().ownerId === userId && get().ownerServer === server && get().state) return;
      let state: NotificationAggregationStateV1 | null = null;
      try {
        state = parseNotificationAggregationState(
          localStorage.getItem(notificationAggregationStorageKey(server, userId)),
        );
      } catch {
        /* 使用默认状态 */
      }
      state ??= defaultNotificationAggregationState();
      persist(server, userId, state);
      set({ ownerId: userId, ownerServer: server, state });
    },

    updateConfig: (patch) => update((state) => ({
      ...state,
      config: normalizeNotificationAggregationConfig({
        ...state.config,
        ...patch,
        urgent: { ...state.config.urgent, ...patch.urgent },
      }),
    })),

    beginMeasurement: (phase, startedOn) => update((state) => ({
      ...state,
      metrics: beginAttentionMeasurement(state.metrics, phase, startedOn),
    })),

    recordCandidate: (phase, timestamp, count) => update((state) => ({
      ...state,
      metrics: recordNotificationCandidate(state.metrics, phase, timestamp, count),
    })),

    recordPopup: (phase, timestamp, kind, count) => update((state) => ({
      ...state,
      metrics: recordNotificationPopup(state.metrics, phase, timestamp, kind, count),
    })),

    addAggregate: (input) => update((state) => ({
      ...state,
      buckets: addToNotificationBuckets(
        state.buckets,
        input,
        state.config.windowMinutes,
      ),
    })),

    flushDue: (now) => {
      const state = get().state;
      if (!state) return [];
      const result = flushNotificationBuckets(state.buckets, now);
      if (result.pending.length !== state.buckets.length) {
        update((current) => ({ ...current, buckets: result.pending }));
      }
      return result.summaries;
    },

    reset: () => update(() => defaultNotificationAggregationState()),
  };
});
