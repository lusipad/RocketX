import { isTauri } from './http';
import { invoke } from '@tauri-apps/api/core';

const isDebugBuild = import.meta.env?.DEV === true;

export const autostartAvailable = isTauri && !isDebugBuild;

export async function readAutostartEnabled(): Promise<boolean | null> {
  if (!autostartAvailable) return null;
  return invoke<boolean | null>('read_autostart_enabled');
}

export async function updateAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri) throw new Error('开机自启仅桌面端可用');
  if (isDebugBuild) {
    throw new Error('Debug 版依赖开发服务器，不能设置为开机启动；请使用正式安装版');
  }
  return invoke<boolean>('set_autostart_enabled', { enabled });
}
