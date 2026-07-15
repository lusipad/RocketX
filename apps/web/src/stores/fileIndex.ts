import { create } from 'zustand';
import type { RcRoomFile } from '@rcx/rc-client';
import { getServerBase } from '../lib/client';
import {
  emptyFileIndex,
  fileIndexStorageKey,
  indexRoomFiles,
  parseFileIndex,
  type FileIndexStateV1,
} from '../lib/fileIndex';

interface FileIndexStore {
  ownerId: string | null;
  ownerServer: string | null;
  index: FileIndexStateV1;
  hydrate: (userId: string) => void;
  indexRoom: (rid: string, roomName: string, files: RcRoomFile[]) => void;
}

function persist(server: string, userId: string, index: FileIndexStateV1): void {
  try {
    localStorage.setItem(fileIndexStorageKey(server, userId), JSON.stringify(index));
  } catch {
    /* 存储不可用时只保留当前会话索引 */
  }
}

export const useFileIndex = create<FileIndexStore>((set, get) => ({
  ownerId: null,
  ownerServer: null,
  index: emptyFileIndex(),

  hydrate: (userId) => {
    const server = getServerBase();
    if (get().ownerId === userId && get().ownerServer === server) return;
    let index = emptyFileIndex();
    try {
      index = parseFileIndex(localStorage.getItem(fileIndexStorageKey(server, userId)));
    } catch {
      /* 使用空索引 */
    }
    set({ ownerId: userId, ownerServer: server, index });
  },

  indexRoom: (rid, roomName, files) => {
    const { ownerId, ownerServer, index } = get();
    if (!ownerId || ownerServer === null) return;
    const next = indexRoomFiles(index, rid, roomName, files);
    persist(ownerServer, ownerId, next);
    set({ index: next });
  },
}));
