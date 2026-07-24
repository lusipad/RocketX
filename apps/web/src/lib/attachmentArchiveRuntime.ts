import type { RcMessage } from '@rcx/rc-client';
import { getServerBase, isTauri, loadStoredAuth, rest } from './client';
import {
  DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS,
  archiveCandidateOf,
  attachmentArchiveSettingsKey,
  attachmentArchiveStorageKey,
  emptyAttachmentArchive,
  isAttachmentArchiveSuppressed,
  parseAttachmentArchive,
  parseAttachmentArchiveSettings,
  planAttachmentArchiveCleanup,
  recordArchivedAttachment,
  suppressArchivedAttachments,
  type ArchivedAttachmentV1,
  type AttachmentArchiveSettingsV1,
  type AttachmentArchiveV1,
} from './attachmentArchive';

export const ATTACHMENT_ARCHIVE_CHANGED = 'rocketx-attachment-archive-changed';

export interface AttachmentArchiveSnapshot {
  settings: AttachmentArchiveSettingsV1;
  archive: AttachmentArchiveV1;
}

const retryAfter = new Map<string, number>();
let queue = Promise.resolve();

function owner(): { server: string; userId: string } | null {
  const auth = loadStoredAuth();
  return auth ? { server: getServerBase(), userId: auth.userId } : null;
}

function sameOwner(
  left: { server: string; userId: string } | null,
  right: { server: string; userId: string },
): boolean {
  return !!left && left.server === right.server && left.userId === right.userId;
}

function readFor(current: { server: string; userId: string }): AttachmentArchiveSnapshot {
  try {
    return {
      settings: parseAttachmentArchiveSettings(
        localStorage.getItem(attachmentArchiveSettingsKey(current.server, current.userId)),
      ),
      archive: parseAttachmentArchive(
        localStorage.getItem(attachmentArchiveStorageKey(current.server, current.userId)),
      ),
    };
  } catch {
    return { settings: DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS, archive: emptyAttachmentArchive() };
  }
}

export function readAttachmentArchiveSnapshot(): AttachmentArchiveSnapshot {
  const current = owner();
  return current ? readFor(current) : {
    settings: DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS,
    archive: emptyAttachmentArchive(),
  };
}

function persistArchive(current: { server: string; userId: string }, archive: AttachmentArchiveV1): void {
  localStorage.setItem(attachmentArchiveStorageKey(current.server, current.userId), JSON.stringify(archive));
  window.dispatchEvent(new CustomEvent(ATTACHMENT_ARCHIVE_CHANGED));
}

export function saveAttachmentArchiveSettings(settings: AttachmentArchiveSettingsV1): void {
  const current = owner();
  if (!current) return;
  localStorage.setItem(
    attachmentArchiveSettingsKey(current.server, current.userId),
    JSON.stringify(settings),
  );
  window.dispatchEvent(new CustomEvent(ATTACHMENT_ARCHIVE_CHANGED));
  queue = queue.then(async () => {
    await cleanupArchive(current, readFor(current));
  }).catch(() => {});
}

async function hashSegment(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return (cleaned || 'attachment').slice(-120);
}

async function archiveRoot(current: { server: string; userId: string }): Promise<string> {
  const [{ appDataDir, join }, scope] = await Promise.all([
    import('@tauri-apps/api/path'),
    hashSegment(`${current.server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin'}\0${current.userId}`),
  ]);
  return join(await appDataDir(), 'attachment-archive', scope);
}

async function roomDirectory(
  current: { server: string; userId: string },
  rid: string,
): Promise<string> {
  const [{ join }, root, room] = await Promise.all([
    import('@tauri-apps/api/path'),
    archiveRoot(current),
    hashSegment(rid),
  ]);
  return join(root, room);
}

async function recordPath(
  current: { server: string; userId: string },
  record: Pick<ArchivedAttachmentV1, 'fileId' | 'rid' | 'name'>,
): Promise<string> {
  const [{ join }, directory, file] = await Promise.all([
    import('@tauri-apps/api/path'),
    roomDirectory(current, record.rid),
    hashSegment(record.fileId),
  ]);
  return join(directory, `${file}-${safeFileName(record.name)}`);
}

