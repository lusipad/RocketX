import { readFile, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { RcApiError } from '@rcx/rc-client';
import { ensureHttpOrigin, isTauri } from '../lib/http';
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
