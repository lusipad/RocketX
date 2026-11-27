import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import {
  loadLocalePreference,
  normalizeLocalePreference,
  resolveLocale,
  saveLocalePreference,
  type LocalePreference,
  type ResolvedLocale,
} from './locale';
import { enUS } from './locales/en-US';
import { zhCN } from './locales/zh-CN';

export type { LocalePreference, ResolvedLocale } from './locale';
export { LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, loadLocalePreference, normalizeLocalePreference, resolveLocale, resolveSystemLocale, saveLocalePreference } from './locale';

export type Messages = typeof zhCN;
export type MessageKey = keyof Messages;
export type TranslateParams = Record<string, string | number>;

const CATALOGS: Record<ResolvedLocale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export interface I18nState {
  preference: LocalePreference;
  locale: ResolvedLocale;
  setPreference: (preference: LocalePreference) => void;
  refreshSystemLocale: () => void;
}

const initialPreference = loadLocalePreference();
const initialLocale = resolveLocale(initialPreference);

export function applyDocumentLocale(locale: ResolvedLocale): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = locale;
  }
}

export const useI18nStore = create<I18nState>((set, get) => ({
  preference: initialPreference,
  locale: initialLocale,
  setPreference: (rawPreference) => {
    const preference = normalizeLocalePreference(rawPreference);
    saveLocalePreference(preference);
    const locale = resolveLocale(preference);
    applyDocumentLocale(locale);
    set({ preference, locale });
  },
  refreshSystemLocale: () => {
    const { preference, locale: current } = get();
    if (preference !== 'system') return;
    const next = resolveLocale('system');
    if (next !== current) {
      applyDocumentLocale(next);
      set({ locale: next });
    }
  },
}));

let languageListenerAttached = false;

export function initI18n(): void {
  const preference = loadLocalePreference();
  const locale = resolveLocale(preference);
  useI18nStore.setState({ preference, locale });
  applyDocumentLocale(locale);
  if (typeof window !== 'undefined' && !languageListenerAttached) {
    languageListenerAttached = true;
    window.addEventListener?.('languagechange', () => {
      useI18nStore.getState().refreshSystemLocale();
    });
  }
}

export function getLocale(): ResolvedLocale {
  return useI18nStore.getState().locale;
}

export function getLocalePreference(): LocalePreference {
  return useI18nStore.getState().preference;
}

export function setLocalePreference(preference: LocalePreference): void {
  useI18nStore.getState().setPreference(preference);
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key: string) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : full
  ));
}

export function t(
  key: MessageKey,
  params?: TranslateParams,
  locale: ResolvedLocale = getLocale(),
): string {
  const catalog = CATALOGS[locale] ?? zhCN;
  const template = catalog[key] ?? zhCN[key];
  return interpolate(template, params);
}

export function tp(
  count: number,
  oneKey: MessageKey,
  otherKey: MessageKey,
  params?: TranslateParams,
  locale: ResolvedLocale = getLocale(),
): string {
  const key = locale === 'en-US' && count === 1 ? oneKey : otherKey;
  return t(key, { count, ...params }, locale);
}

export function useLocale(): ResolvedLocale {
  return useI18nStore((state) => state.locale);
}

export type TranslateFn = (key: MessageKey, params?: TranslateParams) => string;
export type PluralTranslateFn = (
  count: number,
  oneKey: MessageKey,
  otherKey: MessageKey,
  params?: TranslateParams,
) => string;

export function useT(): TranslateFn {
  const locale = useLocale();
  return useCallback<TranslateFn>(
    (key, params) => t(key, params, locale),
    [locale],
  );
}

export function useI18n(): {
  locale: ResolvedLocale;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  t: TranslateFn;
  tp: PluralTranslateFn;
} {
  const locale = useI18nStore((state) => state.locale);
  const preference = useI18nStore((state) => state.preference);
  const setPreference = useI18nStore((state) => state.setPreference);
  const translate = useCallback<TranslateFn>(
    (key, params) => t(key, params, locale),
    [locale],
  );
  const translatePlural = useCallback<PluralTranslateFn>(
    (count, oneKey, otherKey, params) => tp(count, oneKey, otherKey, params, locale),
    [locale],
  );
  return useMemo(
    () => ({
      locale,
      preference,
      setPreference,
      t: translate,
      tp: translatePlural,
    }),
    [locale, preference, setPreference, translate, translatePlural],
  );
}

export function buildUiLanguageInstruction(locale: ResolvedLocale = getLocale()): string {
  return t('ai.languageInstruction', undefined, locale);
}

if (typeof window !== 'undefined') {
  (window as unknown as { __i18n?: typeof useI18nStore }).__i18n = useI18nStore;
}
