import { useEffect, useMemo, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { AlertCircle, PinOff } from 'lucide-react';
import { useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import { useT } from '../i18n';
import PanelShell from './PanelShell';
import MessageResultRow from './MessageResultRow';
import { SkeletonRows } from './Skeleton';

/** 置顶消息面板：点击跳转到原消息，悬停可取消置顶 */
export default function PinPanel() {
  const t = useT();
  const rid = useChat((s) => s.activeRid);
  const localMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const togglePin = useChat((s) => s.togglePin);
  const reconcilePinned = useChat((s) => s.reconcilePinned);
  const [fetched, setFetched] = useState<RcMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ raw: unknown } | null>(null);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError(null);
    // 顺带把消息列表里的 pinned 标志同步成服务端状态——右键菜单的
    // 「取消置顶」入口靠这个标志显示（issue #19-5）
    reconcilePinned(rid)
      .then(setFetched)
      .catch((err: unknown) => {
        setFetched([]);
        setError({ raw: err });
      })
      .finally(() => setLoading(false));
  }, [rid, reconcilePinned]);

  // 服务器返回 + 本地实时状态合并（本地 pinned 显式为 false 才移除）
  const pinned = useMemo(() => {
    const map = new Map<string, RcMessage>();
    for (const m of fetched) map.set(m._id, m);
    for (const m of localMessages ?? []) {
      if (m.pinned) map.set(m._id, m);
      else if (m.pinned === false) map.delete(m._id);
    }
    return [...map.values()].sort((a, b) => tsMs(b.ts) - tsMs(a.ts));
  }, [fetched, localMessages]);

  const errorMessage = error ? humanError(error.raw, t('panels.pin.loadFailed')) : null;

  return (
    <PanelShell
      title={
        pinned.length
          ? t('panels.pin.titleWithCount', { count: pinned.length })
          : t('panels.pin.title')
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
        {!loading && !errorMessage && pinned.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">
            {t('panels.pin.empty')}
            <div className="mt-1 text-xs">{t('panels.pin.emptyHint')}</div>
          </div>
        )}
        {!loading &&
          !errorMessage &&
          pinned.map((m) => (
            <MessageResultRow
              key={m._id}
              message={m}
              action={
                <button
                  title={t('panels.pin.unpin')}
                  onClick={() => void togglePin(m)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-surface-4 text-ink-3 transition hover:bg-fill-hover hover:text-danger"
                >
                  <PinOff size={14} />
                </button>
              }
            />
          ))}
      </div>
    </PanelShell>
  );
}
