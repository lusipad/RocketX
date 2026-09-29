export const DOWNLOAD_HISTORY_VERSION = 1;
export const MAX_DOWNLOAD_HISTORY = 200;

export interface DownloadSourceV1 {
  rid: string;
  roomName: string;
  messageId: string;
}

export interface DownloadRecordV1 {
  id: string;
  fileName: string;
  path: string;
  completedAt: number;
  source?: DownloadSourceV1;
}

export interface DownloadHistoryV1 {
  version: 1;
  records: DownloadRecordV1[];
}

export function emptyDownloadHistory(): DownloadHistoryV1 {
  return { version: DOWNLOAD_HISTORY_VERSION, records: [] };
}

export function downloadHistoryStorageKey(server: string, userId: string): string {
  const normalizedServer = server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
  return `rcx-download-history-v${DOWNLOAD_HISTORY_VERSION}:${encodeURIComponent(normalizedServer)}:${encodeURIComponent(userId)}`;
}

export function fileNameOfDownloadPath(path: string, fallback: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || fallback;
}

/**
 * Tauri opener 只能接收本机文件系统路径。持久化历史可被用户或扩展修改，
 * 因此不能把 URL、file: URI 或相对路径直接交给原生 opener。
 */
export function isAbsoluteLocalPath(path: string): boolean {
  if (!path || path.includes('\0')) return false;
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) || path.startsWith('/');
}

/**
 * 这条消息的附件最近一次下载到了哪里。记录按完成时间倒序，第一条命中即最新。
 * 只按 rid + messageId 认：同名文件在不同消息里是不同的文件，不能按文件名猜。
 */
export function findMessageDownload(
  records: readonly DownloadRecordV1[],
  source: Pick<DownloadSourceV1, 'rid' | 'messageId'>,
): DownloadRecordV1 | undefined {
  return records.find(
    (record) => record.source?.rid === source.rid && record.source.messageId === source.messageId,
  );
}

/** 与 Rust 端 resolve_download_history_path 的报错保持一致：文件被删或被移走 */
export const DOWNLOAD_MISSING_MESSAGE = '下载文件不存在或已被移动';

export function isDownloadMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(DOWNLOAD_MISSING_MESSAGE);
}

function isDownloadSource(value: unknown): value is DownloadSourceV1 {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<DownloadSourceV1>;
  return (
    typeof source.rid === 'string' &&
    !!source.rid.trim() &&
    typeof source.roomName === 'string' &&
    !!source.roomName.trim() &&
    typeof source.messageId === 'string' &&
    !!source.messageId.trim()
  );
}

function isDownloadRecord(value: unknown): value is DownloadRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DownloadRecordV1>;
  return (
    typeof record.id === 'string' &&
    typeof record.fileName === 'string' &&
    typeof record.path === 'string' &&
    isAbsoluteLocalPath(record.path) &&
    typeof record.completedAt === 'number' &&
    Number.isFinite(record.completedAt) &&
    (record.source === undefined || isDownloadSource(record.source))
  );
}

export function addDownloadRecord(
  current: DownloadHistoryV1,
  record: DownloadRecordV1,
): DownloadHistoryV1 {
  return {
    version: DOWNLOAD_HISTORY_VERSION,
    records: [record, ...current.records.filter((item) => item.id !== record.id)]
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, MAX_DOWNLOAD_HISTORY),
  };
}

export function parseDownloadHistory(raw: string | null): DownloadHistoryV1 {
  if (!raw) return emptyDownloadHistory();
  try {
    const value = JSON.parse(raw) as Partial<DownloadHistoryV1>;
    if (value.version !== DOWNLOAD_HISTORY_VERSION || !Array.isArray(value.records)) {
      return emptyDownloadHistory();
    }
    let history = emptyDownloadHistory();
    for (const record of value.records) {
      if (isDownloadRecord(record)) history = addDownloadRecord(history, record);
    }
    return history;
  } catch {
    return emptyDownloadHistory();
  }
}
