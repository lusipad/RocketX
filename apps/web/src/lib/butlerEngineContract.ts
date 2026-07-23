export type ButlerEngineBrain = 'api' | 'codex';
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

export interface ButlerEngineState {
  version: 1;
  activeBrain: ButlerEngineBrain;
  status: ButlerEngineStatus;
  transcriptRevision: number;
  resumeRevisionByBrain: Record<ButlerEngineBrain, number>;
  compatibility: ButlerEngineCompatibility;
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/** 持久化数据属于不可信输入；只恢复完整、已知版本的 engine state。 */
export function normalizeButlerEngineState(value: unknown): ButlerEngineState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ButlerEngineState>;
  if (candidate.version !== 1) return undefined;
  if (candidate.activeBrain !== 'api' && candidate.activeBrain !== 'codex') return undefined;
  if (
    candidate.status !== 'ready'
    && candidate.status !== 'running'
    && candidate.status !== 'paused'
    && candidate.status !== 'failed'
  ) return undefined;
  if (!isRevision(candidate.transcriptRevision)) return undefined;

  const resume = candidate.resumeRevisionByBrain;
  if (!resume || !isRevision(resume.api) || !isRevision(resume.codex)) return undefined;

  const compatibility = candidate.compatibility;
  if (!compatibility) return undefined;
  if (
    compatibility.mode !== 'native'
    && compatibility.mode !== 'transcript'
    && compatibility.mode !== 'incompatible'
  ) return undefined;
  if (compatibility.reason !== null && typeof compatibility.reason !== 'string') return undefined;

  return {
    version: 1,
    activeBrain: candidate.activeBrain,
    status: candidate.status,
    transcriptRevision: candidate.transcriptRevision,
    resumeRevisionByBrain: { api: resume.api, codex: resume.codex },
    compatibility: { mode: compatibility.mode, reason: compatibility.reason },
  };
}

function transcriptRevision(transcript: readonly ButlerEngineTranscriptLine[]): number {
  return transcript.reduce((latest, line) => Math.max(latest, line.revision), 0);
}

export function initializeButlerEngineState(input: {
  activeBrain: ButlerEngineBrain;
  transcript: readonly ButlerEngineTranscriptLine[];
}): ButlerEngineState {
  const revision = transcriptRevision(input.transcript);
  return {
    version: 1,
    activeBrain: input.activeBrain,
    status: 'ready',
    transcriptRevision: revision,
    resumeRevisionByBrain: {
      api: input.activeBrain === 'api' ? revision : 0,
      codex: input.activeBrain === 'codex' ? revision : 0,
    },
    compatibility: { mode: 'native', reason: null },
  };
}

export function prepareButlerEngineTurn(input: {
  engineState: ButlerEngineState;
  targetBrain: ButlerEngineBrain;
  transcript: readonly ButlerEngineTranscriptLine[];
}): {
  engineState: ButlerEngineState;
  bridgeTranscript: ButlerEngineTranscriptLine[];
  compatibility: ButlerEngineCompatibility;
} {
  const revision = transcriptRevision(input.transcript);
  const resumeRevision = input.engineState.resumeRevisionByBrain[input.targetBrain];
  const firstRevision = input.transcript[0]?.revision ?? revision + 1;
  const switched = input.engineState.activeBrain !== input.targetBrain;
  let compatibility: ButlerEngineCompatibility;
  if (resumeRevision > revision) {
    compatibility = { mode: 'incompatible', reason: 'resume-ahead-of-transcript' };
  } else if (resumeRevision < firstRevision - 1) {
    compatibility = { mode: 'incompatible', reason: 'transcript-gap' };
  } else if (switched) {
    compatibility = { mode: 'transcript', reason: 'brain-switched' };
  } else if (resumeRevision < revision) {
    compatibility = { mode: 'transcript', reason: 'transcript-behind' };
  } else {
    compatibility = { mode: 'native', reason: null };
  }
  return {
    engineState: {
      ...input.engineState,
      activeBrain: input.targetBrain,
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
  input: { completedBrain: ButlerEngineBrain; transcriptRevision: number },
): ButlerEngineState {
  return {
    ...state,
    activeBrain: input.completedBrain,
    status: 'ready',
    transcriptRevision: input.transcriptRevision,
    resumeRevisionByBrain: {
      ...state.resumeRevisionByBrain,
      [input.completedBrain]: input.transcriptRevision,
    },
    compatibility: state.compatibility.mode === 'incompatible'
      ? state.compatibility
      : { mode: 'native', reason: null },
  };
}

export function failButlerEngineTurn(
  state: ButlerEngineState,
  input: { failedBrain: ButlerEngineBrain; error: string },
): ButlerEngineState {
  return {
    ...state,
    activeBrain: input.failedBrain,
    status: 'failed',
    compatibility: { mode: 'incompatible', reason: input.error },
  };
}

export function pauseButlerEngineTurn(
  state: ButlerEngineState,
  input: { pausedBrain: ButlerEngineBrain },
): ButlerEngineState {
  return { ...state, activeBrain: input.pausedBrain, status: 'paused' };
}
