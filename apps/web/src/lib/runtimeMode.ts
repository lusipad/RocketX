export const RUNTIME_MODE_STORAGE_KEY = 'rcx-runtime-mode-v1';
export const RUNTIME_MODE_QUERY_KEY = 'rcx-mode';

export type RuntimeMode = 'standard' | 'performance';

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

interface RuntimeModeStorage {
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

let currentMode = readRuntimeMode();

export function getRuntimeMode(): RuntimeMode {
  return currentMode;
}

export function runtimeFeatures(mode: RuntimeMode = currentMode): RuntimeFeatures {
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
  return {
    mode,
    ai: true,
    bootKernel: true,
    butler: true,
    ocr: true,
    polling: true,
    reducedMotion: false,
    routines: true,
    runtimeProbes: true,
    sharedAgent: true,
  };
}

export function applyRuntimeModeDocumentState(doc: Document | undefined = browserDocument()): RuntimeMode {
  currentMode = readRuntimeMode();
  if (!doc?.documentElement) return currentMode;
  doc.documentElement.dataset.runtimeMode = currentMode;
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
