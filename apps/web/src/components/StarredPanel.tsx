import { useEffect, useMemo, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { AlertCircle, StarOff } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { humanError } from '../stores/toast';
import { useT } from '../i18n';
import PanelShell from './PanelShell';
import MessageResultRow from './MessageResultRow';
import { SkeletonRows } from './Skeleton';

/** 标记（星标）消息面板：点击跳转到原消息，悬停可取消标记 */
export default function StarredPanel() {
  const t = useT();
  const rid = useChat((s) => s.activeRid);
  const localMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const toggleStar = useChat((s) => s.toggleStar);
  const myId = useAuth((s) => s.user?._id);
  const [fetched, setFetched] = useState<RcMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ raw: unknown } | null>(null);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError(null);
    rest
      .getStarredMessages(rid)
      .then(setFetched)
      .catch((err: unknown) => {
        setFetched([]);
        setError({ raw: err });
      })
      .finally(() => setLoading(false));
  }, [rid]);

  const starred = useMemo(() => {
    const isStarredByMe = (m: RcMessage) => m.starred?.some((s) => s._id === myId);
    const map = new Map<string, RcMessage>();
    for (const m of fetched) map.set(m._id, m);
    for (const m of localMessages ?? []) {
      if (isStarredByMe(m)) map.set(m._id, m);
      else if (m.starred && !isStarredByMe(m)) map.delete(m._id);
    }
    return [...map.values()].sort((a, b) => tsMs(b.ts) - tsMs(a.ts));
  }, [fetched, localMessages, myId]);

  const errorMessage = error ? humanError(error.raw, t('panels.starred.loadFailed')) : null;

  return (
    <PanelShell
      title={
        starred.length
          ? t('panels.starred.titleWithCount', { count: starred.length })
          : t('panels.starred.title')
      }
    >
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && <SkeletonRows rows={3} />}
        {!loading && errorMessage && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="max-w-xs text-xs break-words text-ink-3">{errorMessage}</div>
          </div>
        )}
        {!loading && !errorMessage && starred.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">
            {t('panels.starred.empty')}
            <div className="mt-1 text-xs">{t('panels.starred.emptyHint')}</div>
          </div>
        )}
        {!loading &&
          !errorMessage &&
          starred.map((m) => (
            <MessageResultRow
              key={m._id}
              message={m}
              action={
                <button
                  title={t('panels.starred.unstar')}
                  onClick={() => void toggleStar(m)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-surface-4 text-ink-3 transition hover:bg-fill-hover hover:text-danger"
                >
                  <StarOff size={14} />
                </button>
              }
            />
          ))}
      </div>
    </PanelShell>
  );
}
