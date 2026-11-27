import { t } from '../i18n';

/** The native connection must be selected before any account data is admitted. */
export interface RuntimeAccountContext {
  accountScope: string;
  generation: number;
}

let generation = 0;
let accountScope: string | null = null;
let nativeContext: RuntimeAccountContext | null = null;
let newestNativeGeneration = 0;
let ready = false;
let failure: unknown;
const listeners = new Set<() => void>();
const waiting = new Set<{ resolve: (guard: () => void) => void; reject: (error: unknown) => void }>();

export function captureButlerAccountGeneration(): () => void {
  const expected = generation;
  return () => {
    if (expected !== generation) throw new Error(t('nav.butlerAccount.switchedCanceled'));
  };
}

export function waitForButlerAccountReady(): Promise<() => void> {
  if (ready) return Promise.resolve(captureButlerAccountGeneration());
  if (failure) return Promise.reject(failure);
  return new Promise((resolve, reject) => waiting.add({ resolve, reject }));
}

export function subscribeButlerAccountSelection(listener: () => void): () => void {
  listeners.add(listener);
  if (accountScope !== null) listener();
  return () => { listeners.delete(listener); };
}

export function isButlerAccountReady(scope: string): boolean {
  return ready && accountScope === scope;
}

export function captureButlerRuntimeAccountContext(): RuntimeAccountContext {
  if (!ready || !nativeContext) throw new Error(t('nav.butlerAccount.dbNotReady'));
  return { ...nativeContext };
}

export function beginButlerAccountSelection(scope: string) {
  generation += 1;
  accountScope = scope;
  nativeContext = null;
  ready = false;
  failure = undefined;
  const assertCurrent = captureButlerAccountGeneration();
  for (const listener of listeners) listener();
  return {
    assertCurrent,
    activate: (context: RuntimeAccountContext) => {
      assertCurrent();
      if (context?.accountScope !== scope || !Number.isSafeInteger(context.generation)
        || context.generation <= newestNativeGeneration) {
        throw new Error(t('nav.butlerAccount.scopeMismatch'));
      }
      nativeContext = { ...context };
      newestNativeGeneration = context.generation;
      ready = true;
      for (const item of waiting) item.resolve(captureButlerAccountGeneration());
      waiting.clear();
    },
    fail: (error: unknown) => {
      assertCurrent();
      failure = error;
      for (const item of waiting) item.reject(error);
      waiting.clear();
    },
  };
}

export async function runWithButlerAccount<T>(operation: () => Promise<T>): Promise<T> {
  const assertCurrent = await waitForButlerAccountReady();
  assertCurrent();
  try {
    return await operation();
  } finally {
    assertCurrent();
  }
}

export async function runWithButlerAccountIfManaged<T>(operation: () => Promise<T>): Promise<T> {
  if (accountScope !== null || ready || failure !== undefined) {
    return runWithButlerAccount(operation);
  }
  return operation();
}
