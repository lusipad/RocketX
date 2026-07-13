import { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { rest } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import { toast } from '../stores/toast';
import { saveFile } from '../lib/download';

/** 能直接看的文本类文件：按扩展名判断（服务端返回的 MIME 不一定靠谱） */
const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'log',
  'csv',
  'json',
  'xml',
  'yml',
  'yaml',
  'ini',
  'conf',
  'sh',
  'bat',
  'ps1',
  'sql',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'cs',
  'css',
  'html',
  'vue',
  'toml',
  'env',
  'gitignore',
  'dockerfile',
]);

const PDF_EXT = new Set(['pdf']);

/** 超过这个大小就不当文本预览了——渲染几十兆纯文本会把页面卡死 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** 这个文件能不能预览（决定要不要显示「预览」入口） */
export function canPreview(name: string): boolean {
  const ext = extOf(name);
  return TEXT_EXT.has(ext) || PDF_EXT.has(ext);
}

/**
 * 文件预览：文本/代码/Markdown 直接渲染，PDF 交给浏览器内置阅读器。
 * 站内文件都要带认证取，所以先 fetch 成 blob 再渲染，不能直接把 URL 丢给 <iframe>。
 */
export default function FilePreview({
  path,
  fileName,
  size,
  onClose,
}: {
  path: string;
  fileName: string;
  size?: number;
  onClose: () => void;
}) {
  const ext = extOf(fileName);
  const isPdf = PDF_EXT.has(ext);
  const isMarkdown = ext === 'md' || ext === 'markdown';

  const [text, setText] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;

    if (size !== undefined && size > MAX_TEXT_BYTES && !isPdf) {
      setError('文件太大，不适合在线预览，请下载后查看');
      return;
    }

    void rest
      .fetchFile(path)
      .then(async (blob) => {
        if (!alive) return;
        if (isPdf) {
          objectUrl = URL.createObjectURL(blob);
          setPdfUrl(objectUrl);
        } else {
          setText(await blob.text());
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, isPdf, size]);

  const download = async () => {
    setSaving(true);
    try {
      await saveFile(path, fileName);
    } catch (err) {
      toast.error(err, '下载失败');
    } finally {
      setSaving(false);
    }
  };

  const loading = !text && !pdfUrl && !error;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-4 text-white">
        <span className="truncate text-sm">{fileName}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void download()}
            disabled={saving}
            className="flex h-8 items-center gap-1.5 rounded-md bg-white/10 px-3 text-xs transition hover:bg-white/20 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {saving ? '保存中…' : '下载'}
          </button>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-white/20"
            title="关闭（Esc）"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="mx-auto mb-4 flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden rounded-xl bg-surface-4">
        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-3">
            <Loader2 size={16} className="animate-spin" />
            加载中…
          </div>
        )}

        {error && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-sm text-danger">无法预览</div>
            <div className="max-w-md text-xs break-words text-ink-3">{error}</div>
            <button
              onClick={() => void download()}
              className="mt-2 h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
            >
              直接下载
            </button>
          </div>
        )}

        {pdfUrl && <iframe src={pdfUrl} title={fileName} className="flex-1 border-0" />}

        {text !== null &&
          (isMarkdown ? (
            <div className="flex-1 overflow-auto px-6 py-5 text-sm leading-relaxed text-ink">
              {renderMarkdownDoc(text)}
            </div>
          ) : (
            <pre className="flex-1 overflow-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
              {text}
            </pre>
          ))}
      </div>
    </div>
  );
}
