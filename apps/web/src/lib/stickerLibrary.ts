import { appDataDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { exists, mkdir, readDir, readFile, readTextFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import type { StickerCatalog, StickerEntry, StickerGroup } from './stickerManifest';
import { getServerBase, isTauri, loadStoredAuth, rest } from './client';
import { inferStickerMimeType } from './stickerLoader';
import type { RcMessage, RcMessageAttachment } from '@rcx/rc-client';

const APP_ID = 'builtin:sticker-library';
const VERSION = 1 as const;
const PACKAGE_ID = 'personal-library';
const PACKAGE_TITLE = '个人贴纸库';
const GROUP_ID = 'my-stickers';
const GROUP_TITLE = '我的贴纸';
const MIB = 1024 * 1024;

export interface PersonalStickerRecordV1 {
  id: string;
  digest: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  storedPath: string;
  createdAt: number;
  source: 'file' | 'directory' | 'message';
  tags: string[];
}

export interface PersonalStickerLibraryV1 {
  version: 1;
  records: PersonalStickerRecordV1[];
}

export interface StickerImportCandidate {
  title: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  source: PersonalStickerRecordV1['source'];
  tags: string[];
}

export interface StickerDirectoryEntryLike {
  path?: string;
  name?: string | null;
  isFile?: boolean;
  isDirectory?: boolean;
}

export interface StickerImportReport {
  total: number;
  imported: number;
  duplicates: number;
  unsupported: number;
  quotaSkipped: number;
}

export interface StickerLibraryLimits {
  maxItems: number;
  maxTotalBytes: number;
}

export interface PreparedStickerImport extends StickerImportCandidate {
  digest: string;
  storedPath: string;
  createdAt: number;
}

export interface StickerImportStorageOps {
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  persistLibrary: (library: PersonalStickerLibraryV1) => Promise<void>;
}

export const DEFAULT_STICKER_LIBRARY_LIMITS: StickerLibraryLimits = {
  maxItems: 256,
  maxTotalBytes: 128 * MIB,
};

export function emptyPersonalStickerLibrary(): PersonalStickerLibraryV1 {
  return { version: VERSION, records: [] };
}

function normalizedServer(server: string): string {
  return server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
}

function ownerScope():
  | {
      server: string;
      userId: string;
      key: string;
    }
  | null {
  const auth = loadStoredAuth();
  if (!auth?.userId) return null;
  const server = getServerBase();
  const key = `${encodeURIComponent(normalizedServer(server))}:${encodeURIComponent(auth.userId)}`;
  return { server, userId: auth.userId, key };
}

function libraryKey(scope: { key: string }): string {
  return `library:${scope.key}`;
}

function toPathName(path: string): string {
  return path.split(/[\\/]/).pop()?.trim() || path.trim();
}

function fileStem(path: string): string {
  const name = toPathName(path);
  const index = name.lastIndexOf('.');
  return (index > 0 ? name.slice(0, index) : name).trim() || '贴纸';
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return (cleaned || 'sticker').slice(0, 120);
}

function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isSupportedStickerMimeType(mimeType: string | null | undefined): mimeType is string {
  return typeof mimeType === 'string' && /^image\//i.test(mimeType) && mimeType.toLocaleLowerCase() !== 'image/svg+xml';
}

function imageMimeTypeOf(path: string, declared?: string | null): string | null {
  if (isSupportedStickerMimeType(declared)) return declared;
  const inferred = inferStickerMimeType(path);
  return isSupportedStickerMimeType(inferred) ? inferred : null;
}

function defaultTitle(path: string): string {
  return fileStem(path) || '贴纸';
}

function digestFileName(digest: string, fileName: string): string {
  return `${digest.slice(0, 24)}-${safeFileName(fileName)}`;
}

export function parsePersonalStickerLibrary(raw: unknown): PersonalStickerLibraryV1 {
  if (!raw || typeof raw !== 'object') return emptyPersonalStickerLibrary();
  const value = raw as Partial<PersonalStickerLibraryV1>;
  if (value.version !== VERSION || !Array.isArray(value.records)) return emptyPersonalStickerLibrary();
  const records = value.records
    .filter((record): record is PersonalStickerRecordV1 => {
      if (!record || typeof record !== 'object') return false;
      const candidate = record as Partial<PersonalStickerRecordV1>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.digest === 'string' &&
        typeof candidate.title === 'string' &&
        typeof candidate.fileName === 'string' &&
        typeof candidate.mimeType === 'string' &&
        typeof candidate.size === 'number' &&
        Number.isFinite(candidate.size) &&
        candidate.size >= 0 &&
        typeof candidate.storedPath === 'string' &&
        typeof candidate.createdAt === 'number' &&
        Number.isFinite(candidate.createdAt) &&
        (candidate.source === 'file' || candidate.source === 'directory' || candidate.source === 'message') &&
        Array.isArray(candidate.tags)
      );
    })
    .map((record) => ({ ...record, tags: uniqueTags(record.tags) }))
    .sort((left, right) => right.createdAt - left.createdAt);
  return { version: VERSION, records };
}

async function hashSegment(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function libraryRoot(scope: { server: string; userId: string }): Promise<string> {
  const root = await hashSegment(`${normalizedServer(scope.server)}\0${scope.userId}`);
  return join(await appDataDir(), 'sticker-library', root);
}

async function readLibrary(scope: { key: string }): Promise<PersonalStickerLibraryV1> {
  const { kernelStore } = await import('../kernel/store');
  return parsePersonalStickerLibrary(await kernelStore.appData.get<unknown>(APP_ID, libraryKey(scope)));
}

async function persistLibrary(scope: { key: string }, library: PersonalStickerLibraryV1): Promise<void> {
  const { kernelStore } = await import('../kernel/store');
  await kernelStore.appData.set(APP_ID, libraryKey(scope), library);
}

function personalStickerEntry(record: PersonalStickerRecordV1, src: string): StickerEntry {
  return {
    id: record.id,
    title: record.title,
    packageId: PACKAGE_ID,
    packageTitle: PACKAGE_TITLE,
    groupId: GROUP_ID,
    groupTitle: GROUP_TITLE,
    src,
    fileName: record.fileName,
    mimeType: record.mimeType,
    tags: record.tags,
  };
}

const objectUrls = new Map<string, string>();

function upsertObjectUrl(path: string, bytes: Uint8Array, mimeType: string): string {
  const existing = objectUrls.get(path);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
  objectUrls.set(path, url);
  return url;
}

function pruneObjectUrls(activePaths: Set<string>): void {
  for (const [path, url] of objectUrls) {
    if (activePaths.has(path)) continue;
    URL.revokeObjectURL(url);
    objectUrls.delete(path);
  }
}

export async function loadPersonalStickerCatalog(): Promise<StickerCatalog> {
  const scope = ownerScope();
  if (!scope || !isTauri) return { groups: [], entries: [] };
  const library = await readLibrary(scope);
  if (library.records.length === 0) {
    pruneObjectUrls(new Set());
    return { groups: [], entries: [] };
  }
  const activePaths = new Set<string>();
  const entries: StickerEntry[] = [];
  for (const record of library.records) {
    try {
      const bytes = await readFile(record.storedPath);
      activePaths.add(record.storedPath);
      entries.push(personalStickerEntry(record, upsertObjectUrl(record.storedPath, bytes, record.mimeType)));
    } catch {
      // 本地文件缺失时静默跳过，避免阻塞整个贴纸面板。
    }
  }
  pruneObjectUrls(activePaths);
  if (entries.length === 0) return { groups: [], entries: [] };
  const group: StickerGroup = {
    id: GROUP_ID,
    title: GROUP_TITLE,
    packageId: PACKAGE_ID,
    packageTitle: PACKAGE_TITLE,
    items: entries,
  };
  return { groups: [group], entries };
}

export function mergeStickerCatalogs(personal: StickerCatalog, builtin: StickerCatalog): StickerCatalog {
  return {
    groups: [...personal.groups, ...builtin.groups],
    entries: [...personal.entries, ...builtin.entries],
  };
}

function qqStickerPrefix(stickerId: string): string {
  return `${stickerId}_`.toLocaleLowerCase();
}

export function parseQqStickerDirectory(
  packInfo: unknown,
  files: readonly StickerDirectoryEntryLike[],
): Array<Pick<StickerImportCandidate, 'title' | 'fileName' | 'tags'>> & Array<{ path: string }> {
  if (!packInfo || typeof packInfo !== 'object') return [];
  const value = packInfo as { packName?: unknown; stickers?: unknown };
  const packName = typeof value.packName === 'string' && value.packName.trim() ? value.packName.trim() : 'QQ 导入';
  const stickers = Array.isArray(value.stickers) ? value.stickers : [];
  const remaining = files
    .filter((entry) => entry.isFile !== false)
    .map((entry) => {
      const resolvedPath = entry.path ?? entry.name?.trim() ?? '';
      return { ...entry, path: resolvedPath, fileName: entry.name?.trim() || toPathName(resolvedPath) };
    });
  const results: Array<Pick<StickerImportCandidate, 'title' | 'fileName' | 'tags'> & { path: string }> = [];
  for (const sticker of stickers) {
    if (!sticker || typeof sticker !== 'object') continue;
    const candidate = sticker as { stickerId?: unknown; name?: unknown };
    const stickerId = typeof candidate.stickerId === 'string' ? candidate.stickerId.trim() : '';
    if (!stickerId) continue;
    const title = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : `表情 ${stickerId}`;
    const matchedIndex = remaining.findIndex((entry) => entry.fileName.toLocaleLowerCase().startsWith(qqStickerPrefix(stickerId)));
    if (matchedIndex < 0) continue;
    const matched = remaining.splice(matchedIndex, 1)[0];
    results.push({
      path: matched.path,
      fileName: matched.fileName,
      title,
      tags: [packName, title],
    });
  }
  return results;
}

export async function resolveStickerDirectoryEntries(
  directory: string,
  entries: readonly StickerDirectoryEntryLike[],
  joinPath: (left: string, right: string) => Promise<string> = join,
): Promise<StickerDirectoryEntryLike[]> {
  return Promise.all(entries.map(async (entry) => ({
    ...entry,
    path: await joinPath(directory, entry.name ?? toPathName(entry.path ?? directory)),
  })));
}

export function mergeStickerImports(
  current: PersonalStickerLibraryV1,
  prepared: PreparedStickerImport[],
  limits: StickerLibraryLimits = DEFAULT_STICKER_LIBRARY_LIMITS,
): { next: PersonalStickerLibraryV1; report: StickerImportReport } {
  const records = [...current.records];
  const digests = new Set(records.map((record) => record.digest));
  let totalBytes = records.reduce((sum, record) => sum + record.size, 0);
  const report: StickerImportReport = {
    total: prepared.length,
    imported: 0,
    duplicates: 0,
    unsupported: 0,
    quotaSkipped: 0,
  };
  for (const candidate of prepared) {
    if (!candidate.mimeType || !candidate.bytes.length) {
      report.unsupported += 1;
      continue;
    }
    if (digests.has(candidate.digest)) {
      report.duplicates += 1;
      continue;
    }
    if (records.length >= limits.maxItems || totalBytes + candidate.bytes.length > limits.maxTotalBytes) {
      report.quotaSkipped += 1;
      continue;
    }
    records.unshift({
      id: candidate.digest,
      digest: candidate.digest,
      title: candidate.title,
      fileName: candidate.fileName,
      mimeType: candidate.mimeType,
      size: candidate.bytes.length,
      storedPath: candidate.storedPath,
      createdAt: candidate.createdAt,
      source: candidate.source,
      tags: uniqueTags(candidate.tags),
    });
    digests.add(candidate.digest);
    totalBytes += candidate.bytes.length;
    report.imported += 1;
  }
  return {
    next: { version: VERSION, records: records.sort((left, right) => right.createdAt - left.createdAt) },
    report,
  };
}

async function rollbackWrittenStickerFiles(
  paths: readonly string[],
  removeFile: StickerImportStorageOps['removeFile'],
): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    try {
      await removeFile(path);
    } catch {
      // 回滚失败不再覆盖原始异常，尽量减少孤儿文件即可。
    }
  }));
}

