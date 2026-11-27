import { useEffect, useState } from 'react';
import { t as i18nT, useI18n } from '../i18n';
import Dialog from './Dialog';
import { useFocus } from '../stores/focus';

const DURATIONS = [25, 50, 90] as const;

/** 每秒刷新的当前时刻；active 为 false 时不启动计时器 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** 剩余时间 mm:ss；不限时返回占位文案 */
export function formatRemaining(endsAt: number | null, now: number): string {
  if (endsAt === null) return i18nT('nav.focus.unlimited');
  const remain = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const minutes = Math.floor(remain / 60);
  const seconds = remain % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 专注模式一级入口的弹窗（daily-loop 规格 v1）：
 * 未开始 → 选时长；进行中 → 倒计时 + 已攒统计 + 延长/提前结束。
 */
export default function FocusDialog({ onClose }: { onClose: () => void }) {
  const { t, tp } = useI18n();
  const session = useFocus((s) => s.session);
  const stats = useFocus((s) => s.stats);
  const start = useFocus((s) => s.start);
  const end = useFocus((s) => s.end);
  const extend = useFocus((s) => s.extend);
  const now = useNow(!!session);

  return (
    <Dialog
      title={session ? t('nav.focus.activeTitle') : t('nav.focus.startTitle')}
      hint={session ? undefined : t('nav.focus.hint')}
      width={360}
      onClose={onClose}
      footer={
        session ? (
          <>
            <button
              onClick={() => extend(25)}
              className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
            >
              {t('nav.focus.extend25')}
            </button>
            <button
              onClick={() => {
                void end();
                onClose();
              }}
              className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:opacity-90"
            >
              {t('nav.focus.end')}
            </button>
          </>
        ) : undefined
      }
    >
      {session ? (
        <div className="px-5 pb-3">
          <div className="text-3xl font-semibold tabular-nums text-ink">
            {formatRemaining(session.endsAt, now)}
          </div>
          <div className="mt-2 text-xs leading-relaxed text-ink-3">
            {tp(stats.aggregated, 'nav.focus.statsAggregatedOne', 'nav.focus.statsAggregatedOther')}
            {stats.roomIds.length > 0
              ? tp(stats.roomIds.length, 'nav.focus.statsRoomsOne', 'nav.focus.statsRoomsOther')
              : ''}
            {stats.mentionPassthrough > 0
              ? tp(stats.mentionPassthrough, 'nav.focus.statsMentionsOne', 'nav.focus.statsMentionsOther')
              : ''}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 px-5 pb-4">
          {DURATIONS.map((minutes) => (
            <button
              key={minutes}
              onClick={() => {
                void start(minutes);
                onClose();
              }}
              className="h-9 min-w-20 flex-1 rounded-md border border-line text-sm text-ink transition hover:bg-fill-hover"
            >
              {t('nav.focus.minutes', { minutes })}
            </button>
          ))}
          <button
            onClick={() => {
              void start(null);
              onClose();
            }}
            className="h-9 w-full rounded-md border border-line text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            {t('nav.focus.unlimitedManual')}
          </button>
        </div>
      )}
    </Dialog>
  );
}
