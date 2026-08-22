import { relaunch } from '@tauri-apps/plugin-process';

export async function relaunchDesktop(): Promise<void> {
  await relaunch();
}
