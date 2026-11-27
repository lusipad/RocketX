import { useSyncExternalStore } from 'react';
import { getLocale, t, type MessageKey } from '../i18n';
import { formatDate } from '../i18n/format';

const WEEKDAY_KEYS: readonly MessageKey[] = [
  'nav.date.weekday.0',
  'nav.date.weekday.1',
  'nav.date.weekday.2',
  'nav.date.weekday.3',
  'nav.date.weekday.4',
  'nav.date.weekday.5',
  'nav.date.weekday.6',
];

function weekdayLabel(dayIndex: number): string {
  return t(WEEKDAY_KEYS[dayIndex] ?? 'nav.date.weekday.0');
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * 「今天 / 昨天」这类相对日期是渲染那一刻算出来的。
 * 挂着不关的窗口跨过零点后，昨天的消息还写着「今天」——所以到点主动重算一次。
 * 全局共用一个定时器，只在日界跳变，不是每分钟空转。
 */
const dayListeners = new Set<() => void>();
let currentDay = startOfDay(Date.now());
let dayTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDayTick(): void {
  if (dayTimer) clearTimeout(dayTimer);
  // +1s 容错，避免定时器早到导致仍算在前一天
  const delay = currentDay + DAY - Date.now() + 1000;
  dayTimer = setTimeout(() => {
    currentDay = startOfDay(Date.now());
    for (const l of dayListeners) l();
    scheduleDayTick();
  }, Math.max(delay, 1000));
}

/** 订阅日界跳变：跨过零点后组件重渲染，相对日期随之刷新 */
export function useDayTick(): number {
  return useSyncExternalStore(
    (cb) => {
      dayListeners.add(cb);
      if (dayListeners.size === 1) scheduleDayTick();
      return () => {
        dayListeners.delete(cb);
        if (dayListeners.size === 0 && dayTimer) {
          clearTimeout(dayTimer);
          dayTimer = null;
        }
      };
    },
    () => currentDay,
    () => currentDay,
  );
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 会话列表时间：今天→HH:mm，昨天→昨天，7 天内→周X，更早→YYYY/M/D */
export function fmtConvTime(ms: number): string {
  if (!ms) return '';
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  if (day === today) return fmtTime(ms);
  if (day === today - DAY) return t('nav.date.yesterday');
  if (day > today - 7 * DAY) return weekdayLabel(new Date(ms).getDay());
  const d = new Date(ms);
  if (getLocale() === 'zh-CN') {
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  return formatDate(ms);
}

/** 消息区日期分割线：今天 / 昨天 / M月D日 周X */
export function fmtDayDivider(ms: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  if (day === today) return t('nav.date.today');
  if (day === today - DAY) return t('nav.date.yesterday');
  const d = new Date(ms);
  if (getLocale() === 'zh-CN') {
    const base = `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayLabel(d.getDay())}`;
    return d.getFullYear() === new Date().getFullYear() ? base : `${d.getFullYear()}年${base}`;
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return formatDate(
    ms,
    sameYear
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' },
  );
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 系统消息文案（Rocket.Chat 消息的 t 字段） */
const ROOM_ROLE_LABEL_KEYS: Record<string, MessageKey> = {
  owner: 'nav.systemMsg.role.owner',
  moderator: 'nav.systemMsg.role.moderator',
  leader: 'nav.systemMsg.role.leader',
};

const SYSTEM_MESSAGES: Record<string, (user: string, msg: string, role?: string) => string> = {
  uj: (u) => t('nav.systemMsg.uj', { user: u }),
  ul: (u) => t('nav.systemMsg.ul', { user: u }),
  ru: (u, m) => t('nav.systemMsg.ru', { user: u, target: m }),
  au: (u, m) => t('nav.systemMsg.au', { user: u, target: m }),
  r: (u, m) => t('nav.systemMsg.r', { user: u, name: m }),
  'message_pinned': (u) => t('nav.systemMsg.messagePinned', { user: u }),
  'room_changed_topic': (u, m) => t('nav.systemMsg.roomChangedTopic', { user: u, topic: m }),
  'room_changed_description': (u) => t('nav.systemMsg.roomChangedDescription', { user: u }),
  'room_changed_announcement': (u) => t('nav.systemMsg.roomChangedAnnouncement', { user: u }),
  'subscription-role-added': (_u, m, role) => {
    const roleKey = role ? ROOM_ROLE_LABEL_KEYS[role] : undefined;
    return roleKey
      ? t('nav.systemMsg.roleAdded', { target: m, role: t(roleKey) })
      : t('nav.systemMsg.roleUpdated', { target: m });
  },
  'ut': (u) => t('nav.systemMsg.ut', { user: u }),
  'wm': (u) => t('nav.systemMsg.wm', { user: u }),
  // 正常情况下这条会被 DiscussionCard 拦下渲染成卡片，
  // 这里兜的是极少数没有 drid 的脏数据（讨论房间被删了）
  'discussion-created': (u, m) => t('nav.systemMsg.discussionCreated', { user: u, title: m }),
};

export function systemMessageText(type: string, username: string, msg: string, role?: string): string {
  const fn = SYSTEM_MESSAGES[type];
  return fn ? fn(username, msg, role) : `${username} ${type} ${msg}`.trim();
}

/** 字节数 → 人话（消息里的文件卡片和文件面板共用） */
export function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { emojiFromShortcode } from './emoji';
