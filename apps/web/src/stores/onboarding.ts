import { create } from 'zustand';
import { loadWorkbenchConfig } from '../lib/ado';
import { getServerBase } from '../lib/client';
import {
  defaultOnboardingState,
  onboardingStorageKey,
  parseOnboardingState,
  updateChecklist,
  type OnboardingAdoState,
  type OnboardingChecklistKey,
  type OnboardingStateV1,
} from '../lib/onboarding';

interface OnboardingStore {
  ownerId: string | null;
  state: OnboardingStateV1 | null;
  hydrate: (userId: string) => void;
  setAdo: (ado: OnboardingAdoState) => void;
  markChecklist: (key: OnboardingChecklistKey) => void;
  dismissChecklist: () => void;
  reset: () => void;
}

function save(ownerId: string, state: OnboardingStateV1): void {
  try {
    localStorage.setItem(onboardingStorageKey(getServerBase(), ownerId), JSON.stringify(state));
  } catch {
    /* 无痕模式或存储已满时仅保留当前会话状态 */
  }
}

export const useOnboarding = create<OnboardingStore>((set, get) => ({
  ownerId: null,
  state: null,

  hydrate: (userId) => {
    if (get().ownerId === userId && get().state) return;
    let state: OnboardingStateV1 | null = null;
    try {
      state = parseOnboardingState(
        localStorage.getItem(onboardingStorageKey(getServerBase(), userId)),
      );
    } catch {
      /* 使用默认状态 */
    }
    state ??= defaultOnboardingState(loadWorkbenchConfig());
    save(userId, state);
    set({ ownerId: userId, state });
  },

  setAdo: (ado) => {
    const { ownerId, state } = get();
    if (!ownerId || !state) return;
    const next = { ...state, ado };
    save(ownerId, next);
    set({ state: next });
  },

  markChecklist: (key) => {
    const { ownerId, state } = get();
    if (!ownerId || !state) return;
    const next = updateChecklist(state, key);
    if (next === state) return;
    save(ownerId, next);
    set({ state: next });
  },

  dismissChecklist: () => {
    const { ownerId, state } = get();
    if (!ownerId || !state || state.checklist.dismissed) return;
    const next = { ...state, checklist: { ...state.checklist, dismissed: true } };
    save(ownerId, next);
    set({ state: next });
  },

  reset: () => {
    const { ownerId } = get();
    if (!ownerId) return;
    const state = defaultOnboardingState(null);
    save(ownerId, state);
    set({ state });
  },
}));