export async function applyPreparedStickerImport(
  current: PersonalStickerLibraryV1,
  prepared: PreparedStickerImport[],
  ops: StickerImportStorageOps,
  limits: StickerLibraryLimits = DEFAULT_STICKER_LIBRARY_LIMITS,
): Promise<{ next: PersonalStickerLibraryV1; report: StickerImportReport }> {
  const { next, report } = mergeStickerImports(current, prepared, limits);
  if (report.imported === 0) return { next, report };
  const existingDigests = new Set(current.records.map((record) => record.digest));
  const writtenPaths: string[] = [];
  try {
    for (const candidate of prepared) {
      if (!candidate.digest || existingDigests.has(candidate.digest)) continue;
      const accepted = next.records.find((record) => record.digest === candidate.digest);
      if (!accepted) continue;
      await ops.writeFile(candidate.storedPath, candidate.bytes);
      writtenPaths.push(candidate.storedPath);
      existingDigests.add(candidate.digest);
    }
    await ops.persistLibrary(next);
    return { next, report };
  } catch (error) {
    await rollbackWrittenStickerFiles(writtenPaths, ops.removeFile);
    throw error;
  }
}

async function prepareImport(
  scope: { server: string; userId: string; key: string },
  candidates: StickerImportCandidate[],
): Promise<StickerImportReport> {
  if (candidates.length === 0) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const root = await libraryRoot(scope);
  await mkdir(root, { recursive: true });
  const prepared: PreparedStickerImport[] = [];
  for (const candidate of candidates) {
    const mimeType = imageMimeTypeOf(candidate.fileName, candidate.mimeType);
    if (!mimeType || candidate.bytes.length === 0) {
      prepared.push({
        ...candidate,
        mimeType: '',
        digest: '',
        storedPath: '',
        createdAt: Date.now(),
      });
      continue;
    }
    const digest = await digestBytes(candidate.bytes);
    prepared.push({
      ...candidate,
      mimeType,
      digest,
      storedPath: await join(root, digestFileName(digest, candidate.fileName)),
      createdAt: Date.now(),
    });
  }
  const current = await readLibrary(scope);
  const { report } = await applyPreparedStickerImport(current, prepared, {
    writeFile: async (path, bytes) => writeFile(path, bytes),
    removeFile: async (path) => remove(path),
    persistLibrary: async (library) => persistLibrary(scope, library),
  });
  return report;
}

