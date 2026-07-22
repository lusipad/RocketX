import { create } from 'zustand';
import { getServerBase } from '../lib/client';
import {
  addDownloadRecord,
  downloadHistoryStorageKey,
  emptyDownloadHistory,
  parseDownloadHistory,
  type DownloadHistoryV1,
} from '../lib/downloadHistory';

interface DownloadHistoryStore {
  ownerId: string | null;
  ownerServer: string | null;
  history: DownloadHistoryV1;
  hydrate: (userId: string) => void;
  record: (fileName: string, path: string, completedAt?: number) => void;
  clear: () => void;
}

function persist(server: string, userId: string, history: DownloadHistoryV1): void {
  try {
    localStorage.setItem(downloadHistoryStorageKey(server, userId), JSON.stringify(history));
  } catch {
    /* 存储不可用时只保留当前会话历史 */
  }
}

function nextRecordId(completedAt: number): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${completedAt}-${Math.random().toString(36).slice(2)}`;
  }
}

export const useDownloadHistory = create<DownloadHistoryStore>((set, get) => ({
  ownerId: null,
  ownerServer: null,
  history: emptyDownloadHistory(),

  hydrate: (userId) => {
    const server = getServerBase();
    if (get().ownerId === userId && get().ownerServer === server) return;
    let history = emptyDownloadHistory();
    try {
      history = parseDownloadHistory(
        localStorage.getItem(downloadHistoryStorageKey(server, userId)),
      );
    } catch {
      /* 使用空历史 */
    }
    set({ ownerId: userId, ownerServer: server, history });
  },

  record: (fileName, path, completedAt = Date.now()) => {
    const { ownerId, ownerServer, history } = get();
    if (!ownerId || ownerServer === null) return;
    const next = addDownloadRecord(history, {
      id: nextRecordId(completedAt),
      fileName,
      path,
      completedAt,
    });
    persist(ownerServer, ownerId, next);
    set({ history: next });
  },

  clear: () => {
    const { ownerId, ownerServer } = get();
    if (!ownerId || ownerServer === null) return;
    const next = emptyDownloadHistory();
    persist(ownerServer, ownerId, next);
    set({ history: next });
  },
}));
