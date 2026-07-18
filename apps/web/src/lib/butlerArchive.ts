import { createMemoryBackend, createRcxStore, type RcxStoreBackend } from '@rcx/rcx-store';
import { isTauri } from './http';

export interface ButlerProfileStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ButlerArchiveMemoryEntry {
  text: string;
  at: number;
}

export interface ButlerArchiveSkill {
  name: string;
  description: string;
  body: string;
}

const ARCHIVE_APP_ID = 'rocketx.butler';
const ARCHIVE_KEY = 'archive';
const ARCHIVE_KEYS = [
  'rcx-butler-v1:persona',
  'rcx-butler-v1:memory',
  'rcx-butler-v1:skills',
  'rcx-butler-v1:routines',
  'rcx-butler-v1:routine-seen',
] as const;

export type ButlerArchiveKey = (typeof ARCHIVE_KEYS)[number];
export type ButlerArchiveSnapshot = Partial<Record<ButlerArchiveKey, string>>;

const archiveKeySet = new Set<string>(ARCHIVE_KEYS);

const localStorageFallback: ButlerProfileStorage = {
  get: (key) => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      console.warn('[Butler archive] 读取 localStorage 失败', error);
      return null;
    }
  },
  set: () => undefined,
};

const defaultBackend = (): RcxStoreBackend | undefined =>
  typeof globalThis.indexedDB === 'undefined' ? createMemoryBackend() : undefined;

let fallbackStorage: ButlerProfileStorage = localStorageFallback;
let archiveBackend = defaultBackend();
let archiveStore = archiveBackend ? createRcxStore({ backend: archiveBackend }) : createRcxStore();
let cache = new Map<string, string>();
let cacheVersion = 0;
let writeQueue = Promise.resolve();
let hydration: Promise<void> | undefined;
let hydrated = false;
const hydratedListeners = new Set<() => void>();
let mirrorQueue = Promise.resolve();

function readFallbackSnapshot(): ButlerArchiveSnapshot {
  const snapshot: ButlerArchiveSnapshot = {};
  for (const key of ARCHIVE_KEYS) {
    const value = fallbackStorage.get(key);
    if (value !== null) snapshot[key] = value;
  }
  return snapshot;
}

function setCache(snapshot: ButlerArchiveSnapshot): void {
  cache = new Map(Object.entries(snapshot));
  cacheVersion += 1;
}

function snapshotFromCache(): ButlerArchiveSnapshot {
  const snapshot: ButlerArchiveSnapshot = {};
  for (const key of ARCHIVE_KEYS) {
    const value = cache.get(key);
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function snapshotFromStored(value: unknown): ButlerArchiveSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot: ButlerArchiveSnapshot = {};
  for (const key of ARCHIVE_KEYS) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === 'string') snapshot[key] = entry;
  }
  return snapshot;
}

function warnPersistence(error: unknown): void {
  console.warn('[Butler archive] 写入 IndexedDB 失败', error);
}

function persistSnapshot(): void {
  const snapshot = snapshotFromCache();
  const version = cacheVersion;
  writeQueue = writeQueue
    .then(() => version === cacheVersion
      ? archiveStore.appData.set(ARCHIVE_APP_ID, ARCHIVE_KEY, snapshot)
      : undefined)
    .catch(warnPersistence);
}

function notifyHydrated(): void {
  for (const listener of hydratedListeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[Butler archive] 水合回调失败', error);
    }
  }
}

setCache(readFallbackSnapshot());

export const butlerArchiveStorage: ButlerProfileStorage = {
  get: (key) => cache.get(key) ?? null,
  set: (key, value) => {
    cache.set(key, value);
    cacheVersion += 1;
    if (archiveKeySet.has(key)) persistSnapshot();
  },
};

