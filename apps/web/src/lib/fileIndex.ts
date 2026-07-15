import { tsMs, type RcRoomFile, type RoomType } from '@rcx/rc-client';

export const FILE_INDEX_VERSION = 1;
export const MAX_INDEXED_ROOMS = 20;
export const MAX_FILES_PER_ROOM = 50;

export interface IndexedRoomFilesV1 {
  rid: string;
  roomName: string;
  indexedAt: number;
  files: RcRoomFile[];
}

export interface FileIndexStateV1 {
  version: 1;
  rooms: IndexedRoomFilesV1[];
}

export interface IndexedFileResult {
  rid: string;
  roomName: string;
  indexedAt: number;
  file: RcRoomFile;
}

export function emptyFileIndex(): FileIndexStateV1 {
  return { version: FILE_INDEX_VERSION, rooms: [] };
}

export function fileIndexStorageKey(server: string, userId: string): string {
  const normalizedServer = server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
  return `rcx-file-index-v${FILE_INDEX_VERSION}:${encodeURIComponent(normalizedServer)}:${encodeURIComponent(userId)}`;
}

function metadataOf(file: RcRoomFile): RcRoomFile {
  return {
    _id: file._id,
    name: file.name,
    type: file.type,
    size: file.size,
    uploadedAt: file.uploadedAt,
    user: file.user,
  };
}

export function indexRoomFiles(
  current: FileIndexStateV1,
  rid: string,
  roomName: string,
  files: RcRoomFile[],
  indexedAt = Date.now(),
): FileIndexStateV1 {
  const room: IndexedRoomFilesV1 = {
    rid,
    roomName: roomName || '会话',
    indexedAt,
    files: files.slice(0, MAX_FILES_PER_ROOM).map(metadataOf),
  };
  return {
    version: FILE_INDEX_VERSION,
    rooms: [room, ...current.rooms.filter((item) => item.rid !== rid)].slice(0, MAX_INDEXED_ROOMS),
  };
}

export function parseFileIndex(raw: string | null): FileIndexStateV1 {
  if (!raw) return emptyFileIndex();
  try {
    const value = JSON.parse(raw) as Partial<FileIndexStateV1>;
    if (value.version !== FILE_INDEX_VERSION || !Array.isArray(value.rooms)) return emptyFileIndex();
    let next = emptyFileIndex();
    for (const room of value.rooms.slice().reverse()) {
      if (
        !room ||
        typeof room.rid !== 'string' ||
        typeof room.roomName !== 'string' ||
        typeof room.indexedAt !== 'number' ||
        !Array.isArray(room.files)
      ) continue;
      const files = room.files.filter(
        (file): file is RcRoomFile => !!file && typeof file._id === 'string' && typeof file.name === 'string',
      );
      next = indexRoomFiles(next, room.rid, room.roomName, files, room.indexedAt);
    }
    return next;
  } catch {
    return emptyFileIndex();
  }
}

export function searchIndexedFiles(
  index: FileIndexStateV1,
  keyword: string,
  limit = 20,
): IndexedFileResult[] {
  const q = keyword.trim().toLocaleLowerCase();
  if (!q) return [];
  return index.rooms
    .flatMap((room) =>
      room.files
        .filter((file) => file.name.toLocaleLowerCase().includes(q))
        .map((file) => ({ rid: room.rid, roomName: room.roomName, indexedAt: room.indexedAt, file })),
    )
    .sort((a, b) => tsMs(b.file.uploadedAt) - tsMs(a.file.uploadedAt) || b.indexedAt - a.indexedAt)
    .slice(0, limit);
}

/** 已离开的私有房间不能仅凭旧索引继续出现在搜索中。 */
export function canSearchIndexedRoom(hasSubscription: boolean, roomType?: RoomType): boolean {
  return hasSubscription || roomType === 'c';
}
