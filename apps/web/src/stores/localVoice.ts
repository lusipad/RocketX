import { create } from 'zustand';

/** Opt-in is deliberately not persisted, so launching RocketX never opens the microphone. */
export const useLocalVoice = create<{ enabled: boolean; setEnabled: (enabled: boolean) => void }>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}));
