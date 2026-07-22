import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Loader2, Maximize2, Minus, Plus, ScanText, X } from 'lucide-react';
import AuthImage from './AuthImage';
import { saveFile } from '../lib/download';
import { toast } from '../stores/toast';
import { rest } from '../lib/client';
import {
  isWindowsDesktopOcr,
  ocrWordStyle,
  recognizeImageBlob,
  type ImageOcrResult,
} from '../lib/imageOcr';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

/** 图片大图查看器：适应窗口、滚轮/按钮缩放、拖拽平移、下载 */
export default function ImageLightbox({
  path,
  fileName,
  onClose,
}: {
  path: string;
  fileName: string;
  onClose: () => void;
}) {
  // zoom = null 表示「适应窗口」（默认）；数值表示手动缩放倍数
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const [ocr, setOcr] = useState<ImageOcrResult | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState('');
  const ocrAvailable = isWindowsDesktopOcr('__TAURI_INTERNALS__' in window, navigator.userAgent);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min((z ?? 1) * 1.25, MAX_ZOOM));
      } else if (e.key === '-') {
        setZoom((z) => Math.max((z ?? 1) / 1.25, MIN_ZOOM));
      } else if (e.key === '0') {
        setZoom(null);
        setOffset({ x: 0, y: 0 });
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const base = z ?? 1;
      const next = e.deltaY < 0 ? base * 1.15 : base / 1.15;
      return Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
    });
  };

  const fit = () => {
    setZoom(null);
    setOffset({ x: 0, y: 0 });
  };

  const recognize = async () => {
    if (ocrBusy) return;
    setOcrBusy(true);
    setOcrError('');
    try {
      const result = await recognizeImageBlob(await rest.fetchFile(path));
      setOcr(result);
      if (!result.words.length) setOcrError('图片中未识别到文字');
    } catch (error) {
      setOcr(null);
      setOcrError(error instanceof Error ? error.message : String(error));
    } finally {
      setOcrBusy(false);
    }
  };

  // 适应窗口：撑满可视区（小图也放大）；手动缩放：按倍数显示
  const stageStyle: React.CSSProperties =
    zoom === null
      ? {}
      : {
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transformOrigin: 'center',
          cursor: dragging ? 'grabbing' : 'grab',
        };

  const btn =
    'flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/85"
      onClick={onClose}
      onWheel={onWheel}
      onMouseMove={(e) => {
        if (!dragging) return;
        setOffset({ x: e.clientX - dragging.x, y: e.clientY - dragging.y });
      }}
      onMouseUp={() => setDragging(null)}
    >
      {/* 工具栏 */}
      <div
        className="absolute top-4 right-4 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mr-1 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80">
          {zoom === null ? '适应窗口' : `${Math.round(zoom * 100)}%`}
        </span>
        <button title="缩小 (-)" className={btn} onClick={() => setZoom((z) => Math.max((z ?? 1) / 1.25, MIN_ZOOM))}>
          <Minus size={16} />
        </button>
        <button title="放大 (+)" className={btn} onClick={() => setZoom((z) => Math.min((z ?? 1) * 1.25, MAX_ZOOM))}>
          <Plus size={16} />
        </button>
        <button title="适应窗口 (0)" className={btn} onClick={fit}>
          <Maximize2 size={15} />
        </button>
        <button
          title="下载"
          className={btn}
          onClick={() => void saveFile(path, fileName).catch((err) => toast.error(err, '下载失败'))}
        >
          <Download size={16} />
        </button>
        {ocrAvailable && (
          <button
            title={ocr ? '重新识别文字' : '识别图片文字'}
            className={btn}
            disabled={ocrBusy}
            onClick={() => void recognize()}
          >
            {ocrBusy ? <Loader2 size={16} className="animate-spin" /> : <ScanText size={16} />}
          </button>
        )}
        {ocr?.text && (
          <button
            title="复制全部识别文字"
            className={btn}
            onClick={() => void navigator.clipboard.writeText(ocr.text).then(
              () => toast.success('已复制识别文字'),
              (error) => toast.error(error, '复制失败'),
            )}
          >
            <Copy size={16} />
          </button>
        )}
        <button title="关闭 (Esc)" className={btn} onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {/* 文件名 */}
      <div className="absolute top-5 left-5 max-w-[50vw] truncate text-sm text-white/80">
        {fileName}
      </div>

      <div
        style={stageStyle}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => {
          if (zoom === null || (ocr && !e.altKey)) return;
          e.preventDefault();
          setDragging({ x: e.clientX - offset.x, y: e.clientY - offset.y });
        }}
        className="relative inline-flex max-h-[86vh] max-w-[92vw]"
      >
        <AuthImage
          path={path}
          alt={fileName}
          className="block max-h-[86vh] max-w-[92vw] select-none rounded-md object-contain"
          fallback={<div className="text-sm text-white/70">图片加载失败</div>}
        />
        {ocr && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md" aria-label="图片识别文字">
            {ocr.words.map((word, index) => (
              <span
                key={`${index}-${word.text}`}
                className="pointer-events-auto absolute cursor-text overflow-hidden whitespace-nowrap text-transparent selection:bg-blue-500/70 selection:text-white hover:outline hover:outline-1 hover:outline-blue-400/70"
                style={ocrWordStyle(word)}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {word.text}{word.spaceAfter ? ' ' : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="absolute bottom-5 text-center text-xs text-white/60">
        {ocrError ? (
          <span className="rounded bg-red-950/70 px-3 py-1.5 text-red-100">{ocrError}</span>
        ) : ocr ? (
          <span>已用 Windows 本地 OCR 识别 {ocr.words.length} 处文字（{ocr.language}） · 拖选复制 · Alt+拖拽平移</span>
        ) : (
          <span>滚轮缩放 · 拖拽平移 · Esc 关闭</span>
        )}
      </div>
    </div>,
    document.body,
  );
}
