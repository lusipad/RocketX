import { create } from 'zustand';
import { onButlerArchiveHydrated } from '../lib/butlerArchive';
import {
  DEFAULT_BUTLER_IDENTITY,
  normalizeButlerIdentity,
  readButlerIdentity,
  writeButlerIdentity,
  type ButlerIdentity,
} from '../lib/butlerIdentity';

interface ButlerIdentityState {
  identity: ButlerIdentity;
  save: (identity: ButlerIdentity) => void;
  reset: () => void;
}

export const useButlerIdentity = create<ButlerIdentityState>((set) => ({
  identity: readButlerIdentity(),
  save: (identity) => set({ identity: writeButlerIdentity(identity) }),
  reset: () => {
    const identity = writeButlerIdentity(DEFAULT_BUTLER_IDENTITY);
    set({ identity });
  },
}));

onButlerArchiveHydrated(() => {
  useButlerIdentity.setState({ identity: normalizeButlerIdentity(readButlerIdentity()) });
});

