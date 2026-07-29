import { create } from 'zustand';

const KEY = 'rcx-butler-attention';
const ACKNOWLEDGEMENT_LIMIT = 200;

export interface ButlerAttentionState {
  acknowledgedNeedIds: string[];
}

interface ButlerAttentionStore extends ButlerAttentionState {
  acknowledge: (id: string) => void;
  restore: (id: string) => void;
  prune: (openIds: readonly string[]) => void;
}

export function normalizeButlerAttentionState(value: unknown): ButlerAttentionState {
  if (!value || typeof value !== 'object') return { acknowledgedNeedIds: [] };
  const ids = (value as { acknowledgedNeedIds?: unknown }).acknowledgedNeedIds;
  if (!Array.isArray(ids)) return { acknowledgedNeedIds: [] };
  return {
    acknowledgedNeedIds: [...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].slice(-ACKNOWLEDGEMENT_LIMIT),
  };
}

function load(): ButlerAttentionState {
  try {
    return normalizeButlerAttentionState(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { acknowledgedNeedIds: [] };
  }
}

function persist(state: ButlerAttentionState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 无痕模式或存储已满时只保留当前会话状态。 */
  }
}

export const useButlerAttention = create<ButlerAttentionStore>((set, get) => ({
  ...load(),

  acknowledge: (id) => {
    const acknowledgedNeedIds = [...new Set([
      ...get().acknowledgedNeedIds,
      id,
    ])].slice(-ACKNOWLEDGEMENT_LIMIT);
    persist({ acknowledgedNeedIds });
    set({ acknowledgedNeedIds });
  },

  restore: (id) => {
    const acknowledgedNeedIds = get().acknowledgedNeedIds.filter((item) => item !== id);
    persist({ acknowledgedNeedIds });
    set({ acknowledgedNeedIds });
  },

  prune: (openIds) => {
    const keep = new Set(openIds);
    const acknowledgedNeedIds = get().acknowledgedNeedIds.filter((id) => keep.has(id));
    if (acknowledgedNeedIds.length === get().acknowledgedNeedIds.length) return;
    persist({ acknowledgedNeedIds });
    set({ acknowledgedNeedIds });
  },
}));

