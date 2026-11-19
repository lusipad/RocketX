import { useState } from 'react';
import { Download, FileText, FolderOpen, Trash2 } from 'lucide-react';
import { useDownloadHistory } from '../stores/downloadHistory';
import { toast } from '../stores/toast';
import { ConfirmDialog } from '../components/Dialog';
import { isAbsoluteLocalPath } from '../lib/downloadHistory';
import { openDownloadedPath } from '../platform/desktopCommands';

function completedAtLabel(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export default function DownloadsPage() {
  const records = useDownloadHistory((state) => state.history.records);
  const clear = useDownloadHistory((state) => state.clear);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const openRecord = async (id: string, path: string, reveal: boolean) => {
    if (!isAbsoluteLocalPath(path)) {
      toast.error('下载记录中的路径无效');
      return;
    }
    setBusy(`${id}:${reveal ? 'reveal' : 'open'}`);
    try {
      await openDownloadedPath(path, reveal);
    } catch (error) {
      toast.error(error, reveal ? '无法打开所在文件夹' : '无法打开文件');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
      <header className="rcx-glass-header flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">下载</h1>
          <p className="mt-0.5 text-xs text-ink-3">仅记录本机桌面端成功保存的文件；清除记录不会删除文件。</p>
        </div>
        {records.length > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 shadow-raise transition hover:border-danger/40 hover:bg-danger/5 hover:text-danger"
          >
            <Trash2 size={14} />
            清除记录
          </button>
        )}
      </header>

      {records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="flex flex-col items-center rounded-2xl border border-line-soft bg-surface-2/60 px-10 py-9 shadow-raise">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-4 text-ink-3 shadow-raise">
              <Download size={26} strokeWidth={1.6} />
            </span>
            <div className="mt-4 text-sm font-medium text-ink-2">暂无下载记录</div>
            <div className="mt-1 text-xs text-ink-3">文件成功保存到本机后会显示在这里。</div>
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
                        来源：{record.source.roomName}
                      </span>
                    )}
                    <span>{completedAtLabel(record.completedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => void openRecord(record.id, record.path, false)}
                    disabled={busy !== null}
                    className="rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 shadow-raise transition hover:border-primary/40 hover:bg-fill-hover hover:text-primary disabled:opacity-50"
                  >
                    打开文件
                  </button>
                  <button
                    onClick={() => void openRecord(record.id, record.path, true)}
                    disabled={busy !== null}
                    className="flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 shadow-raise transition hover:border-primary/40 hover:bg-fill-hover hover:text-primary disabled:opacity-50"
                  >
                    <FolderOpen size={14} />
                    打开所在文件夹
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmClear && (
        <ConfirmDialog
          title="清除下载记录"
          message="只会清除 RocketX 中的历史记录，不会删除磁盘上的文件。"
          confirmLabel="清除记录"
          onConfirm={() => {
            clear();
            setConfirmClear(false);
            toast.success('下载记录已清除，文件仍保留在原位置');
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </main>
  );
}
