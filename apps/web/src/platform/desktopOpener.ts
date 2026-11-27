import { convertFileSrc } from '@tauri-apps/api/core';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { t } from '../i18n';
import { isTauri } from '../lib/http';

export function desktopAssetUrl(path: string): string | undefined {
  const source = path.trim();
  if (!source) return undefined;
  if (/^(?:https?:|data:|blob:|asset:)/iu.test(source)) return source;
  return isTauri ? convertFileSrc(source) : undefined;
}

export async function openDesktopPath(path: string): Promise<void> {
  if (!isTauri) throw new Error(t('nav.platform.desktopOnly'));
  await openPath(path);
}

export async function revealDesktopPath(path: string): Promise<void> {
  if (!isTauri) throw new Error(t('nav.platform.desktopOnly'));
  await revealItemInDir(path);
}
