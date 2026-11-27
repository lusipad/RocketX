import { t } from '../i18n';

export type StartupStage =
  | 'idle'
  | 'platform-ready'
  | 'account-scope-ready'
  | 'auth-restored'
  | 'guest'
  | 'core-data-ready'
  | 'messaging-connected'
  | 'kernel-ready'
  | 'background-ready'
  | 'error';

export interface StartupFailure {
  stage: StartupStage;
  operation: StartupOperation;
  message: string;
}

export type StartupOperation =
  | 'platform'
  | 'auth'
  | 'account'
  | 'core'
  | 'runtime'
  | 'kernel'
  | 'background';

export interface StartupState {
  stage: StartupStage;
  operation: StartupOperation | null;
  attempt: number;
  error: StartupFailure | null;
}

export interface StartupAuthSnapshot {
  status: 'boot' | 'guest' | 'authing' | 'authed';
  userId: string | null;
}

export interface StartupSteps {
  preparePlatform: (signal?: AbortSignal) => void | Promise<void>;
  restoreAuth: (signal?: AbortSignal) => Promise<void>;
  readAuth: () => StartupAuthSnapshot;
  hydrateAccount: (userId: string, signal?: AbortSignal) => void | Promise<void>;
  loadCoreData: (signal?: AbortSignal) => Promise<void>;
  initializeRuntime: (signal?: AbortSignal) => Promise<void>;
  initializeKernel: (signal?: AbortSignal) => Promise<void>;
  startBackground: (signal?: AbortSignal) => Promise<void>;
}

export interface StartupCoordinatorOptions {
  steps: StartupSteps;
  onState: (state: StartupState) => void;
  timeouts?: Partial<Record<'auth' | 'account' | 'core' | 'runtime' | 'kernel' | 'background', number>>;
}

export interface StartupCoordinator {
  start: () => Promise<void>;
  retry: () => Promise<void>;
  getState: () => StartupState;
}

const DEFAULT_TIMEOUTS = {
  auth: 15_000,
  account: 5_000,
  core: 15_000,
  runtime: 30_000,
  kernel: 15_000,
  background: 15_000,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => operation(controller.signal));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        controller.abort();
        reject(new Error(t('auth.startup.stepTimeout', { label })));
      },
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createStartupCoordinator({
  steps,
  onState,
  timeouts = {},
}: StartupCoordinatorOptions): StartupCoordinator {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let state: StartupState = { stage: 'idle', operation: null, attempt: 0, error: null };
  let inFlight: Promise<void> | null = null;
  let runAccount: string | null | undefined;
  let generation = 0;

  const publish = (
    runGeneration: number,
    stage: StartupStage,
    operation: StartupOperation | null = null,
    error: StartupFailure | null = null,
  ): void => {
    if (runGeneration !== generation) return;
    state = { ...state, stage, operation, error };
    onState(state);
  };

  const run = async (): Promise<void> => {
    const runGeneration = generation + 1;
    generation = runGeneration;
    const attempt = state.attempt + 1;
    state = { stage: 'idle', operation: null, attempt, error: null };
    onState(state);
    let stage: StartupStage = 'idle';
    const assertCurrent = (signal?: AbortSignal): void => {
      if (signal?.aborted) throw new Error(t('auth.startup.aborted'));
      if (runGeneration !== generation) throw new Error(t('auth.startup.superseded'));
    };
    try {
      publish(runGeneration, stage, 'platform');
      await withTimeout((signal) => Promise.resolve(steps.preparePlatform(signal)), 0, t('auth.startup.step.platform'));
      stage = 'platform-ready';
      publish(runGeneration, stage);

      // auth.resume also performs account-scope migration. The explicit phase
      // keeps that boundary observable without duplicating its storage logic.
      stage = 'account-scope-ready';
      publish(runGeneration, stage);
      publish(runGeneration, stage, 'auth');
      await withTimeout((signal) => steps.restoreAuth(signal), limits.auth, t('auth.startup.step.auth'));
      assertCurrent();

      const auth = steps.readAuth();
      runAccount = auth.userId;
      if (auth.status !== 'authed' || !auth.userId) {
        publish(runGeneration, 'guest');
        return;
      }
      stage = 'auth-restored';
      publish(runGeneration, stage);

      publish(runGeneration, stage, 'account');
      await withTimeout((signal) => Promise.resolve(steps.hydrateAccount(auth.userId!, signal)), limits.account, t('auth.startup.step.account'));
      assertCurrent();
      publish(runGeneration, stage, 'core');
      await withTimeout((signal) => steps.loadCoreData(signal), limits.core, t('auth.startup.step.core'));
      assertCurrent();
      stage = 'core-data-ready';
      publish(runGeneration, stage);
      stage = 'messaging-connected';
      publish(runGeneration, stage);

      publish(runGeneration, stage, 'runtime');
      await withTimeout((signal) => steps.initializeRuntime(signal), limits.runtime, t('auth.startup.step.runtime'));
      assertCurrent();
      publish(runGeneration, stage, 'kernel');
      await withTimeout((signal) => steps.initializeKernel(signal), limits.kernel, t('auth.startup.step.kernel'));
      assertCurrent();
      stage = 'kernel-ready';
      publish(runGeneration, stage);
      publish(runGeneration, stage, 'background');
      await withTimeout((signal) => steps.startBackground(signal), limits.background, t('auth.startup.step.background'));
      assertCurrent();
      publish(runGeneration, 'background-ready');
    } catch (error) {
      const operation = state.operation ?? 'platform';
      publish(runGeneration, 'error', null, { stage, operation, message: errorMessage(error) });
    }
  };

  const start = (): Promise<void> => {
    if (inFlight) {
      // 同一账号共享启动。切换账号时停止旧轮次的后续阶段，等待正在执行的步骤退出。
      if (runAccount !== undefined && runAccount !== steps.readAuth().userId) {
        generation += 1;
        return inFlight.then(start);
      }
      return inFlight;
    }
    inFlight = run().finally(() => {
      runAccount = undefined;
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start,
    retry: start,
    getState: () => state,
  };
}
