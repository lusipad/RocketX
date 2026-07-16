import { create } from 'zustand';
import { loadWorkbenchConfig } from '../lib/ado';
import { getServerBase } from '../lib/client';
import {
  defaultOnboardingState,
  onboardingStorageKey,
  parseOnboardingState,
  skipChecklist,
  updateChecklist,
  type OnboardingAdoState,
  type OnboardingChecklistKey,
  type OnboardingStateV1,
} from '../lib/onboarding';

interface OnboardingStore {
  ownerId: string | null;
  ownerServer: string | null;
  state: OnboardingStateV1 | null;
  hydrate: (userId: string) => void;
  setAdo: (ado: OnboardingAdoState) => void;
  markChecklist: (key: OnboardingChecklistKey) => void;
  dismissChecklist: () => void;
  reset: () => void;
}

function save(server: string, ownerId: string, state: OnboardingStateV1): void {
  try {
    localStorage.setItem(onboardingStorageKey(server, ownerId), JSON.stringify(state));
  } catch {
    /* 无痕模式或存储已满时仅保留当前会话状态 */
  }
}

export const useOnboarding = create<OnboardingStore>((set, get) => ({
  ownerId: null,
  ownerServer: null,
  state: null,

  hydrate: (userId) => {
    const server = getServerBase();
    if (get().ownerId === userId && get().ownerServer === server && get().state) return;
    let state: OnboardingStateV1 | null = null;
    try {
      state = parseOnboardingState(
        localStorage.getItem(onboardingStorageKey(server, userId)),
      );
    } catch {
      /* 使用默认状态 */
    }
    state ??= defaultOnboardingState(loadWorkbenchConfig());
    save(server, userId, state);
    set({ ownerId: userId, ownerServer: server, state });
  },

  setAdo: (ado) => {
    const { ownerId, ownerServer, state } = get();
    if (!ownerId || ownerServer === null || !state) return;
    const next = { ...state, ado };
    save(ownerServer, ownerId, next);
    set({ state: next });
  },

  markChecklist: (key) => {
    const { ownerId, ownerServer, state } = get();
    if (!ownerId || ownerServer === null || !state) return;
    const next = updateChecklist(state, key);
    if (next === state) return;
    save(ownerServer, ownerId, next);
    set({ state: next });
  },

  dismissChecklist: () => {
    const { ownerId, ownerServer, state } = get();
    if (!ownerId || ownerServer === null || !state || state.checklist.dismissed) return;
    const next = skipChecklist(state);
    save(ownerServer, ownerId, next);
    set({ state: next });
  },

  reset: () => {
    const { ownerId, ownerServer } = get();
    if (!ownerId || ownerServer === null) return;
    const state = defaultOnboardingState(null);
    save(ownerServer, ownerId, state);
    set({ state });
  },
}));
