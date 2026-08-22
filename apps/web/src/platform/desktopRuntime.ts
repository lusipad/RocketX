import { invoke } from '@tauri-apps/api/core';

export async function probeDesktopCodexRuntime<T>(args: Record<string, unknown>): Promise<T> {
  return invoke<T>('codex_runtime_probe', args);
}
