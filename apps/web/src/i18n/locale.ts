export type LocalePreference = 'system' | 'zh-CN' | 'en-US';
export type ResolvedLocale = 'zh-CN' | 'en-US';

export const LOCALE_STORAGE_KEY = 'rcx-locale';
export const SUPPORTED_LOCALES: readonly ResolvedLocale[] = ['zh-CN', 'en-US'];

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

function matchLocaleTag(tag: string | undefined): ResolvedLocale | null {
  const normalized = tag?.trim();
  if (!normalized) return null;
  if (/^zh(?:-|_|$)/i.test(normalized)) return 'zh-CN';
  return 'en-US';
}

export function normalizeLocalePreference(raw: unknown): LocalePreference {
  if (raw === 'zh-CN' || raw === 'en-US' || raw === 'system') return raw;
  return 'system';
}

export function resolveSystemLocale(languages?: readonly string[]): ResolvedLocale {
  if (languages) {
    for (const candidate of languages) {
      const matched = matchLocaleTag(candidate);
      if (matched) return matched;
    }
    return 'en-US';
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof navigator !== 'undefined') {
    const browserLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : [];
    for (const candidate of browserLanguages) {
      const matched = matchLocaleTag(candidate);
      if (matched) return matched;
    }
    return 'en-US';
  }

  const envLocale = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RCX_LOCALE;
  if (envLocale) {
    const matched = matchLocaleTag(envLocale);
    if (matched) return matched;
  }

  // Node pure/regression tests have no navigator locale; default to zh-CN for deterministic CI.
  return 'zh-CN';
}

export function resolveLocale(
  preference: LocalePreference,
  languages?: readonly string[],
): ResolvedLocale {
  if (preference === 'zh-CN' || preference === 'en-US') return preference;
  return resolveSystemLocale(languages);
}

export function loadLocalePreference(storage?: StorageReader): LocalePreference {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    return normalizeLocalePreference(target?.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function saveLocalePreference(preference: LocalePreference, storage?: StorageWriter): void {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    target?.setItem(LOCALE_STORAGE_KEY, normalizeLocalePreference(preference));
  } catch {
    /* 存储不可用或隐私模式下忽略持久化失败 */
  }
}
