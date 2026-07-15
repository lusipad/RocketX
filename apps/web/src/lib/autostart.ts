import { isTauri } from './http';

export async function readAutostartEnabled(): Promise<boolean | null> {
  if (!isTauri) return null;
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled();
}

export async function updateAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri) throw new Error('开机自启仅桌面端可用');
  const plugin = await import('@tauri-apps/plugin-autostart');
  if (enabled) await plugin.enable();
  else await plugin.disable();
  return plugin.isEnabled();
}
