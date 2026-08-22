import { open, type OpenDialogOptions } from '@tauri-apps/plugin-dialog';
import { isTauriRuntime } from '../lib/http';

export type DesktopDialogSelection = string | string[] | null;

/** Desktop dialog capability. Web callers receive null and can keep their browser path. */
export async function openDesktopDialog(options: OpenDialogOptions): Promise<DesktopDialogSelection> {
  if (!isTauriRuntime()) return null;
  return open(options);
}
