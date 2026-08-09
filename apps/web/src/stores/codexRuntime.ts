import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { isTauri } from '../lib/http';
import { toast } from './toast';

export type CodexRuntimePhase = 'idle' | 'checking' | 'ready' | 'unavailable' | 'web';
export type CodexCompatibilityStatus = 'verified' | 'untested-newer' | 'blocked';

export interface CodexRuntimeProbe {
  ready: boolean;
  version?: string;
  executablePath?: string;
  source?: 'manual' | 'bundled' | 'system';
  protocolBaseline: string;
  minimumCandidate: string;
  verifiedVersions: string[];
  compatibilityStatus: CodexCompatibilityStatus;
  reasonCode?: 'not-found' | 'outdated' | 'manual-path' | 'missing-app-server' | 'not-logged-in' | 'unavailable';
  reason?: string;
}

interface CodexRuntimeState {
  phase: CodexRuntimePhase;
  version?: string;
  executablePath?: string;
  source?: CodexRuntimeProbe['source'];
  protocolBaseline?: string;
  minimumCandidate?: string;
  verifiedVersions?: string[];
  compatibilityStatus?: CodexCompatibilityStatus;
  reasonCode?: CodexRuntimeProbe['reasonCode'];
  reason?: string;
  probe: () => Promise<void>;
}

export interface CodexRuntimeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

type RuntimeInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const MANUAL_CODEX_PATH_KEY = 'rcx-codex-runtime-v1:manual-path';
const browserStorage: CodexRuntimeStorage = {
  get: (key) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  set: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
};

let runtimeStorage = browserStorage;
let runtimeInvoke: RuntimeInvoker = (command, args) => invoke(command, args);
let desktopAvailable = () => isTauri;
let probeRevision = 0;
let unavailableNotified = false;

export function getCodexManualPath(): string {
  return runtimeStorage.get(MANUAL_CODEX_PATH_KEY)?.trim() ?? '';
}

export function setCodexManualPath(path: string): void {
  runtimeStorage.set(MANUAL_CODEX_PATH_KEY, path.trim());
}

/**
 * 决策 13：不再静默切到另一个大脑。Codex 用不了就明说用不了——
 * 悄悄换一个能力不同的大脑，用户根本无从察觉自己拿到的答案是谁给的。
 */
function activateUnavailable(reason: string): void {
  if (!unavailableNotified) {
    unavailableNotified = true;
    toast.info(`Codex 暂时用不了：${reason}`);
  }
}

export const useCodexRuntime = create<CodexRuntimeState>((set) => ({
  phase: desktopAvailable() ? 'idle' : 'web',

  probe: async () => {
    const revision = ++probeRevision;
    if (!desktopAvailable()) {
      set({
        phase: 'web',
        version: undefined,
        executablePath: undefined,
        source: undefined,
        protocolBaseline: undefined,
        minimumCandidate: undefined,
        verifiedVersions: undefined,
        compatibilityStatus: undefined,
        reasonCode: undefined,
        reason: undefined,
      });
      return;
    }
    set({ phase: 'checking', reason: undefined });
    try {
      const result = await runtimeInvoke<CodexRuntimeProbe>('codex_runtime_probe', {
        manualPath: getCodexManualPath() || null,
      });
      if (revision !== probeRevision) return;
      if (result.ready && result.compatibilityStatus !== 'blocked') {
        set({
          phase: 'ready',
          version: result.version,
          executablePath: result.executablePath,
          source: result.source,
          protocolBaseline: result.protocolBaseline,
          minimumCandidate: result.minimumCandidate,
          verifiedVersions: [...result.verifiedVersions],
          compatibilityStatus: result.compatibilityStatus,
          reasonCode: undefined,
          reason: undefined,
        });
        return;
      }
      const reason = result.reason || 'Codex 暂不可用';
      activateUnavailable(reason);
      set({
        phase: 'unavailable',
        version: result.version,
        executablePath: result.executablePath,
        source: result.source,
        protocolBaseline: result.protocolBaseline,
        minimumCandidate: result.minimumCandidate,
        verifiedVersions: [...result.verifiedVersions],
        compatibilityStatus: result.compatibilityStatus,
        reasonCode: result.reasonCode,
        reason,
      });
    } catch (error) {
      if (revision !== probeRevision) return;
      const reason = `Codex 检测失败：${error instanceof Error ? error.message : String(error)}`;
      activateUnavailable(reason);
      set({
        phase: 'unavailable',
        version: undefined,
        executablePath: undefined,
        source: undefined,
        protocolBaseline: undefined,
        minimumCandidate: undefined,
        verifiedVersions: undefined,
        compatibilityStatus: undefined,
        reasonCode: 'unavailable',
        reason,
      });
    }
  },
}));

export function setCodexRuntimeInvoker(invoker: RuntimeInvoker): () => void {
  const previous = runtimeInvoke;
  runtimeInvoke = invoker;
  return () => {
    runtimeInvoke = previous;
  };
}

export function setCodexRuntimeStorage(storage: CodexRuntimeStorage): () => void {
  const previous = runtimeStorage;
  runtimeStorage = storage;
  return () => {
    runtimeStorage = previous;
  };
}

export function setCodexRuntimePlatform(provider: () => boolean): () => void {
  const previous = desktopAvailable;
  desktopAvailable = provider;
  return () => {
    desktopAvailable = previous;
  };
}

export function resetCodexRuntimeForTests(): void {
  probeRevision += 1;
  unavailableNotified = false;
  useCodexRuntime.setState({
    phase: desktopAvailable() ? 'idle' : 'web',
    version: undefined,
    executablePath: undefined,
    source: undefined,
    protocolBaseline: undefined,
    minimumCandidate: undefined,
    verifiedVersions: undefined,
    compatibilityStatus: undefined,
    reasonCode: undefined,
    reason: undefined,
  });
}
