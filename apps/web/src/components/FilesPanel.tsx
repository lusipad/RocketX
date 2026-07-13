import { useEffect, useMemo, useState } from 'react';
import { tsMs, type RcRoomFile } from '@rcx/rc-client';
import { AlertCircle, Download, FileText, Image as ImageIcon, Search } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { humanError, toast } from '../stores/toast';
import { fmtConvTime, fmtSize } from '../lib/format';
import { saveFile } from '../lib/download';
import FilePreview, { canPreview } from './FilePreview';
import ImageLightbox from './ImageLightbox';
import PanelShell from './PanelShell';
import { SkeletonList } from './Skeleton';

/** 文件在服务器上的路径。RC 给的 url 有时是相对的，有时字段叫 path */
function pathOf(f: RcRoomFile): string {
  return f.url ?? f.path ?? `/file-upload/${f._id}/${encodeURIComponent(f.name)}`;
}

const isImage = (f: RcRoomFile) => (f.type ?? '').startsWith('image/');

/**
 * 频道文件面板。
 *
 * 以前想找三周前发的那份文档，只能一路往上翻聊天记录 —— RC 原生有这个面板，我们没接。
 */
export default function FilesPanel() {
  const rid = useChat((s) => s.activeRid);
  const type = useChat((s) =>
    s.activeRid ? (s.subscriptions[s.activeRid]?.t ?? s.rooms[s.activeRid]?.t ?? 'c') : 'c',
  );

  const [files, setFiles] = useState<RcRoomFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [preview, setPreview] = useState<RcRoomFile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError(null);
    rest
      .getRoomFiles(rid, type)
      .then(setFiles)
      .catch((err: unknown) => {
        setFiles([]);
        setError(humanError(err, '无法获取文件列表'));
      })
      .finally(() => setLoading(false));
  }, [rid, type]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
  }, [files, keyword]);

  const download = async (f: RcRoomFile) => {
    setBusy(f._id);
    try {
      await saveFile(pathOf(f), f.name);
    } catch (err) {
      toast.error(err, '下载失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <PanelShell title={`文件${files.length ? `（${files.length}）` : ''}`}>
      <div className="p-3">
        <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索文件名"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {loading && <SkeletonList rows={5} avatar={32} />}
        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="max-w-xs text-xs break-words text-ink-3">{error}</div>
          </div>
        )}
        {!loading &&
          !error &&
          filtered.map((f) => {
            const previewable = canPreview(f.name) || isImage(f);
            return (
              <div
                key={f._id}
                onClick={() => previewable && setPreview(f)}
                className={`group flex items-center gap-3 rounded-lg px-3 py-2 ${
                  previewable ? 'cursor-pointer hover:bg-fill-hover' : ''
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-fill-1 text-ink-2">
                  {isImage(f) ? <ImageIcon size={15} /> : <FileText size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{f.name}</div>
                  <div className="truncate text-xs text-ink-3">
                    {[
                      f.user?.name || f.user?.username,
                      fmtSize(f.size),
                      f.uploadedAt ? fmtConvTime(tsMs(f.uploadedAt)) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <button
                  title="下载"
                  disabled={busy === f._id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void download(f);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 opacity-0 transition group-hover:opacity-100 hover:bg-fill-2 hover:text-ink disabled:opacity-40"
                >
                  <Download size={14} />
                </button>
              </div>
            );
          })}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? '没有匹配的文件' : '这个会话还没有人传过文件'}
          </div>
        )}
      </div>

      {/* 图片走灯箱，文本/PDF 走 FilePreview —— FilePreview 只认这两类，图片丢给它会显示「无法预览」 */}
      {preview &&
        (isImage(preview) ? (
          <ImageLightbox
            path={pathOf(preview)}
            fileName={preview.name}
            onClose={() => setPreview(null)}
          />
        ) : (
          <FilePreview
            path={pathOf(preview)}
            fileName={preview.name}
            size={preview.size}
            onClose={() => setPreview(null)}
          />
        ))}
    </PanelShell>
  );
}
