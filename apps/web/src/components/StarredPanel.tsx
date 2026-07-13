import { useEffect, useMemo, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { AlertCircle, StarOff } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { humanError } from '../stores/toast';
import PanelShell from './PanelShell';
import MessageResultRow from './MessageResultRow';
import { SkeletonRows } from './Skeleton';

/** 标记（星标）消息面板：点击跳转到原消息，悬停可取消标记 */
export default function StarredPanel() {
  const rid = useChat((s) => s.activeRid);
  const localMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const toggleStar = useChat((s) => s.toggleStar);
  const myId = useAuth((s) => s.user?._id);
  const [fetched, setFetched] = useState<RcMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError(null);
    rest
      .getStarredMessages(rid)
      .then(setFetched)
      .catch((err: unknown) => {
        setFetched([]);
        setError(humanError(err, '无法获取标记消息'));
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

  return (
    <PanelShell title={`标记消息${starred.length ? `（${starred.length}）` : ''}`}>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && <SkeletonRows rows={3} />}
        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="max-w-xs text-xs break-words text-ink-3">{error}</div>
          </div>
        )}
        {!loading && !error && starred.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">
            暂无标记消息
            <div className="mt-1 text-xs">右键消息选择「标记」，重要内容不再丢失</div>
          </div>
        )}
        {!loading &&
          !error &&
          starred.map((m) => (
            <MessageResultRow
              key={m._id}
              message={m}
              action={
                <button
                  title="取消标记"
                  onClick={() => void toggleStar(m)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-surface-4 text-ink-3 transition hover:bg-fill-hover hover:text-danger"
                >
                  <StarOff size={13} />
                </button>
              }
            />
          ))}
      </div>
    </PanelShell>
  );
}
