import { t } from '../i18n';
import { isTauri } from './http';
import { invoke } from '@tauri-apps/api/core';

const isDebugBuild = import.meta.env?.DEV === true;

export const autostartAvailable = isTauri && !isDebugBuild;

export async function readAutostartEnabled(): Promise<boolean | null> {
  if (!autostartAvailable) return null;
  return invoke<boolean | null>('read_autostart_enabled');
}

export async function updateAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri) throw new Error(t('nav.autostart.desktopOnly'));
  if (isDebugBuild) {
    throw new Error(t('nav.autostart.debugDisabled'));
  }
  return invoke<boolean>('set_autostart_enabled', { enabled });
}