function flattenDirectoryEntries(entries: readonly StickerDirectoryEntryLike[]): StickerDirectoryEntryLike[] {
  return entries.filter((entry) => entry.isFile !== false);
}

async function readCandidatesFromPaths(
  paths: readonly string[],
  source: PersonalStickerRecordV1['source'],
  extraTags: readonly string[] = [],
): Promise<StickerImportCandidate[]> {
  const results: StickerImportCandidate[] = [];
  for (const path of paths) {
    const mimeType = imageMimeTypeOf(path);
    if (!mimeType) {
      results.push({
        title: defaultTitle(path),
        fileName: toPathName(path),
        mimeType: '',
        bytes: new Uint8Array(),
        source,
        tags: [],
      });
      continue;
    }
    results.push({
      title: defaultTitle(path),
      fileName: toPathName(path),
      mimeType,
      bytes: await readFile(path),
      source,
      tags: uniqueTags([defaultTitle(path), ...extraTags]),
    });
  }
  return results;
}

async function walkImageFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readDir(current);
    for (const entry of entries) {
      const path = await join(current, entry.name);
      if (entry.isDirectory) {
        stack.push(path);
        continue;
      }
      if (entry.isFile && imageMimeTypeOf(entry.name ?? path)) {
        results.push(path);
      }
    }
  }
  return results;
}

