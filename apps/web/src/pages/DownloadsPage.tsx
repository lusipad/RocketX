import { useState } from 'react';
import { Download, FileText, FolderOpen, Trash2 } from 'lucide-react';
import { useDownloadHistory } from '../stores/downloadHistory';
import { toast } from '../stores/toast';
import { ConfirmDialog } from '../components/Dialog';
import { isAbsoluteLocalPath } from '../lib/downloadHistory';

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
      const { openPath, revealItemInDir } = await import('@tauri-apps/plugin-opener');
      if (reveal) await revealItemInDir(path);
      else await openPath(path);
    } catch (error) {
      toast.error(error, reveal ? '无法打开所在文件夹' : '无法打开文件');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-3 p-5">
      <header className="flex items-start justify-between border-b border-line pb-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">下载</h1>
          <p className="mt-1 text-xs text-ink-3">仅记录本机桌面端成功保存的文件；清除记录不会删除文件。</p>
        </div>
        {records.length > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-danger"
          >
            <Trash2 size={14} />
            清除记录
          </button>
        )}
      </header>

      {records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center text-ink-3">
          <Download size={36} strokeWidth={1.4} />
          <div className="mt-3 text-sm font-medium text-ink-2">暂无下载记录</div>
          <div className="mt-1 text-xs">文件成功保存到本机后会显示在这里。</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
          {records.map((record) => (
            <div
              key={record.id}
              className="group flex items-center gap-3 border-b border-line px-3 py-3 last:border-b-0 hover:bg-fill-2"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
                <FileText size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink" title={record.fileName}>
                  {record.fileName}
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-3" title={record.path}>
                  {record.path}
                </div>
                {record.source && (
                  <div
                    className="mt-0.5 truncate text-xs text-ink-3"
                    title={`${record.source.roomName} · ${record.source.messageId}`}
                  >
                    来源：{record.source.roomName}
                  </div>
                )}
                <div className="mt-0.5 text-xs text-ink-3">{completedAtLabel(record.completedAt)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void openRecord(record.id, record.path, false)}
                  disabled={busy !== null}
                  className="rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-primary disabled:opacity-50"
                >
                  打开文件
                </button>
                <button
                  onClick={() => void openRecord(record.id, record.path, true)}
                  disabled={busy !== null}
                  className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-primary disabled:opacity-50"
                >
                  <FolderOpen size={13} />
                  打开所在文件夹
                </button>
              </div>
            </div>
          ))}
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
