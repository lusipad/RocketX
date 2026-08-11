import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { sanitizeDiagnosticText, type DiagnosticLevel, writeDiagnostic } from '../lib/diagnostics';
import { isTauri } from '../lib/http';
import { toast } from './toast';

export type CodexRuntimePhase = 'idle' | 'checking' | 'ready' | 'unavailable' | 'web';
export type CodexCompatibilityStatus = 'verified' | 'untested-newer' | 'blocked';
export type CodexRuntimeReasonCode =
  'not-found' | 'outdated' | 'manual-path' | 'missing-app-server' | 'not-logged-in' | 'unavailable';
export type CodexRuntimeCandidateOutcome = 'selected' | 'rejected';

export interface CodexRuntimeCandidate {
  source: 'manual' | 'bundled' | 'system';
  path: string;
  version?: string;
  outcome: CodexRuntimeCandidateOutcome;
  reasonCode?: CodexRuntimeReasonCode;
}

export interface CodexRuntimeProbe {
  ready: boolean;
  version?: string;
  executablePath?: string;
  source?: 'manual' | 'bundled' | 'system';
  protocolBaseline: string;
  minimumCandidate: string;
  verifiedVersions: string[];
  compatibilityStatus: CodexCompatibilityStatus;
  reasonCode?: CodexRuntimeReasonCode;
  reason?: string;
  candidates: CodexRuntimeCandidate[];
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
  reasonCode?: CodexRuntimeReasonCode;
  reason?: string;
  candidates: CodexRuntimeCandidate[];
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
let lastUnavailableSignature: string | undefined;
let runtimeDiagnosticWriter = writeDiagnostic;

function runtimeFailureSignature(reasonCode: CodexRuntimeReasonCode | undefined, reason: string): string {
  return `${reasonCode ?? 'unknown'}:${reason}`;
}

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
function activateUnavailable(reason: string, reasonCode?: CodexRuntimeReasonCode): void {
  const signature = runtimeFailureSignature(reasonCode, reason);
  if (lastUnavailableSignature !== signature) {
    lastUnavailableSignature = signature;
    toast.info(`Codex 暂时用不了：${reason}`);
  }
}

function clearUnavailableSignature(): void {
  lastUnavailableSignature = undefined;
}

async function logProbeCandidates(candidates: CodexRuntimeCandidate[]): Promise<void> {
  await Promise.all(candidates.map((candidate) => runtimeDiagnosticWriter(
    candidate.outcome === 'selected' ? 'info' : 'warn',
    'codex-runtime',
    `candidate source=${candidate.source} outcome=${candidate.outcome} path=${candidate.path}` +
      `${candidate.version ? ` version=${candidate.version}` : ''}` +
      `${candidate.reasonCode ? ` reason=${candidate.reasonCode}` : ''}`,
  )));
}

function normalizedCandidates(candidates: CodexRuntimeCandidate[] | undefined): CodexRuntimeCandidate[] {
  return (candidates ?? []).map((candidate) => ({ ...candidate }));
}

function pushSummaryLine(lines: string[], key: string, value: string | undefined): void {
  if (!value) return;
  lines.push(sanitizeDiagnosticText(`${key}: ${value}`));
}

export function buildCodexDiagnosticSummary(runtime: Pick<
  CodexRuntimeState,
  'phase' | 'version' | 'executablePath' | 'source' | 'protocolBaseline' | 'compatibilityStatus' | 'reasonCode' | 'candidates'
>): string {
  const lines: string[] = [];
  pushSummaryLine(lines, 'phase', runtime.phase);
  pushSummaryLine(lines, 'protocolBaseline', runtime.protocolBaseline);
  pushSummaryLine(lines, 'compatibilityStatus', runtime.compatibilityStatus);
  pushSummaryLine(lines, 'source', runtime.source);
  pushSummaryLine(lines, 'version', runtime.version);
  pushSummaryLine(lines, 'executablePath', runtime.executablePath);
  pushSummaryLine(lines, 'reasonCode', runtime.reasonCode);
  runtime.candidates.forEach((candidate, index) => {
    pushSummaryLine(
      lines,
      `candidate[${index}]`,
      [
        `source=${candidate.source}`,
        `outcome=${candidate.outcome}`,
        `path=${candidate.path}`,
        candidate.version ? `version=${candidate.version}` : undefined,
        candidate.reasonCode ? `reasonCode=${candidate.reasonCode}` : undefined,
      ].filter(Boolean).join(' '),
    );
  });
  return `${lines.join('\n')}\n`;
}

export const useCodexRuntime = create<CodexRuntimeState>((set) => ({
  phase: desktopAvailable() ? 'idle' : 'web',
  candidates: [],

  probe: async () => {
    const revision = ++probeRevision;
    if (!desktopAvailable()) {
      clearUnavailableSignature();
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
        candidates: [],
      });
      return;
    }
    set({ phase: 'checking', reason: undefined });
    try {
      const result = await runtimeInvoke<CodexRuntimeProbe>('codex_runtime_probe', {
        manualPath: getCodexManualPath() || null,
      });
      if (revision !== probeRevision) return;
      const candidates = normalizedCandidates(result.candidates);
      await logProbeCandidates(candidates);
      if (result.ready && result.compatibilityStatus !== 'blocked') {
        clearUnavailableSignature();
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
          candidates,
        });
        return;
      }
      const reason = result.reason || 'Codex 暂不可用';
      activateUnavailable(reason, result.reasonCode);
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
        candidates,
      });
    } catch (error) {
      if (revision !== probeRevision) return;
      const reason = `Codex 检测失败：${error instanceof Error ? error.message : String(error)}`;
      activateUnavailable(reason, 'unavailable');
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
        candidates: [],
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

export function setCodexRuntimeDiagnosticWriter(
  writer: (level: DiagnosticLevel, area: string, message: string) => Promise<void>,
): () => void {
  const previous = runtimeDiagnosticWriter;
  runtimeDiagnosticWriter = writer;
  return () => {
    runtimeDiagnosticWriter = previous;
  };
}

export function resetCodexRuntimeForTests(): void {
  probeRevision += 1;
  clearUnavailableSignature();
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
    candidates: [],
  });
}
