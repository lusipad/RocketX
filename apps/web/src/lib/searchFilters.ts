import { tsMs, type RcMessage } from '@rcx/rc-client';
import type { IndexedFileResult } from './fileIndex';

export type SearchTimeRange = 'any' | '7d' | '30d' | '365d';
export type SearchFileType = 'any' | 'image' | 'document' | 'archive' | 'other';

export interface SearchResultFilters {
  sender: string;
  timeRange: SearchTimeRange;
  fileType: SearchFileType;
}

const RANGE_DAYS: Record<Exclude<SearchTimeRange, 'any'>, number> = {
  '7d': 7,
  '30d': 30,
  '365d': 365,
};

const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf',
]);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);

function afterCutoff(timestamp: number, range: SearchTimeRange, now: number): boolean {
  if (range === 'any') return true;
  if (!timestamp) return false;
  return timestamp >= now - RANGE_DAYS[range] * 86_400_000;
}

function senderMatches(sender: string, ...candidates: (string | undefined)[]): boolean {
  const q = sender.trim().toLocaleLowerCase();
  return !q || candidates.some((candidate) => candidate?.toLocaleLowerCase().includes(q));
}

export function fileTypeOf(name: string, mime?: string): Exclude<SearchFileType, 'any'> {
  const normalizedMime = mime?.toLocaleLowerCase() ?? '';
  if (normalizedMime.startsWith('image/')) return 'image';
  if (
    normalizedMime.startsWith('text/') ||
    /pdf|msword|officedocument|spreadsheet|presentation/.test(normalizedMime)
  ) return 'document';
  if (/zip|rar|7z|compressed|tar/.test(normalizedMime)) return 'archive';
  const extension = name.toLocaleLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'other';
}

export function filterMessageResults(
  messages: RcMessage[],
  filters: SearchResultFilters,
  now = Date.now(),
): RcMessage[] {
  return messages.filter((message) =>
    senderMatches(filters.sender, message.u.name, message.u.username) &&
    afterCutoff(tsMs(message.ts), filters.timeRange, now),
  );
}

export function filterFileResults(
  files: IndexedFileResult[],
  filters: SearchResultFilters,
  now = Date.now(),
): IndexedFileResult[] {
  return files.filter(({ file }) =>
    senderMatches(filters.sender, file.user?.name, file.user?.username) &&
    afterCutoff(tsMs(file.uploadedAt), filters.timeRange, now) &&
    (filters.fileType === 'any' || fileTypeOf(file.name, file.type) === filters.fileType),
  );
}
