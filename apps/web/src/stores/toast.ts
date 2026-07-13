import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info' | 'loading';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** 可选操作（如「重试」） */
  action?: { label: string; onClick: () => void };
  /** 毫秒；loading 类型默认不自动消失 */
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  show: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
  /** 更新已有 toast（loading → success/error） */
  update: (id: string, patch: Partial<Omit<Toast, 'id'>>) => void;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 2200,
  error: 4500,
  info: 2800,
  loading: 0,
};

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],

  show: (t) => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const duration = t.duration ?? DEFAULT_DURATION[t.kind];
    set({ toasts: [...get().toasts, { ...t, id }] });
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  update: (id, patch) => {
    set({
      toasts: get().toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
    const kind = patch.kind;
    if (kind && kind !== 'loading') {
      const duration = patch.duration ?? DEFAULT_DURATION[kind];
      if (duration > 0) setTimeout(() => get().dismiss(id), duration);
    }
  },
}));

/** 把任意错误转成人话 */
export function humanError(err: unknown, fallback = '操作失败'): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (!raw) return fallback;
  if (/failed to fetch|network|load failed|error sending request/i.test(raw)) {
    return '网络连接失败，请检查网络或服务器状态';
  }
  if (/unauthorized|not authorized|401/i.test(raw)) return '没有权限执行此操作';
  if (/not enough permission/i.test(raw)) return '权限不足（需要管理员授权）';
  if (/enterprise/i.test(raw)) return '该功能需要 Rocket.Chat 企业版';
  if (/rate limit|too many/i.test(raw)) return '操作过于频繁，请稍后再试';
  return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
}

/** 快捷方法 */
export const toast = {
  show: (t: Omit<Toast, 'id'>) => useToast.getState().show(t),
  success: (message: string, action?: Toast['action']) =>
    useToast.getState().show({ kind: 'success', message, action }),
  error: (err: unknown, fallback?: string) =>
    useToast.getState().show({ kind: 'error', message: humanError(err, fallback) }),
  info: (message: string) => useToast.getState().show({ kind: 'info', message }),
  loading: (message: string) => useToast.getState().show({ kind: 'loading', message }),
  update: (id: string, patch: Partial<Omit<Toast, 'id'>>) =>
    useToast.getState().update(id, patch),
  dismiss: (id: string) => useToast.getState().dismiss(id),
};
