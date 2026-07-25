import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { setCodexBrainUnavailableReason } from '../lib/butlerBrain';
import { isTauri } from '../lib/http';
import { toast } from './toast';

export type CodexRuntimePhase = 'idle' | 'checking' | 'ready' | 'unavailable' | 'web';

export interface CodexRuntimeProbe {
  ready: boolean;
  version?: string;
  executablePath?: string;
  source?: 'bundled' | 'system';
  reason?: string;
}

interface CodexRuntimeState {
  phase: CodexRuntimePhase;
  version?: string;
  executablePath?: string;
  source?: 'bundled' | 'system';
  reason?: string;
  probe: () => Promise<void>;
}

type RuntimeInvoker = <T>(command: string) => Promise<T>;

let runtimeInvoke: RuntimeInvoker = (command) => invoke(command);
let desktopAvailable = () => isTauri;
let probeRevision = 0;
let unavailableNotified = false;

/**
 * 决策 13：不再静默切到另一个大脑。Codex 用不了就明说用不了——
 * 悄悄换一个能力不同的大脑，用户根本无从察觉自己拿到的答案是谁给的。
 */
function activateUnavailable(reason: string): void {
  setCodexBrainUnavailableReason(reason);
  if (!unavailableNotified) {
    unavailableNotified = true;
    toast.info(`管家暂时用不了：${reason}`);
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
        reason: undefined,
      });
      return;
    }
    set({ phase: 'checking', reason: undefined });
    setCodexBrainUnavailableReason('AI 正在准备中…');
    try {
      const result = await runtimeInvoke<CodexRuntimeProbe>('codex_runtime_probe');
      if (revision !== probeRevision) return;
      if (result.ready) {
        setCodexBrainUnavailableReason(undefined);
        set({
          phase: 'ready',
          version: result.version,
          executablePath: result.executablePath,
          source: result.source,
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
  setCodexBrainUnavailableReason(undefined);
  useCodexRuntime.setState({
    phase: desktopAvailable() ? 'idle' : 'web',
    version: undefined,
    executablePath: undefined,
    source: undefined,
    reason: undefined,
  });
}
