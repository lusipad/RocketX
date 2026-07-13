import { useEffect, useRef, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { AlertCircle, Search } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import PanelShell from './PanelShell';
import MessageResultRow from './MessageResultRow';
import { SkeletonRows } from './Skeleton';

/** 聊天记录搜索面板（当前会话），结果可点击跳转 */
export default function SearchPanel() {
  const rid = useChat((s) => s.activeRid);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<RcMessage[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!rid) return;
    if (timer.current) clearTimeout(timer.current);
    const q = keyword.trim();
    if (!q) {
      setResults([]);
      setTouched(false);
      setError(null);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      setError(null);
      rest
        .searchMessages(rid, q)
        .then((msgs) => {
          setResults(msgs.sort((a, b) => tsMs(b.ts) - tsMs(a.ts)));
          setTouched(true);
        })
        .catch((err: unknown) => {
          setResults([]);
          setError(humanError(err, '搜索失败'));
        })
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
        {searching && <SkeletonRows rows={3} />}
        {!searching && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="text-sm text-danger">搜索失败</div>
            <div className="max-w-xs text-xs break-words text-ink-3">{error}</div>
          </div>
        )}
        {!searching && !error && touched && results.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">
            没有找到相关消息
            <div className="mt-1 text-xs">中文搜索需要服务端开启正则搜索</div>
          </div>
        )}
        {!searching && !error && !touched && (
          <div className="py-10 text-center text-sm text-ink-3">输入关键词搜索本会话的消息</div>
        )}
        {!searching &&
          !error &&
          results.map((m) => <MessageResultRow key={m._id} message={m} highlight={keyword} />)}
      </div>
    </PanelShell>
  );
}
