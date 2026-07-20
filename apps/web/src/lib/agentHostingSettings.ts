import {
  BUTLER_CODEX_EFFORTS,
  getButlerCodexSettings,
  hasSavedButlerCodexSettings,
  type ButlerBrainStorage,
  type ButlerCodexSettings,
} from './butlerBrain';

const CODEX_MODEL_KEY = 'rcx-agent-hosting-v1:codex-model';
const CODEX_EFFORT_KEY = 'rcx-agent-hosting-v1:codex-effort';

const localStorageSettings: ButlerBrainStorage = {
  get: (key) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  set: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
};

let settingsStorage: ButlerBrainStorage = localStorageSettings;

export function getAgentHostingCodexSettings(): ButlerCodexSettings {
  const savedModel = settingsStorage.get(CODEX_MODEL_KEY);
  const savedEffort = settingsStorage.get(CODEX_EFFORT_KEY);

  if (savedModel === null && savedEffort === null) {
    const initial = hasSavedButlerCodexSettings()
      ? getButlerCodexSettings()
      : { model: '', effort: 'high' as const };
    setAgentHostingCodexSettings(initial);
    return initial;
  }

  const model = savedModel?.trim() ?? '';
  const effort = BUTLER_CODEX_EFFORTS.find((value) => value === savedEffort) ?? 'high';
  return { model, effort };
}

export function setAgentHostingCodexSettings(settings: ButlerCodexSettings): void {
  settingsStorage.set(CODEX_MODEL_KEY, settings.model.trim());
  settingsStorage.set(CODEX_EFFORT_KEY, settings.effort);
}

export function setAgentHostingSettingsStorage(storage: ButlerBrainStorage): () => void {
  const previous = settingsStorage;
  settingsStorage = storage;
  return () => {
    settingsStorage = previous;
  };
}
