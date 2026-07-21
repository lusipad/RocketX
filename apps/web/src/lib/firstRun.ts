export const FIRST_RUN_STORAGE_KEY = 'rcx-first-run-v1';

export type FirstRunState = 'complete' | 'pending';

export function loadFirstRunState(storage: Pick<Storage, 'getItem'> | undefined): FirstRunState | null {
  try {
    const value = storage?.getItem(FIRST_RUN_STORAGE_KEY);
    return value === 'complete' || value === 'pending' ? value : null;
  } catch {
    return null;
  }
}

export function shouldShowFirstRun(input: {
  desktop: boolean;
  serverUrl: string;
  hasWorkspaceSource: boolean;
  state: FirstRunState | null;
}): boolean {
  if (!input.desktop) return false;
  if (input.state === 'pending') return true;
  if (input.state === 'complete') return false;
  return !input.serverUrl.trim() && !input.hasWorkspaceSource;
}

export function completeFirstRun(storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(FIRST_RUN_STORAGE_KEY, 'complete');
  } catch {
    /* 存储不可用时本次会话仍可由页面状态继续 */
  }
}

export function resetFirstRun(storage: Pick<Storage, 'setItem'> | undefined = localStorage): void {
  try {
    storage?.setItem(FIRST_RUN_STORAGE_KEY, 'pending');
  } catch {
    /* 无痕模式下无法跨重启重放引导 */
  }
}
