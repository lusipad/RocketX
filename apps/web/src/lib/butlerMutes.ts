export const BUTLER_MUTES_KEY = 'rcx-butler-v1:mutes';

const MAX_MUTES = 50;

export interface ButlerMute {
  id: string;
  text: string;
  createdAt: number;
}

export interface ButlerMutesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ButlerMutesStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function validMute(value: unknown): value is ButlerMute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mute = value as Record<string, unknown>;
  return typeof mute.id === 'string'
    && !!mute.id.trim()
    && typeof mute.text === 'string'
    && !!mute.text.trim()
    && typeof mute.createdAt === 'number'
    && Number.isFinite(mute.createdAt);
}

export function listMutes(storage: ButlerMutesStorage | undefined = browserStorage()): ButlerMute[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(BUTLER_MUTES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validMute).slice(-MAX_MUTES);
  } catch {
    return [];
  }
}

export function addMute(
  text: string,
  storage: ButlerMutesStorage | undefined = browserStorage(),
  createdAt = Date.now(),
): ButlerMute | null {
  const trimmed = text.trim();
  if (!trimmed || !storage) return null;
  const mute = {
    id: `mute-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    createdAt,
  } satisfies ButlerMute;
  const mutes = [...listMutes(storage), mute].slice(-MAX_MUTES);
  storage.setItem(BUTLER_MUTES_KEY, JSON.stringify(mutes));
  return mute;
}

export function removeMute(
  id: string,
  storage: ButlerMutesStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  storage.setItem(
    BUTLER_MUTES_KEY,
    JSON.stringify(listMutes(storage).filter((mute) => mute.id !== id)),
  );
}

export function matchesMute(
  title: string,
  mutes: readonly Pick<ButlerMute, 'text'>[],
): boolean {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return false;
  return mutes.some((mute) => {
    const normalizedMute = normalize(mute.text);
    return !!normalizedMute
      && (normalizedMute.includes(normalizedTitle) || normalizedTitle.includes(normalizedMute));
  });
}
