import { useEffect, useRef, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { AlertCircle, Search } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import { settleScopedResult } from '../lib/scopedResult';
import { useT } from '../i18n';
import PanelShell from './PanelShell';
import MessageResultRow from './MessageResultRow';
import { SkeletonRows } from './Skeleton';

/** 聊天记录搜索面板（当前会话），结果可点击跳转 */
export default function SearchPanel() {
  const t = useT();
  const rid = useChat((s) => s.activeRid);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<RcMessage[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<{ raw: unknown } | null>(null);
  const [touched, setTouched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let current = true;
    if (!rid) {
      setSearching(false);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    const q = keyword.trim();
    if (!q) {
      setResults([]);
      setTouched(false);
      setError(null);
      setSearching(false);
      return;
    }
    setResults([]);
    setTouched(false);
    setError(null);
    setSearching(true);
    timer.current = setTimeout(() => {
      void settleScopedResult(
        () => rest.searchMessages(rid, q),
        {
          success: (msgs) => {
            setResults(msgs.sort((a, b) => tsMs(b.ts) - tsMs(a.ts)));
            setTouched(true);
          },
          error: (err) => {
            setResults([]);
            setError({ raw: err });
          },
          complete: () => setSearching(false),
        },
        () => current && useChat.getState().activeRid === rid,
      );
    }, 300);
    return () => {
      current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, rid]);

  const errorMessage = error ? humanError(error.raw, t('panels.search.failed')) : null;

  return (
    <PanelShell title={t('panels.search.title')}>
      <div className="p-3">
        <div className="flex h-9 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('panels.search.placeholder')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {searching && <SkeletonRows rows={3} />}
        {!searching && errorMessage && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="text-sm text-danger">{t('panels.search.failed')}</div>
            <div className="max-w-xs text-xs break-words text-ink-3">{errorMessage}</div>
          </div>
        )}
        {!searching && !errorMessage && touched && results.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">
            {t('panels.search.noResults')}
            <div className="mt-1 text-xs">{t('panels.search.noResultsHint')}</div>
          </div>
        )}
        {!searching && !errorMessage && !touched && (
          <div className="py-10 text-center text-sm text-ink-3">{t('panels.search.prompt')}</div>
        )}
        {!searching &&
          !errorMessage &&
          results.map((m) => <MessageResultRow key={m._id} message={m} highlight={keyword} />)}
      </div>
    </PanelShell>
  );
}
