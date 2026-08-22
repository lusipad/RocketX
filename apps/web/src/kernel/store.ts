import { createRcxStore } from '@rcx/rcx-store';

export const kernelStore = createRcxStore();

let storeReady: Promise<void> | null = null;

/** Open the local store once so guest pages can prepare data before login. */
export function ensureKernelStoreReady(): Promise<void> {
  storeReady ??= kernelStore.appData.list('builtin:shared-agent').then(() => undefined).catch(() => undefined);
  return storeReady;
}
