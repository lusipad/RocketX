import { useState } from 'react';
import { Download, FileText, FolderOpen, Trash2 } from 'lucide-react';
import { useDownloadHistory } from '../stores/downloadHistory';
import { toast } from '../stores/toast';
import { ConfirmDialog } from '../components/Dialog';
import { isAbsoluteLocalPath } from '../lib/downloadHistory';
import { openDownloadedPath } from '../platform/desktopCommands';
import { useI18n, type ResolvedLocale } from '../i18n';
import { formatDateTime } from '../i18n/format';

function completedAtLabel(value: number, locale: ResolvedLocale): string {
  return formatDateTime(
    value,
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    },
    locale,
  );
}

export default function DownloadsPage() {
  const { t, locale } = useI18n();
  const records = useDownloadHistory((state) => state.history.records);
  const clear = useDownloadHistory((state) => state.clear);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const openRecord = async (id: string, path: string, reveal: boolean) => {
    if (!isAbsoluteLocalPath(path)) {
      toast.error(t('pages.downloads.invalidPath'));
      return;
    }
    setBusy(`${id}:${reveal ? 'reveal' : 'open'}`);
    try {
      await openDownloadedPath(path, reveal);
    } catch (error) {
      toast.error(error, t(reveal ? 'pages.downloads.openFolderFailed' : 'pages.downloads.openFileFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
      <header className="rcx-glass-header flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t('pages.downloads.title')}</h1>
          <p className="mt-0.5 text-xs text-ink-3">{t('pages.downloads.subtitle')}</p>
        </div>
        {records.length > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 shadow-raise transition hover:border-danger/40 hover:bg-danger/5 hover:text-danger"
          >
            <Trash2 size={14} />
            {t('pages.downloads.clearHistory')}
          </button>
        )}
      </header>

      {records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="flex flex-col items-center rounded-2xl border border-line-soft bg-surface-2/60 px-10 py-9 shadow-raise">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-4 text-ink-3 shadow-raise">
              <Download size={26} strokeWidth={1.6} />
            </span>
            <div className="mt-4 text-sm font-medium text-ink-2">{t('pages.downloads.emptyTitle')}</div>
            <div className="mt-1 text-xs text-ink-3">{t('pages.downloads.emptyHint')}</div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="overflow-hidden rounded-2xl border border-line bg-surface-4 shadow-card">
            {records.map((record) => (
              <div
                key={record.id}
                className="group flex items-center gap-3.5 border-b border-line-soft px-4 py-3.5 transition last:border-b-0 hover:bg-fill-2/70"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
                  <FileText size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink" title={record.fileName}>
                    {record.fileName}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-3" title={record.path}>
                    {record.path}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    {record.source && (
                      <span
                        className="truncate rounded-md bg-fill-1 px-1.5 py-0.5"
                        title={`${record.source.roomName} · ${record.source.messageId}`}
                      >
                        {t('pages.downloads.source', { roomName: record.source.roomName })}
                      </span>
                    )}
                    <span>{completedAtLabel(record.completedAt, locale)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => void openRecord(record.id, record.path, false)}
                    disabled={busy !== null}
                    className="rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 shadow-raise transition hover:border-primary/40 hover:bg-fill-hover hover:text-primary disabled:opacity-50"
                  >
                    {t('pages.downloads.openFile')}
                  </button>
                  <button
                    onClick={() => void openRecord(record.id, record.path, true)}
                    disabled={busy !== null}
                    className="flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 shadow-raise transition hover:border-primary/40 hover:bg-fill-hover hover:text-primary disabled:opacity-50"
                  >
                    <FolderOpen size={14} />
                    {t('pages.downloads.openFolder')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmClear && (
        <ConfirmDialog
          title={t('pages.downloads.confirmClearTitle')}
          message={t('pages.downloads.confirmClearMessage')}
          confirmLabel={t('pages.downloads.clearHistory')}
          onConfirm={() => {
            clear();
            setConfirmClear(false);
            toast.success(t('pages.downloads.cleared'));
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </main>
  );
}
