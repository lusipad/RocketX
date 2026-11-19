import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Loader2, X } from 'lucide-react';
import { normalizeAssetPath, rest } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import PdfView from './PdfView';
import { toast } from '../stores/toast';
import { saveFile } from '../lib/download';
import type { DownloadSourceV1 } from '../lib/downloadHistory';
import { sandboxArtifactHtml } from '../lib/codexArtifacts';
import { decodeHtmlPreview, MAX_HTML_PREVIEW_BYTES } from '../lib/htmlPreview';

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
  'html',
  'htm',
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
  'vue',
  'toml',
  'env',
  'gitignore',
  'dockerfile',
]);

const VIDEO_MIME = new Map([
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
  ['mkv', 'video/x-matroska'], ['avi', 'video/x-msvideo'], ['ogv', 'video/ogg'],
]);
const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);

/** 超过这个大小就不当文本预览了——渲染几十兆纯文本会把页面卡死 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function filePreviewKind(name: string, contentType = '') {
  const ext = extOf(name);
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_MIME.has(ext)) return 'video';
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || ['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (TEXT_EXT.has(ext) || name.toLowerCase() === 'dockerfile' || mime.startsWith('text/') ||
      /^(application\/(json|xml|javascript)|application\/[\w.-]+\+(json|xml))$/.test(mime)) return 'text';
  return null;
}

/**
 * 文件预览：文本 / 代码 / Markdown / 沙箱 HTML / 音视频，PDF 用 pdf.js 画。
 *
 * 两个踩过的坑：
 * 1. 不能把服务端 URL 直接交给 <iframe>：Rocket.Chat 给文件带的是
 *    `Content-Disposition: attachment`，浏览器会当成下载，iframe 里只有白屏。
 *    必须先取到字节。
 * 2. 取字节只能靠 fetch，而 Rocket.Chat 只给 `/api/v1/*` 开了 CORS，
 *    `/file-upload/*` 的预检不返回 200 —— 网页版一旦跨域连服务器，fetch 必被拦。
 *    桌面端走 Rust 通道没有这个限制；网页版需要同源部署（反向代理）。
 */
export default function FilePreview({
  path,
  fileName,
  kind,
  contentType,
  size,
  source,
  onClose,
}: {
  path: string;
  fileName: string;
  kind: Exclude<ReturnType<typeof filePreviewKind>, 'image' | null>;
  contentType?: string;
  size?: number;
  source?: DownloadSourceV1;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [videoPercent, setVideoPercent] = useState<number | null>(null);
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
    setText(null);
    setPdfData(null);
    setMediaUrl(null);
    setMediaFailed(false);
    setVideoPercent(null);
    setError(null);

    const isText = kind === 'text' || kind === 'markdown' || kind === 'html';
    const limit = kind === 'html' ? MAX_HTML_PREVIEW_BYTES : MAX_TEXT_BYTES;
    const sizeError = `文件超过 ${limit / 1024 / 1024} MiB，请下载后查看`;
    if (isText && size !== undefined && size > limit) {
      setError(sizeError);
      return;
    }

    const controller = new AbortController();
    void rest
      .fetchFileWithProgress(normalizeAssetPath(path), {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (!alive) return;
          if (isText && (loaded > limit || (total !== null && total > limit))) {
            controller.abort();
            setError(sizeError);
          } else if (kind === 'video') {
            const expected = total ?? size;
            if (expected && expected > 0) setVideoPercent(Math.min(100, Math.floor(loaded * 100 / expected)));
          }
        },
      })
      .then(async (blob) => {
        if (!alive || controller.signal.aborted) return;
        // PDF 交给 pdf.js 自己画（见 PdfView），不依赖 webview 自带的阅读器
        if (kind === 'pdf') {
          const data = await blob.arrayBuffer();
          if (alive) setPdfData(data);
        } else if (kind === 'audio' || kind === 'video') {
          // 对象存储和旧消息都可能只给 octet-stream，按原文件名补回视频容器类型。
          const mime = [blob.type, contentType?.trim().toLowerCase()].find((value) => value?.startsWith(kind + '/'))
            ?? (kind === 'video' ? VIDEO_MIME.get(extOf(fileName)) : undefined);
          const mediaBlob = mime && mime !== blob.type ? blob.slice(0, blob.size, mime) : blob;
          objectUrl = URL.createObjectURL(mediaBlob);
          setMediaUrl(objectUrl);
        } else if (blob.size > limit) {
          setError(sizeError);
        } else if (kind === 'html') {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (alive) setText(decodeHtmlPreview(bytes, blob.type, contentType));
        } else {
          const body = await blob.text();
          if (alive) setText(body);
        }
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        const raw = err instanceof Error ? err.message : String(err);
        setError(
          /failed to fetch|networkerror|load failed/i.test(raw)
            ? '无法读取文件。请检查网络连接；网页版跨域访问还需要文件服务允许跨域，或通过同源代理访问。'
            : raw,
        );
      });

    return () => {
      alive = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, kind, contentType, size, fileName]);

  const sandboxHtml = useMemo(() => kind === 'html' && text !== null ? sandboxArtifactHtml(text) : null, [kind, text]);

  const download = async () => {
    setSaving(true);
    try {
      await saveFile(path, fileName, source);
    } catch (err) {
      toast.error(err, '下载失败');
    } finally {
      setSaving(false);
    }
  };

  const loading = text === null && !pdfData && !mediaUrl && !error;

  return createPortal(
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
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {saving ? '保存中…' : '下载'}
          </button>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-white/20"
            title="关闭（Esc）"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="mx-auto mb-4 flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden rounded-xl bg-surface-4">
        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-3">
            <Loader2 size={16} className="animate-spin" />
            {kind === 'video' && videoPercent !== null ? `正在读取视频 ${videoPercent}%` : '加载中…'}
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

        {pdfData && <PdfView data={pdfData} />}

        {mediaUrl && (kind === 'audio' ? (
          <audio className="m-auto w-4/5" controls src={mediaUrl} onError={() => setMediaFailed(true)} />
        ) : (
          <video className="min-h-0 w-full flex-1" controls src={mediaUrl} onError={() => setMediaFailed(true)} />
        ))}
        {mediaFailed && <p className="p-3 text-center text-sm text-ink-2">当前设备无法解码此文件，可下载后用本地播放器打开。</p>}

        {sandboxHtml && text && /<script\b/i.test(text) && (
          <p className="shrink-0 px-4 py-2 text-xs text-ink-2">此网页含脚本。交互内容可下载后在浏览器中查看。</p>
        )}
        {sandboxHtml && (
          <iframe
            title="网页预览"
            className="min-h-0 w-full flex-1 bg-white"
            sandbox=""
            srcDoc={sandboxHtml}
          />
        )}

        {text !== null && kind !== 'html' &&
          (kind === 'markdown' ? (
            <div className="flex-1 overflow-auto px-6 py-5 text-sm leading-relaxed text-ink">
              {renderMarkdownDoc(text)}
            </div>
          ) : (
            <pre className="flex-1 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">
              {text}
            </pre>
          ))}
      </div>
    </div>, document.body,
  );
}