export async function importStickerFilesFromDialog(): Promise<StickerImportReport> {
  if (!isTauri) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const scope = ownerScope();
  if (!scope) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const selected = await open({
    multiple: true,
    title: '选择要导入的贴纸图片',
    filters: [{
      name: '图片',
      extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    }],
  });
  const paths = selected ? (Array.isArray(selected) ? selected : [selected]) : [];
  return prepareImport(scope, await readCandidatesFromPaths(paths, 'file'));
}

export async function importStickerDirectoryFromDialog(): Promise<StickerImportReport> {
  if (!isTauri) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const scope = ownerScope();
  if (!scope) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const selected = await open({
    directory: true,
    multiple: false,
    title: '选择贴纸目录',
  });
  if (!selected || Array.isArray(selected)) {
    return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  }
  const packInfoPath = await join(selected, 'pack_info.json');
  const stickersDirectory = await join(selected, 'stickers');
  const hasQqContract = await exists(packInfoPath) && await exists(stickersDirectory);
  if (hasQqContract) {
    const [packInfoRaw, entries] = await Promise.all([
      readTextFile(packInfoPath),
      readDir(stickersDirectory),
    ]);
    const mappedEntries = await resolveStickerDirectoryEntries(stickersDirectory, entries);
    const matched = parseQqStickerDirectory(JSON.parse(packInfoRaw), flattenDirectoryEntries(mappedEntries));
    const candidates: StickerImportCandidate[] = [];
    for (const entry of matched) {
      const mimeType = imageMimeTypeOf(entry.fileName);
      if (!mimeType) {
        candidates.push({
          title: entry.title,
          fileName: entry.fileName,
          mimeType: '',
          bytes: new Uint8Array(),
          source: 'directory',
          tags: entry.tags,
        });
        continue;
      }
      candidates.push({
        title: entry.title,
        fileName: entry.fileName,
        mimeType,
        bytes: await readFile(entry.path),
        source: 'directory',
        tags: entry.tags,
      });
    }
    return prepareImport(scope, candidates);
  }
  return prepareImport(scope, await readCandidatesFromPaths(await walkImageFiles(selected), 'directory'));
}

