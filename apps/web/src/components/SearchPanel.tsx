import { useEffect, useRef, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { Search } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';
import PanelShell from './PanelShell';

/** 聊天记录搜索面板（当前会话） */
export default function SearchPanel() {
  const rid = useChat((s) => s.activeRid);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<RcMessage[]>([]);
  const [searching, setSearching] = useState(false);
  const [touched, setTouched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!rid) return;
    if (timer.current) clearTimeout(timer.current);
    const q = keyword.trim();
    if (!q) {
      setResults([]);
      setTouched(false);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      rest
        .searchMessages(rid, q)
        .then((msgs) => {
          setResults(msgs.sort((a, b) => tsMs(b.ts) - tsMs(a.ts)));
          setTouched(true);
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, rid]);

  return (
    <PanelShell title="搜索聊天记录">
      <div className="p-3">
        <div className="flex h-9 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索当前会话的消息"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {searching && <div className="py-8 text-center text-sm text-ink-3">搜索中…</div>}
        {!searching && touched && results.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">没有找到相关消息</div>
        )}
        {!searching &&
          results.map((m) => (
            <div key={m._id} className="mb-2 rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <Avatar name={m.u.name || m.u.username} username={m.u.username} size={24} />
                <span className="text-xs font-medium text-ink">{m.u.name || m.u.username}</span>
                <span className="ml-auto text-xs text-ink-3">{fmtConvTime(tsMs(m.ts))}</span>
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
