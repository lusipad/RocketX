import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Maximize2, Minus, Plus, X } from 'lucide-react';
import AuthImage, { downloadAuthedFile } from './AuthImage';

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

  // 适应窗口：撑满可视区（小图也放大）；手动缩放：按倍数显示
  const imgStyle: React.CSSProperties =
    zoom === null
      ? { maxWidth: '92vw', maxHeight: '86vh', width: 'auto', height: 'auto' }
      : {
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transformOrigin: 'center',
          maxWidth: '92vw',
          maxHeight: '86vh',
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
          onClick={() => void downloadAuthedFile(path, fileName).catch(() => {})}
        >
          <Download size={16} />
        </button>
        <button title="关闭 (Esc)" className={btn} onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {/* 文件名 */}
      <div className="absolute top-5 left-5 max-w-[50vw] truncate text-sm text-white/80">
        {fileName}
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => {
          if (zoom === null) return;
          e.preventDefault();
          setDragging({ x: e.clientX - offset.x, y: e.clientY - offset.y });
        }}
      >
        <AuthImage
          path={path}
          alt={fileName}
          style={imgStyle}
          className="select-none rounded-md object-contain"
          fallback={<div className="text-sm text-white/70">图片加载失败</div>}
        />
      </div>

      <div className="absolute bottom-5 text-xs text-white/50">
        滚轮缩放 · 拖拽平移 · Esc 关闭
      </div>
    </div>,
    document.body,
  );
}