export function resolveCollectibleStickerSource(
  message: RcMessage,
): { attachment: RcMessageAttachment; sourcePath: string; fileName: string; mimeType: string | null } | null {
  const fileName = message.file?.name ?? '';
  const fileMimeType = message.file?.type ?? null;
  return message.attachments?.reduce<{
    attachment: RcMessageAttachment; sourcePath: string; fileName: string; mimeType: string | null; rank: number;
  } | null>((selected, attachment) => {
    if (attachment.image_url) {
      const inferredMimeType = imageMimeTypeOf(fileName || attachment.title || attachment.image_url, fileMimeType);
      if (!isSupportedStickerMimeType(inferredMimeType)) return selected;
      const candidate = {
        attachment,
        sourcePath: attachment.image_url,
        fileName: fileName || attachment.title || toPathName(attachment.image_url),
        mimeType: inferredMimeType,
        rank: 2,
      };
      return !selected || candidate.rank > selected.rank ? candidate : selected;
    }
    if (attachment.title_link && attachment.title_link_download !== true && isSupportedStickerMimeType(fileMimeType)) {
      const candidate = {
        attachment,
        sourcePath: attachment.title_link,
        fileName: fileName || attachment.title || toPathName(attachment.title_link),
        mimeType: imageMimeTypeOf(fileName || attachment.title || attachment.title_link, fileMimeType),
        rank: 1,
      };
      return !selected || candidate.rank > selected.rank ? candidate : selected;
    }
    return selected;
  }, null) ?? null;
}

export function canCollectMessageSticker(message: RcMessage): boolean {
  return !!resolveCollectibleStickerSource(message);
}

export async function collectStickerFromMessage(message: RcMessage): Promise<StickerImportReport> {
  if (!isTauri) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const scope = ownerScope();
  if (!scope) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const collectible = resolveCollectibleStickerSource(message);
  if (!collectible) return { total: 0, imported: 0, duplicates: 0, unsupported: 0, quotaSkipped: 0 };
  const response = await rest.fetchFileResponse(collectible.sourcePath);
  if (!response.ok) throw new Error(`加载图片失败（${response.status}）`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const responseMimeType = response.headers.get('content-type');
  const mimeType = imageMimeTypeOf(collectible.fileName, responseMimeType ?? collectible.mimeType);
  return prepareImport(scope, [{
    title: defaultTitle(collectible.fileName),
    fileName: collectible.fileName,
    mimeType: mimeType ?? '',
    bytes,
    source: 'message',
    tags: uniqueTags([defaultTitle(collectible.fileName), message.u.name || message.u.username]),
  }]);
}

export function describeStickerImport(report: StickerImportReport): string {
  if (report.total === 0) return '没有导入任何贴纸';
  const parts: string[] = [];
  if (report.imported > 0) parts.push(`导入 ${report.imported} 张`);
  if (report.duplicates > 0) parts.push(`${report.duplicates} 张已存在`);
  if (report.unsupported > 0) parts.push(`${report.unsupported} 张格式不支持`);
  if (report.quotaSkipped > 0) parts.push(`${report.quotaSkipped} 张超过配额`);
  return parts.join('，') || '没有导入任何贴纸';
}
