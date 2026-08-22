import { convertFileSrc } from '@tauri-apps/api/core';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { isTauri } from '../lib/http';

export function desktopAssetUrl(path: string): string | undefined {
  const source = path.trim();
  if (!source) return undefined;
  if (/^(?:https?:|data:|blob:|asset:)/iu.test(source)) return source;
  return isTauri ? convertFileSrc(source) : undefined;
}

export async function openDesktopPath(path: string): Promise<void> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  await openPath(path);
}

export async function revealDesktopPath(path: string): Promise<void> {
  if (!isTauri) throw new Error('此操作仅支持桌面端');
  await revealItemInDir(path);
}
