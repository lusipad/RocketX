export const BUTLER_BRIEF_FEEDBACK_KEY = 'rcx-butler-v1:brief-feedback';

const MAX_FEEDBACK = 200;

export type ButlerBriefVerdict = 'useful' | 'noise';

export interface ButlerBriefFeedback {
  ref: string;
  title: string;
  verdict: ButlerBriefVerdict;
  at: number;
}

export interface ButlerBriefFeedbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ButlerBriefFeedbackStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function validFeedback(value: unknown): value is ButlerBriefFeedback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.ref === 'string'
    && !!entry.ref.trim()
    && typeof entry.title === 'string'
    && !!entry.title.trim()
    && (entry.verdict === 'useful' || entry.verdict === 'noise')
    && typeof entry.at === 'number'
    && Number.isFinite(entry.at);
}

export function listBriefFeedback(
  storage: ButlerBriefFeedbackStorage | undefined = browserStorage(),
): ButlerBriefFeedback[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(BUTLER_BRIEF_FEEDBACK_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validFeedback).slice(-MAX_FEEDBACK);
  } catch {
    return [];
  }
}

/** 同一条目的反馈后点覆盖先点（按标题归并，跨轮 ref 会变而标题稳定）。 */
export function recordBriefFeedback(
  input: Pick<ButlerBriefFeedback, 'ref' | 'title' | 'verdict'>,
  storage: ButlerBriefFeedbackStorage | undefined = browserStorage(),
  at = Date.now(),
): ButlerBriefFeedback | null {
  const title = input.title.trim();
  const ref = input.ref.trim();
  if (!title || !ref || !storage) return null;
  const entry = { ref, title, verdict: input.verdict, at } satisfies ButlerBriefFeedback;
  const kept = listBriefFeedback(storage).filter((item) => item.title !== title);
  storage.setItem(BUTLER_BRIEF_FEEDBACK_KEY, JSON.stringify([...kept, entry].slice(-MAX_FEEDBACK)));
  return entry;
}

/** 「没用」条目，形态兼容 matchesMute 的 {text} 提示列表。 */
export function noiseBriefFeedback(
  feedback: readonly ButlerBriefFeedback[],
): Array<{ text: string }> {
  return feedback
    .filter((entry) => entry.verdict === 'noise')
    .map((entry) => ({ text: entry.title }));
}
