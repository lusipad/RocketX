import { readFile, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { RcApiError } from '@rcx/rc-client';
import { ensureHttpOrigin, isTauri } from '../lib/http';
import {
  UPLOAD_SPOOL_DIR,
  safeSpoolName,
  spoolChunkRanges,
} from '../lib/uploadRouting';
import { getServerBase, loadStoredAuth } from '../lib/client';

export async function readDesktopFile(path: string): Promise<ArrayBuffer> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  const bytes = await readFile(path);
  return Uint8Array.from(bytes).buffer;
}

export async function statDesktopFile(path: string): Promise<{ size: number }> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  return stat(path);
}

interface NativeMediaUploadResult {
  status: number;
  error?: string;
  errorType?: string;
}

/** 让 Rust 直接从文件句柄流式上传，避免大文件经 WebView IPC 物化为字节数组。 */
export async function uploadDesktopFile(
  path: string,
  rid: string,
  options: { msg?: string; tmid?: string } = {},
): Promise<void> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  const serverUrl = getServerBase();
  const auth = loadStoredAuth();
  if (!serverUrl || !auth) throw new Error('Rocket.Chat 登录状态不可用');
  await ensureHttpOrigin(serverUrl);
  const result = await invoke<NativeMediaUploadResult>('upload_native_media', {
    serverUrl,
    path,
    rid,
    authToken: auth.authToken,
    userId: auth.userId,
    msg: options.msg,
    tmid: options.tmid,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new RcApiError(result.error ?? `HTTP ${result.status}`, result.status, result.errorType);
  }
}

/** 每次落盘用独立子目录，文件名保持原样，同名文件并发上传也不会互相覆盖。 */
function spoolToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 内存里的大文件（拖拽、粘贴、转发时重新上传）先分块写进应用数据目录，再复用
 * 原生流式上传，最后删除临时文件。整个过程 WebView 里最多只持有一块。
 */
export async function uploadDesktopBlob(
  blob: Blob,
  rid: string,
  options: { msg?: string; tmid?: string; fileName: string },
): Promise<void> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  const [{ appDataDir, join }, { mkdir, remove, writeFile }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const root = await join(await appDataDir(), UPLOAD_SPOOL_DIR, spoolToken());
  const target = await join(root, safeSpoolName(options.fileName));
  await mkdir(root, { recursive: true });
  try {
    // 逐块 append：整块传输会在 WebView 里物化成巨大数组（issue #377）。
    for (const [start, end] of spoolChunkRanges(blob.size)) {
      const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());
      await writeFile(target, chunk, { append: start > 0 });
    }
    await uploadDesktopFile(target, rid, { msg: options.msg, tmid: options.tmid });
  } finally {
    await remove(root, { recursive: true }).catch(() => undefined);
  }
}
