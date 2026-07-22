import { useEffect, useMemo, useState } from 'react';
import { FileText, Reply, X } from 'lucide-react';
import { useChat } from '../stores/chat';
import { stripAgentSessionMarker } from '../agent/card';
import { stripQuotePrefix } from '../lib/messageText';
import { useDialogBehavior } from './Dialog';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 粘贴/拖拽文件后的发送确认弹窗（飞书交互：先预览再发送） */
export default function UploadConfirm({ caption, onSent }: { caption?: string; onSent?: () => void }) {
  const pendingFiles = useChat((s) => s.pendingFiles);
  const pendingUploadMessage = useChat((s) => s.pendingUploadMessage);
  const confirmUpload = useChat((s) => s.confirmUpload);
  const cancelUpload = useChat((s) => s.cancelUpload);
  const replyTo = useChat((s) => s.replyTo);
  const sub = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid] : undefined));
  const [busy, setBusy] = useState(false);
  const name = sub?.fname || sub?.name || '当前会话';
  const dialogRef = useDialogBehavior(cancelUpload, !!pendingFiles);
  const message = pendingUploadMessage ?? caption;

  const previews = useMemo(
    () =>
      (pendingFiles ?? []).map((f) => ({
        file: f,
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      })),
    [pendingFiles],
  );

  useEffect(
    () => () => previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)),
    [previews],
  );

  const sendPending = async () => {
    setBusy(true);
    try {
      if (await confirmUpload(message)) onSent?.();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pendingFiles) return;
      if (e.key === 'Escape') cancelUpload();
      if (e.key === 'Enter') {
        e.preventDefault();
        void sendPending();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingFiles, cancelUpload, confirmUpload]);

  if (!pendingFiles) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`发送文件给 ${name}`}
        tabIndex={-1}
        className="w-[420px] rounded-xl bg-surface-4 shadow-2xl"
      >
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[15px] font-semibold text-ink">发送给 {name}</span>
          <button
            onClick={cancelUpload}
            aria-label="关闭文件发送确认"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 hover:bg-fill-hover"
          >
            <X size={16} />
          </button>
        </header>

        {replyTo && (
          <div className="mx-5 mb-1 flex items-center gap-1.5 truncate rounded bg-fill-1 px-2.5 py-1.5 text-xs text-ink-3">
            <Reply size={13} className="shrink-0" />
            <span className="truncate">
              将作为回复发送 · {replyTo.u.name || replyTo.u.username}：
              {stripQuotePrefix(stripAgentSessionMarker(replyTo.msg ?? '')) || '[卡片消息]'}
            </span>
          </div>
        )}
        {message?.trim() && (
          <div className="mx-5 mb-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-fill-1 px-2.5 py-2 text-sm text-ink">
            {message.trim()}
          </div>
        )}
        <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto px-5 py-2">
          {previews.map(({ file, url }, i) => (
            <div
              key={i}
              className="flex h-24 flex-col items-center justify-center overflow-hidden rounded-lg border border-line bg-fill-2"
            >
              {url ? (
                <img src={url} alt={file.name} className="h-full w-full object-cover" />
              ) : (
                <>
                  <FileText size={22} className="mb-1 text-ink-3" />
                  <span className="max-w-full truncate px-2 text-2xs text-ink-2">
                    {file.name}
                  </span>
                  <span className="text-2xs text-ink-3">{fmtSize(file.size)}</span>
                </>
              )}
            </div>
          ))}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">
          <button
            onClick={cancelUpload}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void sendPending()}
            disabled={busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
          >
            {busy ? '发送中…' : `发送（${pendingFiles.length}）`}
          </button>
        </footer>
      </div>
    </div>
  );
}
