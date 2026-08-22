import { readFile, stat } from '@tauri-apps/plugin-fs';
import { isTauri } from '../lib/http';

export async function readDesktopFile(path: string): Promise<ArrayBuffer> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  const bytes = await readFile(path);
  return Uint8Array.from(bytes).buffer;
}

export async function statDesktopFile(path: string): Promise<{ size: number }> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  return stat(path);
}
