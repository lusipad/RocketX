import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FileText, Reply, X } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useT } from '../i18n';
import { stripAgentSessionMarker } from '../agent/card';
import { stripQuotePrefix } from '../lib/messageText';
import { shouldSendMessage } from '../lib/sendKeys';
import { usePrefs } from '../stores/prefs';
import { useDialogBehavior } from './Dialog';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 粘贴/拖拽文件后的发送确认弹窗（飞书交互：先预览再发送） */
export default function UploadConfirm({ caption, onSent }: { caption?: string; onSent?: () => void }) {
  const t = useT();
  const pendingFiles = useChat((s) => s.pendingFiles);
  const pendingUploadMessage = useChat((s) => s.pendingUploadMessage);
  const confirmUpload = useChat((s) => s.confirmUpload);
  const cancelUpload = useChat((s) => s.cancelUpload);
  const replyTo = useChat((s) => s.replyTo);
  const sub = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid] : undefined));
  const prefsLoaded = usePrefs((s) => s.loaded);
  const sendOnEnter = usePrefs((s) => s.prefs.sendOnEnter);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const name = sub?.fname || sub?.name || t('chat.common.currentConversation');
  const dialogRef = useDialogBehavior(cancelUpload, !!pendingFiles);

  useEffect(() => {
    if (pendingFiles) setMessage(pendingUploadMessage ?? caption ?? '');
  }, [pendingFiles, pendingUploadMessage, caption]);

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
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingFiles, cancelUpload, confirmUpload]);

  const onMessageKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (shouldSendMessage(prefsLoaded ? sendOnEnter : 'normal', event)) {
      event.preventDefault();
      void sendPending();
    }
  };

  if (!pendingFiles) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.uploadConfirm.dialogAria', { name })}
        tabIndex={-1}
        className="w-[420px] rounded-xl bg-surface-4 shadow-2xl"
      >
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-base font-semibold text-ink">{t('chat.uploadConfirm.title', { name })}</span>
          <button
            onClick={cancelUpload}
            aria-label={t('chat.uploadConfirm.closeAria')}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 hover:bg-fill-hover"
          >
            <X size={16} />
          </button>
        </header>

        {replyTo && (
          <div className="mx-5 mb-1 flex items-center gap-1.5 truncate rounded bg-fill-1 px-2.5 py-1.5 text-xs text-ink-3">
            <Reply size={14} className="shrink-0" />
            <span className="truncate">
              {t('chat.uploadConfirm.replyPreview', {
                author: replyTo.u.name || replyTo.u.username,
                text:
                  stripQuotePrefix(stripAgentSessionMarker(replyTo.msg ?? '')) ||
                  t('chat.projection.cardMessage'),
              })}

            </span>
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
                  <span className="max-w-full truncate px-2 text-xs text-ink-2">
                    {file.name}
                  </span>
                  <span className="text-xs text-ink-3">{fmtSize(file.size)}</span>
                </>
              )}
            </div>
          ))}
        </div>

        <textarea
          autoFocus
          aria-label={t('chat.uploadConfirm.captionAria')}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onMessageKeyDown}
          rows={3}
          placeholder={t('chat.uploadConfirm.captionPlaceholder')}
          className="mx-5 mb-3 block w-[calc(100%-2.5rem)] resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-primary"
        />

        <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">
          <button
            onClick={cancelUpload}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void sendPending()}
            disabled={busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
          >
            {busy ? t('chat.forward.sending') : t('chat.uploadConfirm.sendCount', { count: pendingFiles.length })}
          </button>
        </footer>
      </div>
    </div>
  );
}
