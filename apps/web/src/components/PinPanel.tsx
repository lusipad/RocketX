import { useEffect, useMemo, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { PinOff } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';
import PanelShell from './PanelShell';

/** Pin 列表面板：会话中所有被置顶的消息 */
export default function PinPanel() {
  const rid = useChat((s) => s.activeRid);
  const localMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const togglePin = useChat((s) => s.togglePin);
  const [fetched, setFetched] = useState<RcMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    rest
      .getPinnedMessages(rid)
      .then(setFetched)
      .catch(() => setFetched([]))
      .finally(() => setLoading(false));
  }, [rid]);

  // 服务器返回 + 本地实时状态合并。本地 pinned 为显式 false 才移除
  // （历史消息里未置顶的消息 pinned 是 undefined，不能当作「已取消置顶」）
  const pinned = useMemo(() => {
    const map = new Map<string, RcMessage>();
    for (const m of fetched) map.set(m._id, m);
    for (const m of localMessages ?? []) {
      if (m.pinned) map.set(m._id, m);
      else if (m.pinned === false) map.delete(m._id);
    }
    return [...map.values()].sort((a, b) => tsMs(b.ts) - tsMs(a.ts));
  }, [fetched, localMessages]);

  return (
    <PanelShell title={`置顶消息${pinned.length ? `（${pinned.length}）` : ''}`}>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && <div className="py-8 text-center text-sm text-ink-3">加载中…</div>}
        {!loading && pinned.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            暂无置顶消息
            <div className="mt-1 text-xs">右键消息或悬浮菜单中选择「置顶」</div>
          </div>
        )}
        {pinned.map((m) => (
          <div
            key={m._id}
            className="group mb-2 rounded-lg border border-line p-3 transition hover:border-primary"
          >
            <div className="flex items-center gap-2">
              <Avatar name={m.u.name || m.u.username} username={m.u.username} size={24} />
              <span className="text-xs font-medium text-ink">{m.u.name || m.u.username}</span>
              <span className="text-xs text-ink-3">{fmtConvTime(tsMs(m.ts))}</span>
              <button
                title="取消置顶"
                onClick={() => void togglePin(m)}
                className="ml-auto hidden h-6 w-6 items-center justify-center rounded text-ink-3 group-hover:flex hover:bg-fill-hover hover:text-danger"
              >
                <PinOff size={13} />
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
