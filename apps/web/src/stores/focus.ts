import { create } from 'zustand';
import { rest } from '../lib/client';
import { isPresenceStatus, type PresenceStatus } from '../lib/presencePreference';
import {
  DEFAULT_NOTIFICATION_AGGREGATION_CONFIG,
  type NotificationAggregationConfig,
  type NotificationAggregationInput,
} from '../lib/notificationAggregation';
import { useAuth } from './auth';
import { toast } from './toast';

/**
 * 专注模式（daily-loop 规格 v1）：一级入口发起的专注会话。
 *
 * - 通知：会话期间强制复用禅模式聚合规则（穿透白名单照常生效），见 chat.ts notifyIfNeeded；
 * - 状态：进入时切 busy，结束时恢复进入前的状态。专注驱动的切换不写本机显式偏好
 *   （savePresencePreference 是「下次启动恢复什么」的语义）；应用重启即会话结束，
 *   残留状态由启动时的 startupPresence 自愈（stores/auth.ts）；
 * - 会话与统计只存内存：重启按「已结束」处理（规格 §9），攒桶数据在聚合存储里仍在。
 */

export interface FocusSession {
  startedAt: number;
  /** null = 不限时，手动结束 */
  endsAt: number | null;
  /** 进入前的在线状态，结束时恢复 */
  prevStatus: PresenceStatus;
}

/** 本次专注期间的通知路由统计（消化卡片的数据来源） */
export interface FocusStats {
  /** 被攒进聚合桶、没有打断的消息数 */
  aggregated: number;
  /** 攒下消息涉及的会话 */
  roomIds: string[];
  /** 穿透的 @我 消息数 */
  mentionPassthrough: number;
  /** 其他穿透（私聊/关键词/P1 等）数 */
  otherPassthrough: number;
}

export interface FocusDigest {
  endedAt: number;
  durationMinutes: number;
  stats: FocusStats;
}

export function emptyFocusStats(): FocusStats {
  return { aggregated: 0, roomIds: [], mentionPassthrough: 0, otherPassthrough: 0 };
}

/** 专注期间的路由配置：沿用禅模式的穿透规则，只是把聚合临时强制打开 */
export function focusAggregationConfig(
  base: NotificationAggregationConfig | null,
): NotificationAggregationConfig {
  return { ...(base ?? DEFAULT_NOTIFICATION_AGGREGATION_CONFIG), enabled: true };
}

interface FocusStoreState {
  session: FocusSession | null;
  stats: FocusStats;
  /** 会话结束后的消化卡数据；关闭卡片即清空 */
  digest: FocusDigest | null;
  /** 开始专注；minutes 为 null 表示不限时。已有会话时是 no-op */
  start: (minutes: number | null) => Promise<void>;
  /** 结束专注：恢复状态并生成消化卡 */
  end: () => Promise<void>;
  /** 延长会话（不限时的会话从当前时刻起算） */
  extend: (minutes: number) => void;
  noteAggregated: (input: NotificationAggregationInput) => void;
  notePassthrough: (input: NotificationAggregationInput) => void;
  dismissDigest: () => void;
}

/** 到点自动结束的计时器；会话唯一，模块级一份即可 */
let timer: ReturnType<typeof setTimeout> | null = null;

function armTimer(endsAt: number, end: () => Promise<void>): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void end();
  }, Math.max(0, endsAt - Date.now()));
}

export const useFocus = create<FocusStoreState>((set, get) => ({
  session: null,
  stats: emptyFocusStats(),
  digest: null,

  start: async (minutes) => {
    if (get().session) return;
    const user = useAuth.getState().user;
    const prevStatus: PresenceStatus = isPresenceStatus(user?.status) ? user.status : 'online';
    const startedAt = Date.now();
    const endsAt = minutes === null ? null : startedAt + minutes * 60_000;
    set({ session: { startedAt, endsAt, prevStatus }, stats: emptyFocusStats(), digest: null });
    if (endsAt !== null) armTimer(endsAt, get().end);
    // 状态切换失败不阻断专注：通知聚合是本机行为，busy 只是给别人的信号
    await rest.setStatus('busy').catch((err) => {
      toast.error(err, '状态切换失败');
    });
  },

  end: async () => {
    const { session, stats } = get();
    if (!session) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    set({
      session: null,
      digest: {
        endedAt: Date.now(),
        durationMinutes: Math.max(1, Math.round((Date.now() - session.startedAt) / 60_000)),
        stats,
      },
    });
    await rest.setStatus(session.prevStatus).catch((err) => {
      toast.error(err, '状态恢复失败');
    });
  },

  extend: (minutes) => {
    const { session } = get();
    if (!session) return;
    const endsAt = (session.endsAt ?? Date.now()) + minutes * 60_000;
    armTimer(endsAt, get().end);
    set({ session: { ...session, endsAt } });
  },

  noteAggregated: (input) => {
    const { session, stats } = get();
    if (!session) return;
    set({
      stats: {
        ...stats,
        aggregated: stats.aggregated + 1,
        roomIds: stats.roomIds.includes(input.roomId)
          ? stats.roomIds
          : [...stats.roomIds, input.roomId],
      },
    });
  },

  notePassthrough: (input) => {
    const { session, stats } = get();
    if (!session) return;
    set({
      stats: input.directMention
        ? { ...stats, mentionPassthrough: stats.mentionPassthrough + 1 }
        : { ...stats, otherPassthrough: stats.otherPassthrough + 1 },
    });
  },

  dismissDigest: () => set({ digest: null }),
}));
