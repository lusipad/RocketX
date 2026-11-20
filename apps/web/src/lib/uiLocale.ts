import { useSyncExternalStore } from 'react';

export type UiLocale = 'zh' | 'en';
export type UiLocalePreference = 'auto' | UiLocale;

export const UI_LOCALE_STORAGE_KEY = 'rcx-ui-locale';

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function normalizeLocaleTag(languages: readonly (string | undefined | null)[]): UiLocale {
  const first = languages.map((item) => item?.trim() ?? '').find((item) => item.length > 0);
  if (!first) return 'en';
  return /^zh(?:-|_|$)/i.test(first) ? 'zh' : 'en';
}

export function detectSystemUiLocale(
  languages?: readonly string[],
  primaryLanguage?: string,
): UiLocale {
  if (languages !== undefined || primaryLanguage !== undefined) {
    return normalizeLocaleTag([...(languages ?? []), primaryLanguage]);
  }
  if (typeof document === 'undefined') {
    // Node.js 22+ exposes navigator.language (often en-US on CI runners);
    // pure and regression tests without a DOM must stay deterministic.
    return 'zh';
  }
  if (typeof navigator === 'undefined') return 'en';
  return normalizeLocaleTag([
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ]);
}

function resolveStorage(
  storage?: Pick<Storage, 'getItem'>,
): Pick<Storage, 'getItem'> | undefined {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function readUiLocalePreference(
  storage?: Pick<Storage, 'getItem'>,
): UiLocalePreference {
  const target = resolveStorage(storage);
  if (!target) return 'auto';
  try {
    const raw = target.getItem(UI_LOCALE_STORAGE_KEY)?.trim().toLowerCase();
    if (raw === 'zh' || raw === 'en') return raw;
    return 'auto';
  } catch {
    return 'auto';
  }
}

export function resolveUiLocale(storage?: Pick<Storage, 'getItem'>): UiLocale {
  const preference = readUiLocalePreference(storage);
  if (preference === 'zh' || preference === 'en') return preference;
  return detectSystemUiLocale();
}

export function applyUiLocaleDocumentState(storage?: Pick<Storage, 'getItem'>): UiLocale {
  const locale = resolveUiLocale(storage);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }
  return locale;
}

export function saveUiLocalePreference(
  preference: UiLocalePreference,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): UiLocale {
  const target = storage ?? (() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : undefined;
    } catch {
      return undefined;
    }
  })();
  if (target) {
    try {
      if (preference === 'auto') target.removeItem(UI_LOCALE_STORAGE_KEY);
      else target.setItem(UI_LOCALE_STORAGE_KEY, preference);
    } catch {
      /* Ignore storage quota or sandbox restrictions. */
    }
  }
  const resolved = applyUiLocaleDocumentState(target);
  notifyListeners();
  return resolved;
}

function subscribeUiLocale(onChange: () => void): () => void {
  listeners.add(onChange);
  if (typeof window === 'undefined') {
    return () => {
      listeners.delete(onChange);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== UI_LOCALE_STORAGE_KEY) return;
    applyUiLocaleDocumentState();
    onChange();
  };
  const onLanguageChange = () => {
    applyUiLocaleDocumentState();
    onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('languagechange', onLanguageChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('languagechange', onLanguageChange);
  };
}

export function useUiLocale(): UiLocale {
  return useSyncExternalStore(
    subscribeUiLocale,
    () => resolveUiLocale(),
    () => resolveUiLocale(),
  );
}

export function tr(zh: string, en: string, locale = resolveUiLocale()): string {
  return locale === 'zh' ? zh : en;
}

export function containsHan(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

export function localizeDynamicText(
  raw: string | null | undefined,
  enFallback: string,
  locale = resolveUiLocale(),
): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return locale === 'zh' ? '' : enFallback;
  if (locale === 'zh') return trimmed;
  return containsHan(trimmed) ? enFallback : trimmed;
}

export const localizeRuntimeText = localizeDynamicText;
