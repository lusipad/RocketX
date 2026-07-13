import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { useToast, type ToastKind } from '../stores/toast';

const ICONS: Record<ToastKind, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  loading: Loader2,
};

const COLORS: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-primary',
  loading: 'text-ink-2',
};

/** 全局提示：右下角堆叠，成功/失败/加载 */
export default function Toaster() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed right-5 bottom-5 z-[100] flex flex-col-reverse gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex min-w-72 max-w-md items-start gap-2.5 rounded-lg border border-line bg-surface-4 px-3.5 py-3 shadow-[0_6px_20px_rgba(0,0,0,0.16)]"
          >
            <Icon
              size={16}
              className={`mt-0.5 shrink-0 ${COLORS[t.kind]} ${
                t.kind === 'loading' ? 'animate-spin' : ''
              }`}
            />
            <span className="min-w-0 flex-1 text-sm leading-relaxed break-words text-ink">
              {t.message}
            </span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="shrink-0 text-sm font-medium text-primary hover:underline"
              >
                {t.action.label}
              </button>
            )}
            {t.kind !== 'loading' && (
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 text-ink-3 transition hover:text-ink"
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
