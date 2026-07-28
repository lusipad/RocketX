import {
  butlerArchiveStorage,
  type ButlerProfileStorage,
} from '../lib/butlerArchive';
import type { ButlerExtensionStateStore } from '../kernel/butlerExtensions';

const EXTENSIONS_KEY = 'rcx-butler-v1:extensions';

type ExtensionStateDocument = Record<string, unknown>;

function readDocument(storage: ButlerProfileStorage): ExtensionStateDocument {
  const raw = storage.get(EXTENSIONS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ExtensionStateDocument
      : {};
  } catch {
    return {};
  }
}

export function createButlerArchiveExtensionStateStore(
  storage: ButlerProfileStorage = butlerArchiveStorage,
): ButlerExtensionStateStore {
  return {
    read: <T>(extensionId: string) => readDocument(storage)[extensionId] as T | undefined,
    write: <T>(extensionId: string, state: T) => {
      const document = readDocument(storage);
      storage.set(EXTENSIONS_KEY, JSON.stringify({ ...document, [extensionId]: state }));
    },
  };
}
