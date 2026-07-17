import { isTauri } from './http';

const BRAIN_KEY = 'rcx-butler-v1:brain';

export type ButlerBrainKind = 'api' | 'codex';

export interface ButlerBrainStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const localStorageBrain: ButlerBrainStorage = {
  get: (key) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  set: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
};

let brainStorage: ButlerBrainStorage = localStorageBrain;
let tauriAvailable = () => isTauri;
let unavailableReason: string | undefined;

function defaultBrain(): ButlerBrainKind {
  return tauriAvailable() ? 'codex' : 'api';
}

export function getButlerBrain(): ButlerBrainKind {
  const saved = brainStorage.get(BRAIN_KEY);
  return saved === 'api' || saved === 'codex' ? saved : defaultBrain();
}

export function setButlerBrain(brain: ButlerBrainKind): void {
  brainStorage.set(BRAIN_KEY, brain);
}

export function codexBrainAvailability(): { available: boolean; reason?: string } {
  if (!tauriAvailable()) return { available: false, reason: 'Codex 大脑仅桌面端可用' };
  return unavailableReason ? { available: false, reason: unavailableReason } : { available: true };
}

/** 运行时发现 Codex CLI 不可用或未登录时，保留可直接呈现给用户的原因。 */
export function setCodexBrainUnavailableReason(reason?: string): void {
  unavailableReason = reason;
}

export function setButlerBrainStorage(storage: ButlerBrainStorage): () => void {
  const previous = brainStorage;
  brainStorage = storage;
  return () => {
    brainStorage = previous;
  };
}

/** 测试时替换平台判断，生产环境始终读取 isTauri。 */
export function setButlerBrainTauriProvider(provider: () => boolean): () => void {
  const previous = tauriAvailable;
  tauriAvailable = provider;
  return () => {
    tauriAvailable = previous;
  };
}
