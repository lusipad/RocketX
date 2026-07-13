import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * 统一的弹窗外壳：遮罩点击关闭 + Esc 关闭 + 一致的标题/间距。
 * 所有弹窗都用它，避免「一半弹窗按 Esc 没反应」。
 */
export default function Dialog({
  title,
  hint,
  width = 420,
  onClose,
  footer,
  children,
}: {
  title: string;
  hint?: string;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // 不让 MainPage 的全局 Esc 顺手关掉背后的面板
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{ width }}
        className="flex max-h-[72vh] flex-col rounded-xl bg-surface-4 shadow-2xl"
      >
        <header className="flex items-start justify-between px-5 pt-4 pb-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink">{title}</div>
            {hint && <div className="mt-1 text-xs leading-relaxed text-ink-3">{hint}</div>}
          </div>
          <button
            onClick={onClose}
            className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

/** 危险操作二次确认 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确定',
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      width={340}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`h-8 rounded-md px-4 text-sm text-white transition hover:opacity-90 ${
              danger ? 'bg-danger' : 'bg-primary'
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="px-5 pb-2 text-sm leading-relaxed text-ink-2">{message}</div>
    </Dialog>
  );
}
