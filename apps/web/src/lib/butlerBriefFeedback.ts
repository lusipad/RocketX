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

export function removeBriefFeedback(
  title: string,
  storage: ButlerBriefFeedbackStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  const trimmed = title.trim();
  storage.setItem(
    BUTLER_BRIEF_FEEDBACK_KEY,
    JSON.stringify(listBriefFeedback(storage).filter((entry) => entry.title !== trimmed)),
  );
}

/** 「没用」条目的标题列表，用于提示大脑；判定压制请用 isNoisyBriefTitle。 */
export function noiseBriefFeedback(
  feedback: readonly ButlerBriefFeedback[],
): Array<{ text: string }> {
  return feedback
    .filter((entry) => entry.verdict === 'noise')
    .map((entry) => ({ text: entry.title }));
}

function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * per-item 反馈的压制判定：**标题精确相等**，不用 mute 那套双向子串包含。
 * 👎 是对「这一条」的评价，模糊化会让一次误点连坐掉标题相互包含的其它条目；
 * 「这一类少提」的泛化语义留给用户显式点「少来这种」（mute）。
 * 同名条目若又被标过 👍，以 👍 为准（recordBriefFeedback 按标题归并，后点覆盖先点）。
 */
export function isNoisyBriefTitle(
  title: string,
  feedback: readonly ButlerBriefFeedback[],
): boolean {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  return feedback.some((entry) => entry.verdict === 'noise' && normalizeTitle(entry.title) === normalized);
}
