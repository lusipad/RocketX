import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import AuthImage, { downloadAuthedFile } from './AuthImage';

/** 图片灯箱：点击消息图片放大查看，Esc/点空白关闭，支持下载 */
export default function ImageLightbox({
  path,
  fileName,
  onClose,
}: {
  path: string;
  fileName: string;
  onClose: () => void;
}) {
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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            void downloadAuthedFile(path, fileName).catch(() => {});
          }}
          title="下载"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <Download size={17} />
        </button>
        <button
          title="关闭"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <X size={18} />
        </button>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <AuthImage
          path={path}
          alt={fileName}
          className="max-h-[86vh] max-w-[90vw] rounded-lg object-contain"
          fallback={<div className="text-sm text-white/70">图片加载失败</div>}
        />
      </div>
    </div>,
    document.body,
  );
}
