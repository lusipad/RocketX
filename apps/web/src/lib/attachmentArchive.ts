import type { RcMessage } from '@rcx/rc-client';

export const ATTACHMENT_ARCHIVE_VERSION = 1;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface AttachmentArchiveSettingsV1 {
  enabled: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
  retentionDays: number;
}

export const DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS: AttachmentArchiveSettingsV1 = {
  enabled: false,
  maxFileBytes: 25 * MIB,
  maxTotalBytes: 2 * GIB,
  retentionDays: 30,
};

export interface AttachmentArchiveCandidate {
  fileId: string;
  rid: string;
  name: string;
  sourcePath: string;
  size?: number;
}

export interface ArchivedAttachmentV1 {
  fileId: string;
  rid: string;
  roomName: string;
  name: string;
  sourcePath: string;
  size: number;
  cachedAt: number;
}

export interface AttachmentArchiveV1 {
  version: 1;
  records: ArchivedAttachmentV1[];
}

export interface RoomArchiveSummary {
  rid: string;
  roomName: string;
  files: number;
  bytes: number;
  latestCachedAt: number;
}

function normalizedServer(server: string): string {
  return server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
}

export function attachmentArchiveStorageKey(server: string, userId: string): string {
  return `rcx-attachment-archive-v${ATTACHMENT_ARCHIVE_VERSION}:${encodeURIComponent(normalizedServer(server))}:${encodeURIComponent(userId)}`;
}

export function attachmentArchiveSettingsKey(server: string, userId: string): string {
  return `rcx-attachment-archive-settings-v${ATTACHMENT_ARCHIVE_VERSION}:${encodeURIComponent(normalizedServer(server))}:${encodeURIComponent(userId)}`;
}

export function emptyAttachmentArchive(): AttachmentArchiveV1 {
  return { version: ATTACHMENT_ARCHIVE_VERSION, records: [] };
}

export function archiveCandidateOf(message: RcMessage): AttachmentArchiveCandidate | null {
  if (message.rocketxLocalPath || !message.file?._id || !message.file.name) return null;
  const attachment = message.attachments?.find((item) =>
    !!item.title_link && (item.title_link_download === true || !!item.image_url),
  );
  const sourcePath = attachment?.title_link ?? attachment?.image_url;
  if (!sourcePath || sourcePath.startsWith('rocketx-local:')) return null;
  return {
    fileId: message.file._id,
    rid: message.rid,
    name: message.file.name,
    sourcePath,
    size: message.file.size,
  };
}

function isArchivedAttachment(value: unknown): value is ArchivedAttachmentV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ArchivedAttachmentV1>;
  return (
    typeof record.fileId === 'string' && record.fileId.length > 0 && record.fileId.length <= 512 &&
    typeof record.rid === 'string' && record.rid.length > 0 && record.rid.length <= 512 &&
    typeof record.roomName === 'string' &&
    typeof record.name === 'string' && record.name.length > 0 &&
    typeof record.sourcePath === 'string' && record.sourcePath.length > 0 &&
    typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0 &&
    typeof record.cachedAt === 'number' && Number.isFinite(record.cachedAt) && record.cachedAt >= 0
  );
}

export function recordArchivedAttachment(
  current: AttachmentArchiveV1,
  record: ArchivedAttachmentV1,
): AttachmentArchiveV1 {
  return {
    version: ATTACHMENT_ARCHIVE_VERSION,
    records: [record, ...current.records.filter((item) => (
      item.fileId !== record.fileId || item.rid !== record.rid
    ))]
      .sort((a, b) => b.cachedAt - a.cachedAt),
  };
}

export function parseAttachmentArchive(raw: string | null): AttachmentArchiveV1 {
  if (!raw) return emptyAttachmentArchive();
  try {
    const value = JSON.parse(raw) as Partial<AttachmentArchiveV1>;
    if (value.version !== ATTACHMENT_ARCHIVE_VERSION || !Array.isArray(value.records)) {
      return emptyAttachmentArchive();
    }
    let next = emptyAttachmentArchive();
    for (const record of value.records.slice().reverse()) {
      if (isArchivedAttachment(record)) next = recordArchivedAttachment(next, record);
    }
    return next;
  } catch {
    return emptyAttachmentArchive();
  }
}

export function parseAttachmentArchiveSettings(raw: string | null): AttachmentArchiveSettingsV1 {
  if (!raw) return DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<AttachmentArchiveSettingsV1>;
    return {
      enabled: value.enabled === true,
      maxFileBytes: numberInRange(value.maxFileBytes, MIB, 1024 * MIB, DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS.maxFileBytes),
      maxTotalBytes: numberInRange(value.maxTotalBytes, 100 * MIB, 100 * GIB, DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS.maxTotalBytes),
      retentionDays: numberInRange(value.retentionDays, 1, 3650, DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS.retentionDays),
    };
  } catch {
    return DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS;
  }
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function roomArchiveSummaries(state: AttachmentArchiveV1): RoomArchiveSummary[] {
  const rooms = new Map<string, RoomArchiveSummary>();
  for (const record of state.records) {
    const room = rooms.get(record.rid) ?? {
      rid: record.rid,
      roomName: record.roomName || '会话',
      files: 0,
      bytes: 0,
      latestCachedAt: 0,
    };
    room.roomName = record.roomName || room.roomName;
    room.files += 1;
    room.bytes += record.size;
    room.latestCachedAt = Math.max(room.latestCachedAt, record.cachedAt);
    rooms.set(record.rid, room);
  }
  return [...rooms.values()].sort((a, b) => b.latestCachedAt - a.latestCachedAt);
}

export function planAttachmentArchiveCleanup(
  state: AttachmentArchiveV1,
  settings: AttachmentArchiveSettingsV1,
  now = Date.now(),
): { keep: ArchivedAttachmentV1[]; remove: ArchivedAttachmentV1[] } {
  const expiry = now - settings.retentionDays * 86_400_000;
  const ordered = [...state.records].sort((a, b) => a.cachedAt - b.cachedAt);
  const remove = ordered.filter((item) => item.cachedAt < expiry);
  const keep = ordered.filter((item) => item.cachedAt >= expiry);
  let total = keep.reduce((sum, item) => sum + item.size, 0);
  while (total > settings.maxTotalBytes && keep.length > 0) {
    const oldest = keep.shift()!;
    total -= oldest.size;
    remove.push(oldest);
  }
  return {
    keep: keep.sort((a, b) => b.cachedAt - a.cachedAt),
    remove: remove.sort((a, b) => a.cachedAt - b.cachedAt),
  };
}
