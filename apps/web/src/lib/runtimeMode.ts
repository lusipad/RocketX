export const RUNTIME_MODE_STORAGE_KEY = 'rcx-runtime-mode-v1';
export const RUNTIME_MODE_QUERY_KEY = 'rcx-mode';
export const AI_RUNTIME_PROVIDER_STORAGE_KEY = 'rocketx.butler.task-provider';

export type RuntimeMode = 'standard' | 'performance';
export type AiRuntimeProvider = 'codex' | 'deepseek' | 'none';

export interface RuntimeFeatures {
  mode: RuntimeMode;
  ai: boolean;
  bootKernel: boolean;
  butler: boolean;
  ocr: boolean;
  polling: boolean;
  reducedMotion: boolean;
  routines: boolean;
  runtimeProbes: boolean;
  sharedAgent: boolean;
}

export interface RuntimeModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): RuntimeModeStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function browserLocation(): Pick<Location, 'search'> | undefined {
  return typeof window === 'undefined' ? undefined : window.location;
}

function browserDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'performance'
    ? 'performance'
    : 'standard';
}

function readRuntimeModeQuery(location: Pick<Location, 'search'> | undefined): RuntimeMode | undefined {
  if (!location?.search) return undefined;
  const params = new URLSearchParams(location.search);
  const value = params.get(RUNTIME_MODE_QUERY_KEY);
  return value ? normalizeRuntimeMode(value) : undefined;
}

export function readRuntimeMode(
  storage: RuntimeModeStorage | undefined = browserStorage(),
  location: Pick<Location, 'search'> | undefined = browserLocation(),
): RuntimeMode {
  const queryMode = readRuntimeModeQuery(location);
  if (queryMode) return queryMode;
  if (!storage) return 'standard';
  try {
    return normalizeRuntimeMode(storage.getItem(RUNTIME_MODE_STORAGE_KEY));
  } catch {
    return 'standard';
  }
}

export function normalizeAiRuntimeProvider(value: unknown): AiRuntimeProvider {
  return value === 'codex' || value === 'none' ? value : 'deepseek';
}

export function readConfiguredAiRuntimeProvider(
  storage: RuntimeModeStorage | undefined = browserStorage(),
): AiRuntimeProvider | undefined {
  try {
    const value = storage?.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY);
    return value === 'codex' || value === 'deepseek' || value === 'none' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function selectStartupAiRuntimeProvider(
  configured: AiRuntimeProvider | undefined,
  availability: Readonly<Record<'codex' | 'deepseek', boolean>>,
): AiRuntimeProvider {
  if (configured === 'none') return 'none';
  if (configured) return availability[configured] ? configured : 'none';
  if (availability.deepseek) return 'deepseek';
  if (availability.codex) return 'codex';
  return 'none';
}

export function readAiRuntimeProvider(
  storage: RuntimeModeStorage | undefined = browserStorage(),
): AiRuntimeProvider {
  try {
    return normalizeAiRuntimeProvider(storage?.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY));
  } catch {
    return 'deepseek';
  }
}

let currentMode = readRuntimeMode();
let currentAiRuntimeProvider = readAiRuntimeProvider();

export function getRuntimeMode(): RuntimeMode {
  return currentMode;
}

export function getAiRuntimeProvider(): AiRuntimeProvider {
  return currentAiRuntimeProvider;
}

/** 应用本次进程实际使用的 AI 后端，不改写用户保存的下次启动选择。 */
export function activateAiRuntimeProvider(
  provider: AiRuntimeProvider,
  doc: Document | undefined = browserDocument(),
): AiRuntimeProvider {
  currentAiRuntimeProvider = normalizeAiRuntimeProvider(provider);
  if (doc?.documentElement) doc.documentElement.dataset.aiRuntime = currentAiRuntimeProvider;
  return currentAiRuntimeProvider;
}

/** 只保存下次启动要使用的后端；当前进程的运行时选择保持不变。 */
export function persistAiRuntimeProvider(
  provider: AiRuntimeProvider,
  storage: RuntimeModeStorage | undefined = browserStorage(),
): AiRuntimeProvider {
  const next = normalizeAiRuntimeProvider(provider);
  try {
    storage?.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, next);
  } catch {
    // 存储不可用时保持当前启动配置。
  }
  return next;
}

export function runtimeFeatures(
  mode: RuntimeMode = currentMode,
  provider: AiRuntimeProvider = currentAiRuntimeProvider,
): RuntimeFeatures {
  if (mode === 'performance') {
    return {
      mode,
      ai: false,
      bootKernel: true,
      butler: false,
      ocr: false,
      polling: false,
      reducedMotion: true,
      routines: false,
      runtimeProbes: false,
      sharedAgent: false,
    };
  }
  const aiEnabled = provider !== 'none';
  return {
    mode,
    ai: aiEnabled,
    bootKernel: true,
    butler: true,
    ocr: aiEnabled,
    polling: true,
    reducedMotion: false,
    routines: provider === 'codex',
    runtimeProbes: provider === 'codex',
    sharedAgent: true,
  };
}

export function applyRuntimeModeDocumentState(doc: Document | undefined = browserDocument()): RuntimeMode {
  currentMode = readRuntimeMode();
  if (!doc?.documentElement) return currentMode;
  doc.documentElement.dataset.runtimeMode = currentMode;
  doc.documentElement.dataset.aiRuntime = currentAiRuntimeProvider;
  doc.documentElement.classList.toggle('runtime-performance', currentMode === 'performance');
  return currentMode;
}

export function persistRuntimeMode(
  mode: RuntimeMode,
  storage: RuntimeModeStorage | undefined = browserStorage(),
  doc: Document | undefined = browserDocument(),
): RuntimeMode {
  currentMode = normalizeRuntimeMode(mode);
  try {
    storage?.setItem(RUNTIME_MODE_STORAGE_KEY, currentMode);
  } catch {
    // 存储被禁用时保持本次运行的内存态。
  }
  if (doc?.documentElement) {
    doc.documentElement.dataset.runtimeMode = currentMode;
    doc.documentElement.classList.toggle('runtime-performance', currentMode === 'performance');
  }
  return currentMode;
}

export function resetRuntimeModeForTests(): void {
  currentMode = 'standard';
}

export function resetAiRuntimeProviderForTests(provider: AiRuntimeProvider): void {
  activateAiRuntimeProvider(provider);
}
