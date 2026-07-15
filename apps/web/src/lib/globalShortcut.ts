export const GLOBAL_SHORTCUT_STORAGE_KEY = 'rcx-global-command-shortcut-v1';
export const DEFAULT_GLOBAL_SHORTCUT = 'Control+Alt+K';

export const GLOBAL_SHORTCUT_OPTIONS = [
  { value: DEFAULT_GLOBAL_SHORTCUT, label: 'Ctrl + Alt + K' },
  { value: 'Control+Shift+Space', label: 'Ctrl + Shift + Space' },
  { value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space' },
] as const;

export type GlobalShortcutValue = (typeof GLOBAL_SHORTCUT_OPTIONS)[number]['value'];

export interface GlobalShortcutConfigV1 {
  version: 1;
  enabled: boolean;
  shortcut: GlobalShortcutValue;
}

export function defaultGlobalShortcutConfig(): GlobalShortcutConfigV1 {
  return {
    version: 1,
    enabled: true,
    shortcut: DEFAULT_GLOBAL_SHORTCUT,
  };
}

export function parseGlobalShortcutConfig(raw: string | null): GlobalShortcutConfigV1 {
  if (!raw) return defaultGlobalShortcutConfig();
  try {
    const value = JSON.parse(raw) as Partial<GlobalShortcutConfigV1>;
    if (
      value.version !== 1 ||
      typeof value.enabled !== 'boolean' ||
      !GLOBAL_SHORTCUT_OPTIONS.some((item) => item.value === value.shortcut)
    ) {
      return defaultGlobalShortcutConfig();
    }
    return {
      version: 1,
      enabled: value.enabled,
      shortcut: value.shortcut as GlobalShortcutValue,
    };
  } catch {
    return defaultGlobalShortcutConfig();
  }
}
