import { register, unregister } from '@tauri-apps/plugin-global-shortcut';

type DesktopShortcutHandler = Parameters<typeof register>[1];

export async function registerDesktopShortcut(
  shortcut: string,
  handler: DesktopShortcutHandler,
): Promise<void> {
  await register(shortcut, handler);
}

export async function unregisterDesktopShortcut(shortcut: string): Promise<void> {
  await unregister(shortcut);
}
