import { useEffect, useMemo, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { StarOff } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';
import PanelShell from './PanelShell';

/** 标记（星标）消息面板 */
export default function StarredPanel() {
  const rid = useChat((s) => s.activeRid);
  const localMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const toggleStar = useChat((s) => s.toggleStar);
  const myId = useAuth((s) => s.user?._id);
  const [fetched, setFetched] = useState<RcMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    rest
      .getStarredMessages(rid)
      .then(setFetched)
      .catch(() => setFetched([]))
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
        {loading && <div className="py-8 text-center text-sm text-ink-3">加载中…</div>}
        {!loading && starred.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            暂无标记消息
            <div className="mt-1 text-xs">右键消息选择「标记」，重要内容不再丢失</div>
          </div>
        )}
        {starred.map((m) => (
          <div
            key={m._id}
            className="group mb-2 rounded-lg border border-line p-3 transition hover:border-primary"
          >
            <div className="flex items-center gap-2">
              <Avatar name={m.u.name || m.u.username} username={m.u.username} size={24} />
              <span className="text-xs font-medium text-ink">{m.u.name || m.u.username}</span>
              <span className="text-xs text-ink-3">{fmtConvTime(tsMs(m.ts))}</span>
              <button
                title="取消标记"
                onClick={() => void toggleStar(m)}
                className="ml-auto hidden h-6 w-6 items-center justify-center rounded text-ink-3 group-hover:flex hover:bg-fill-hover hover:text-danger"
              >
                <StarOff size={13} />
              </button>
            </div>
            <div className="mt-1.5 line-clamp-3 text-sm break-words text-ink-2">
              {m.msg || m.attachments?.[0]?.title || '[卡片消息]'}
            </div>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}
