import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { setButlerBrain, setCodexBrainUnavailableReason } from '../lib/butlerBrain';
import { isTauri } from '../lib/http';
import { toast } from './toast';

export type CodexRuntimePhase = 'idle' | 'checking' | 'ready' | 'fallback' | 'web';

export interface CodexRuntimeProbe {
  ready: boolean;
  version?: string;
  executablePath?: string;
  reason?: string;
}

interface CodexRuntimeState {
  phase: CodexRuntimePhase;
  version?: string;
  executablePath?: string;
  reason?: string;
  probe: () => Promise<void>;
}

type RuntimeInvoker = <T>(command: string) => Promise<T>;

let runtimeInvoke: RuntimeInvoker = (command) => invoke(command);
let desktopAvailable = () => isTauri;
let probeRevision = 0;
let fallbackNotified = false;

function activateFallback(reason: string): void {
  setButlerBrain('api');
  setCodexBrainUnavailableReason(reason);
  if (!fallbackNotified) {
    fallbackNotified = true;
    toast.info('未检测到可用的 Codex，已切换到普通 AI');
  }
}

export const useCodexRuntime = create<CodexRuntimeState>((set) => ({
  phase: desktopAvailable() ? 'idle' : 'web',

  probe: async () => {
    const revision = ++probeRevision;
    if (!desktopAvailable()) {
      set({ phase: 'web', version: undefined, executablePath: undefined, reason: undefined });
      return;
    }
    set({ phase: 'checking', reason: undefined });
    setCodexBrainUnavailableReason('AI 正在准备中…');
    try {
      const result = await runtimeInvoke<CodexRuntimeProbe>('codex_runtime_probe');
      if (revision !== probeRevision) return;
      if (result.ready) {
        setButlerBrain('codex');
        setCodexBrainUnavailableReason(undefined);
        set({
          phase: 'ready',
          version: result.version,
          executablePath: result.executablePath,
          reason: undefined,
        });
        return;
      }
      const reason = result.reason || 'Codex 暂不可用';
      activateFallback(reason);
      set({
        phase: 'fallback',
        version: result.version,
        executablePath: result.executablePath,
        reason,
      });
    } catch (error) {
      if (revision !== probeRevision) return;
      const reason = `Codex 检测失败：${error instanceof Error ? error.message : String(error)}`;
      activateFallback(reason);
      set({ phase: 'fallback', version: undefined, executablePath: undefined, reason });
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

export function setCodexRuntimePlatform(provider: () => boolean): () => void {
  const previous = desktopAvailable;
  desktopAvailable = provider;
  return () => {
    desktopAvailable = previous;
  };
}

export function resetCodexRuntimeForTests(): void {
  probeRevision += 1;
  fallbackNotified = false;
  setCodexBrainUnavailableReason(undefined);
  useCodexRuntime.setState({
    phase: desktopAvailable() ? 'idle' : 'web',
    version: undefined,
    executablePath: undefined,
    reason: undefined,
  });
}
