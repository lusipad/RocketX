export const AGENT_HOSTING_CODEX_EFFORTS = [
  'default',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export const AGENT_HOSTING_PERMISSION_PRESETS = ['ask', 'auto', 'full'] as const;

export interface AgentHostingCodexSettings {
  model: string;
  effort: (typeof AGENT_HOSTING_CODEX_EFFORTS)[number];
  permissionPreset: (typeof AGENT_HOSTING_PERMISSION_PRESETS)[number];
}

export interface AgentHostingSettingsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const CODEX_MODEL_KEY = 'rcx-agent-hosting-v1:codex-model';
const CODEX_EFFORT_KEY = 'rcx-agent-hosting-v1:codex-effort';
const CODEX_PERMISSION_KEY = 'rcx-agent-hosting-v1:codex-permission';

const localStorageSettings: AgentHostingSettingsStorage = {
  get: (key) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  set: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
};

let settingsStorage: AgentHostingSettingsStorage = localStorageSettings;

export function getAgentHostingCodexSettings(): AgentHostingCodexSettings {
  const model = settingsStorage.get(CODEX_MODEL_KEY)?.trim() ?? '';
  const storedEffort = settingsStorage.get(CODEX_EFFORT_KEY);
  const effort = AGENT_HOSTING_CODEX_EFFORTS.find((value) => value === storedEffort) ?? 'high';
  const storedPermission = settingsStorage.get(CODEX_PERMISSION_KEY);
  const permissionPreset = AGENT_HOSTING_PERMISSION_PRESETS.find(
    (value) => value === storedPermission,
  ) ?? 'auto';
  return { model, effort, permissionPreset };
}

export function setAgentHostingCodexSettings(settings: AgentHostingCodexSettings): void {
  settingsStorage.set(CODEX_MODEL_KEY, settings.model.trim());
  settingsStorage.set(CODEX_EFFORT_KEY, settings.effort);
  settingsStorage.set(CODEX_PERMISSION_KEY, settings.permissionPreset);
}

export function setAgentHostingSettingsStorage(storage: AgentHostingSettingsStorage): () => void {
  const previous = settingsStorage;
  settingsStorage = storage;
  return () => {
    settingsStorage = previous;
  };
}
