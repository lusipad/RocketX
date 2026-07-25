export type ButlerEngineStatus = 'ready' | 'running' | 'paused' | 'failed';
export type ButlerEngineCompatibilityMode = 'native' | 'transcript' | 'incompatible';

export interface ButlerEngineTranscriptLine {
  revision: number;
  role: 'user' | 'assistant';
  text: string;
}

export interface ButlerEngineCompatibility {
  mode: ButlerEngineCompatibilityMode;
  reason: string | null;
}

/**
 * 决策 13：Codex 是唯一大脑，这里不再记录「当前是哪个引擎」。
 * 保留下来的字段都是单大脑同样需要的：turn 状态、已喂给引擎的进度、中断恢复的兼容判断。
 */
export interface ButlerEngineState {
  version: 2;
  status: ButlerEngineStatus;
  transcriptRevision: number;
  /** 已经喂给 Codex thread 的最后一条 revision；resume 时据此算增量。 */
  resumeRevision: number;
  compatibility: ButlerEngineCompatibility;
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/**
 * 持久化数据属于不可信输入；只恢复完整、已知版本的 engine state。
 * 双大脑时代的 version 1 在这里被拒绝，调用方回退到从 transcript 冷启动——
 * 不崩、不丢对话内容。
 */
export function normalizeButlerEngineState(value: unknown): ButlerEngineState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ButlerEngineState>;
  if (candidate.version !== 2) return undefined;
  if (
    candidate.status !== 'ready'
    && candidate.status !== 'running'
    && candidate.status !== 'paused'
    && candidate.status !== 'failed'
  ) return undefined;
  if (!isRevision(candidate.transcriptRevision)) return undefined;
  if (!isRevision(candidate.resumeRevision)) return undefined;

  const compatibility = candidate.compatibility;
  if (!compatibility) return undefined;
  if (
    compatibility.mode !== 'native'
    && compatibility.mode !== 'transcript'
    && compatibility.mode !== 'incompatible'
  ) return undefined;
  if (compatibility.reason !== null && typeof compatibility.reason !== 'string') return undefined;

  return {
    version: 2,
    status: candidate.status,
    transcriptRevision: candidate.transcriptRevision,
    resumeRevision: candidate.resumeRevision,
    compatibility: { mode: compatibility.mode, reason: compatibility.reason },
  };
}

function transcriptRevision(transcript: readonly ButlerEngineTranscriptLine[]): number {
  return transcript.reduce((latest, line) => Math.max(latest, line.revision), 0);
}

export function initializeButlerEngineState(input: {
  transcript: readonly ButlerEngineTranscriptLine[];
  /** 已有 Codex thread 的会话从当前进度接着走；全新会话从 0 开始。 */
  resumed?: boolean;
}): ButlerEngineState {
  const revision = transcriptRevision(input.transcript);
  return {
    version: 2,
    status: 'ready',
    transcriptRevision: revision,
    resumeRevision: input.resumed ? revision : 0,
    compatibility: { mode: 'native', reason: null },
  };
}

export function prepareButlerEngineTurn(input: {
  engineState: ButlerEngineState;
  transcript: readonly ButlerEngineTranscriptLine[];
}): {
  engineState: ButlerEngineState;
  bridgeTranscript: ButlerEngineTranscriptLine[];
  compatibility: ButlerEngineCompatibility;
} {
  const revision = transcriptRevision(input.transcript);
  const { resumeRevision } = input.engineState;
  const firstRevision = input.transcript[0]?.revision ?? revision + 1;
  let compatibility: ButlerEngineCompatibility;
  if (resumeRevision > revision) {
    compatibility = { mode: 'incompatible', reason: 'resume-ahead-of-transcript' };
  } else if (resumeRevision < firstRevision - 1) {
    compatibility = { mode: 'incompatible', reason: 'transcript-gap' };
  } else if (resumeRevision < revision) {
    compatibility = { mode: 'transcript', reason: 'transcript-behind' };
  } else {
    compatibility = { mode: 'native', reason: null };
  }
  return {
    engineState: {
      ...input.engineState,
      status: 'running',
      transcriptRevision: revision,
      compatibility,
    },
    bridgeTranscript: input.transcript.filter((line) => line.revision > resumeRevision),
    compatibility,
  };
}

export function completeButlerEngineTurn(
  state: ButlerEngineState,
  input: { transcriptRevision: number },
): ButlerEngineState {
  return {
    ...state,
    status: 'ready',
    transcriptRevision: input.transcriptRevision,
    resumeRevision: input.transcriptRevision,
    compatibility: state.compatibility.mode === 'incompatible'
      ? state.compatibility
      : { mode: 'native', reason: null },
  };
}

export function failButlerEngineTurn(
  state: ButlerEngineState,
  input: { error: string },
): ButlerEngineState {
  return {
    ...state,
    status: 'failed',
    compatibility: { mode: 'incompatible', reason: input.error },
  };
}

export function pauseButlerEngineTurn(state: ButlerEngineState): ButlerEngineState {
  return { ...state, status: 'paused' };
}