export function setButlerArchiveBackend(backend: RcxStoreBackend): () => void {
  const previousBackend = archiveBackend;
  const previousStore = archiveStore;
  const previousCache = cache;
  const previousCacheVersion = cacheVersion;
  const previousHydration = hydration;
  const previousHydrated = hydrated;
  archiveBackend = backend;
  archiveStore = createRcxStore({ backend });
  setCache(readFallbackSnapshot());
  hydration = undefined;
  hydrated = false;
  return () => {
    archiveBackend = previousBackend;
    archiveStore = previousStore;
    cache = previousCache;
    cacheVersion = previousCacheVersion;
    hydration = previousHydration;
    hydrated = previousHydrated;
  };
}

export function setButlerArchiveFallbackStorage(storage: ButlerProfileStorage): () => void {
  const previous = fallbackStorage;
  const previousCache = cache;
  const previousCacheVersion = cacheVersion;
  const previousHydration = hydration;
  const previousHydrated = hydrated;
  fallbackStorage = storage;
  setCache(readFallbackSnapshot());
  hydration = undefined;
  hydrated = false;
  return () => {
    fallbackStorage = previous;
    cache = previousCache;
    cacheVersion = previousCacheVersion;
    hydration = previousHydration;
    hydrated = previousHydrated;
  };
}

export function flushButlerArchiveWrites(): Promise<void> {
  return writeQueue;
}

export function onButlerArchiveHydrated(listener: () => void): () => void {
  hydratedListeners.add(listener);
  if (hydrated) listener();
  return () => hydratedListeners.delete(listener);
}

export function hydrateButlerArchive(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    try {
      const stored = snapshotFromStored(await archiveStore.appData.get<unknown>(ARCHIVE_APP_ID, ARCHIVE_KEY));
      if (stored) {
        setCache(stored);
        return;
      }
      const fallback = snapshotFromCache();
      if (Object.keys(fallback).length === 0) return;
      await archiveStore.appData.set(ARCHIVE_APP_ID, ARCHIVE_KEY, fallback);
    } catch (error) {
      console.warn('[Butler archive] 水合 IndexedDB 失败', error);
    } finally {
      hydrated = true;
      notifyHydrated();
    }
  })();
  return hydration;
}

export function renderButlerSkillFile(skill: ButlerArchiveSkill): string {
  return `# ${skill.name}\n${skill.description}\n\n${skill.body}\n`;
}

export function renderButlerMemoryFile(entries: readonly ButlerArchiveMemoryEntry[]): string {
  const facts = entries.map((entry) => `- [${new Date(entry.at).toISOString()}] ${entry.text}`);
  return ['AI 保存的事实，供 AI 只读参考。', '', ...facts, ''].join('\n');
}

function skillRelativePath(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error(`技能名不能用于文件路径：${name}`);
  }
  return `skills/${name}.md`;
}

function absolutePath(homeDir: string, relativePath: string): string {
  return `${homeDir.replace(/[\\/]+$/, '')}/${relativePath}`;
}

function enqueueMirror(task: () => Promise<void>): Promise<void> {
  mirrorQueue = mirrorQueue.then(task).catch((error) => {
    console.warn('[Butler archive] 写入桌面档案镜像失败', error);
  });
  return mirrorQueue;
}

export function mirrorButlerArchiveFiles(
  memory: readonly ButlerArchiveMemoryEntry[],
  skills: readonly ButlerArchiveSkill[],
): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return enqueueMirror(async () => {
    const [{ invoke }, { writeFile }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const homeDir = await invoke<string>('butler_home_dir');
    await writeFile(
      absolutePath(homeDir, 'memory/facts.md'),
      new TextEncoder().encode(renderButlerMemoryFile(memory)),
    );
    for (const skill of skills) {
      await writeFile(
        absolutePath(homeDir, skillRelativePath(skill.name)),
        new TextEncoder().encode(renderButlerSkillFile(skill)),
      );
    }
  });
}

export function removeButlerArchiveSkillFile(name: string): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return enqueueMirror(async () => {
    const [{ invoke }, { remove }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const homeDir = await invoke<string>('butler_home_dir');
    await remove(absolutePath(homeDir, skillRelativePath(name)));
  });
}