function limitedStream(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      received += next.value.byteLength;
      if (received > limit) {
        await reader.cancel();
        controller.error(new Error('附件超过本地留存的单文件上限'));
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function removeRecords(
  current: { server: string; userId: string },
  records: ArchivedAttachmentV1[],
): Promise<{ removed: ArchivedAttachmentV1[]; failed: ArchivedAttachmentV1[] }> {
  const { remove } = await import('@tauri-apps/plugin-fs');
  const removed: ArchivedAttachmentV1[] = [];
  const failed: ArchivedAttachmentV1[] = [];
  for (const record of records) {
    try {
      await remove(await recordPath(current, record));
      removed.push(record);
    } catch {
      failed.push(record);
    }
  }
  return { removed, failed };
}

async function cleanupArchive(
  current: { server: string; userId: string },
  snapshot: AttachmentArchiveSnapshot,
): Promise<AttachmentArchiveV1> {
  const plan = planAttachmentArchiveCleanup(snapshot.archive, snapshot.settings);
  if (plan.remove.length === 0) return snapshot.archive;
  const result = await removeRecords(current, plan.remove);
  if (result.removed.length === 0) return snapshot.archive;
  const archive: AttachmentArchiveV1 = {
    version: 1 as const,
    records: [...plan.keep, ...result.failed].sort((a, b) => b.cachedAt - a.cachedAt),
  };
  if (snapshot.archive.suppressed?.length) {
    archive.suppressed = snapshot.archive.suppressed;
  }
  persistArchive(current, archive);
  return archive;
}

async function archiveMessage(
  current: { server: string; userId: string },
  message: RcMessage,
  roomName: string,
): Promise<void> {
  if (!isTauri || !sameOwner(owner(), current)) return;
  const candidate = archiveCandidateOf(message);
  if (!candidate) return;
  const snapshot = readFor(current);
  if (!snapshot.settings.enabled || snapshot.archive.records.some((item) => (
    item.fileId === candidate.fileId && item.rid === candidate.rid
  )) || isAttachmentArchiveSuppressed(snapshot.archive, candidate)) return;
  if (candidate.size !== undefined && candidate.size > snapshot.settings.maxFileBytes) return;

  const key = `${current.server}\0${current.userId}\0${candidate.rid}\0${candidate.fileId}`;
  if ((retryAfter.get(key) ?? 0) > Date.now()) return;
  const path = await recordPath(current, candidate);
  try {
    const response = await rest.fetchFileResponse(candidate.sourcePath);
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > snapshot.settings.maxFileBytes) return;
    if (!response.body) throw new Error('附件响应没有可读取的内容');
    const { mkdir, remove, stat, writeFile } = await import('@tauri-apps/plugin-fs');
    await mkdir(await roomDirectory(current, candidate.rid), { recursive: true });
    await writeFile(path, limitedStream(response.body, snapshot.settings.maxFileBytes));
    const metadata = await stat(path);
    if (!sameOwner(owner(), current)) {
      await remove(path).catch(() => {});
      return;
    }
    const latest = readFor(current);
    if (!latest.settings.enabled || metadata.size > latest.settings.maxFileBytes || isAttachmentArchiveSuppressed(latest.archive, candidate)) {
      await remove(path).catch(() => {});
      return;
    }
    const archive = recordArchivedAttachment(latest.archive, {
      ...candidate,
      roomName: roomName || '会话',
      size: metadata.size,
      cachedAt: Date.now(),
    });
    persistArchive(current, archive);
    await cleanupArchive(current, { settings: latest.settings, archive });
    retryAfter.delete(key);
  } catch {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(path).catch(() => {});
    retryAfter.set(key, Date.now() + 5 * 60_000);
  }
}

export function enqueueAttachmentArchives(messages: RcMessage[], roomName: string): void {
  const current = owner();
  if (!isTauri || !current) return;
  for (const message of messages) {
    queue = queue.then(() => archiveMessage(current, message, roomName)).catch(() => {});
  }
}

export function scheduleAttachmentArchiveCleanup(): void {
  if (!isTauri) return;
  const current = owner();
  if (!current) return;
  queue = queue.then(async () => {
    if (sameOwner(owner(), current)) await cleanupArchive(current, readFor(current));
  }).catch(() => {});
}

export async function deleteRoomAttachmentArchive(rid: string): Promise<void> {
  if (!isTauri) return;
  const current = owner();
  if (!current) return;
  const deletion = queue.then(async () => {
    if (!sameOwner(owner(), current)) throw new Error('账号已切换，请重试删除本地附件');
    const snapshot = readFor(current);
    const records = snapshot.archive.records.filter((item) => item.rid === rid);
    if (records.length === 0) return;
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(await roomDirectory(current, rid), { recursive: true });
    persistArchive(current, suppressArchivedAttachments(snapshot.archive, records));
  });
  queue = deletion.catch(() => {});
  await deletion;
}

export async function openRoomAttachmentArchive(rid: string): Promise<void> {
  if (!isTauri) return;
  const current = owner();
  if (!current) return;
  const directory = await roomDirectory(current, rid);
  const { mkdir } = await import('@tauri-apps/plugin-fs');
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await mkdir(directory, { recursive: true });
  await openPath(directory);
}
