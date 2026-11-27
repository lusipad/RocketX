import { getLocale, type ResolvedLocale } from './index';

function toDate(value: number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDateTime(
  value: number | Date,
  options?: Intl.DateTimeFormatOptions,
  locale: ResolvedLocale = getLocale(),
): string {
  return new Intl.DateTimeFormat(locale, options).format(toDate(value));
}

export function formatDate(
  value: number | Date,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' },
  locale: ResolvedLocale = getLocale(),
): string {
  return new Intl.DateTimeFormat(locale, options).format(toDate(value));
}

export function formatTime(
  value: number | Date,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
  locale: ResolvedLocale = getLocale(),
): string {
  return new Intl.DateTimeFormat(locale, options).format(toDate(value));
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale: ResolvedLocale = getLocale(),
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function compareLocaleText(
  a: string,
  b: string,
  locale: ResolvedLocale = getLocale(),
): number {
  return a.localeCompare(b, locale);
}
