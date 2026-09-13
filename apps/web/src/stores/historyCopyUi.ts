import { create } from 'zustand';

/**
 * 「复制聊天记录到另一个会话」的弹窗状态。
 *
 * 单独一个 store，是因为触发点分散在别处（加人后新建会话的 toast、群信息面板），
 * 而那些地方并不渲染弹窗。由挂在应用根部的 `HistoryCopyDialogHost` 统一呈现。
 */
interface HistoryCopyState {
  open: boolean;
  /** 来源会话；不指定时由弹窗里选 */
  sourceRid: string | null;
  /** 目标会话；不指定时由弹窗里选 */
  targetRid: string | null;
  openWith: (input: { sourceRid?: string; targetRid?: string }) => void;
  close: () => void;
}

export const useHistoryCopy = create<HistoryCopyState>((set) => ({
  open: false,
  sourceRid: null,
  targetRid: null,
  openWith: ({ sourceRid, targetRid }) =>
    set({ open: true, sourceRid: sourceRid ?? null, targetRid: targetRid ?? null }),
  close: () => set({ open: false, sourceRid: null, targetRid: null }),
}));

/** 从任何地方打开复制聊天记录弹窗。 */
export function openHistoryCopy(input: { sourceRid?: string; targetRid?: string } = {}): void {
  useHistoryCopy.getState().openWith(input);
}
