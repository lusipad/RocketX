import { useI18n } from '../i18n';
import { useFocus } from '../stores/focus';
import { useUI } from '../stores/ui';

/**
 * 专注结束的消化卡片（daily-loop 规格 v1）：
 * 报告本次专注攒下/穿透的消息数；「去处理」跳到消息模块。
 * v2 会把这里接入消化清单做批量处理。
 */
export default function FocusDigestCard() {
  const { t, tp } = useI18n();
  const digest = useFocus((s) => s.digest);
  const dismiss = useFocus((s) => s.dismissDigest);
  const setModule = useUI((s) => s.setModule);
  if (!digest) return null;

  const { stats } = digest;
  const penetrated = stats.mentionPassthrough + stats.otherPassthrough;

  return (
    <div className="fixed right-4 bottom-4 z-40 w-72 rounded-xl bg-surface-4 p-4 shadow-2xl">
      <div className="text-sm font-semibold text-ink">
        {tp(digest.durationMinutes, 'nav.focusDigest.titleOne', 'nav.focusDigest.titleOther')}
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-ink-2">
        {stats.aggregated > 0
          ? tp(stats.aggregated, 'nav.focusDigest.queuedOne', 'nav.focusDigest.queuedOther', {
              rooms: tp(stats.roomIds.length, 'nav.focusDigest.roomsOne', 'nav.focusDigest.roomsOther'),
            })
          : t('nav.focusDigest.noneQueued')}
        {penetrated > 0
          ? tp(penetrated, 'nav.focusDigest.penetratedOne', 'nav.focusDigest.penetratedOther')
          : ''}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={dismiss}
          className="h-7 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover"
        >
          {t('nav.focusDigest.gotIt')}
        </button>
        {stats.aggregated > 0 && (
          <button
            onClick={() => {
              setModule('messages');
              dismiss();
            }}
            className="h-7 rounded-md bg-primary px-3 text-xs text-white transition hover:opacity-90"
          >
            {t('nav.focusDigest.reviewInMessages')}
          </button>
        )}
      </div>
    </div>
  );
}
