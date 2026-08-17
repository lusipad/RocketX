export const DEFAULT_MESSAGE_MAX_ALLOWED_SIZE = 5000;

interface FenceState {
  marker: string;
  language: string;
}

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeMessageMaxAllowedSize(value: unknown): number {
  const parsed = parsePositiveNumber(value);
  if (parsed === null || parsed <= 0) return DEFAULT_MESSAGE_MAX_ALLOWED_SIZE;
  return Math.max(1, Math.floor(parsed));
}

function isHighSurrogate(charCode: number): boolean {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

function isLowSurrogate(charCode: number): boolean {
  return charCode >= 0xdc00 && charCode <= 0xdfff;
}

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function safeSliceEnd(text: string, start: number, end: number): number {
  let next = Math.min(text.length, Math.max(start, end));
  if (graphemeSegmenter) {
    let boundary = start;
    for (const segment of graphemeSegmenter.segment(text)) {
      if (segment.index < start) continue;
      const segmentEnd = segment.index + segment.segment.length;
      if (segmentEnd > next) break;
      boundary = segmentEnd;
    }
    if (boundary > start) return boundary;
  }
  if (
    next > start &&
    next < text.length &&
    isHighSurrogate(text.charCodeAt(next - 1)) &&
    isLowSurrogate(text.charCodeAt(next))
  ) {
    next -= 1;
  }
  return next;
}

function nextTextBoundary(text: string, start: number): number {
  if (graphemeSegmenter) {
    for (const segment of graphemeSegmenter.segment(text)) {
      if (segment.index < start) continue;
      return segment.index + segment.segment.length;
    }
  }
  const codePoint = text.codePointAt(start);
  if (codePoint === undefined) return start;
  return start + (codePoint > 0xffff ? 2 : 1);
}

function advanceAtLeastOneUnit(text: string, start: number, width: number): number {
  const next = safeSliceEnd(text, start, start + Math.max(1, width));
  if (next > start) return next;
  return nextTextBoundary(text, start);
}

function lastParagraphBoundary(text: string): number {
  let last = -1;
  const regex = /\r?\n[ \t]*\r?\n/gu;
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    const index = match.index ?? -1;
    if (index >= 0) last = index + value.length;
  }
  return last;
}

function lastWhitespaceBoundary(text: string): number {
  let last = -1;
  const regex = /[^\S\r\n]+/gu;
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    const index = match.index ?? -1;
    if (index >= 0) last = index + value.length;
  }
  return last;
}

function preferredSliceEnd(text: string, start: number, maxEnd: number): number {
  const boundedEnd = safeSliceEnd(text, start, maxEnd);
  if (boundedEnd >= text.length) return text.length;
  const slice = text.slice(start, boundedEnd);
  const minimumPreferredWidth = Math.max(1, Math.floor((boundedEnd - start) / 2));
  const paragraphBoundary = lastParagraphBoundary(slice);
  if (paragraphBoundary >= minimumPreferredWidth) return start + paragraphBoundary;
  const lineBoundary = Math.max(slice.lastIndexOf('\n') + 1, slice.lastIndexOf('\r') + 1);
  if (lineBoundary >= minimumPreferredWidth) return start + lineBoundary;
  const whitespaceBoundary = lastWhitespaceBoundary(slice);
  if (whitespaceBoundary >= minimumPreferredWidth) return start + whitespaceBoundary;
  return boundedEnd;
}

function scanFenceState(text: string, initial: FenceState | null, startsAtLineStart: boolean): FenceState | null {
  let state = initial;
  let cursor = 0;
  let atLineStart = startsAtLineStart;
  while (cursor < text.length) {
    const lineBreak = text.indexOf('\n', cursor);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    let line = text.slice(cursor, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!state && atLineStart) {
      const backtickMatch = line.match(/^[ ]{0,3}(`{3,})([^`]*)$/u);
      const tildeMatch = line.match(/^[ ]{0,3}(~{3,})(.*)$/u);
      const openMatch = backtickMatch ?? tildeMatch;
      if (openMatch) {
        state = {
          marker: openMatch[1],
          language: openMatch[2],
        };
      }
    } else if (state && atLineStart) {
      const closeMatch = line.match(/^[ ]{0,3}((?:`{3,}|~{3,}))\s*$/u);
      if (
        closeMatch &&
        closeMatch[1][0] === state.marker[0] &&
        closeMatch[1].length >= state.marker.length
      ) {
        state = null;
      }
    }
    cursor = lineBreak === -1 ? text.length : lineBreak + 1;
    atLineStart = lineBreak !== -1;
  }
  return state;
}

function reopenFence(state: FenceState): string {
  return `${state.marker}${state.language}\n`;
}

function closeFence(state: FenceState, content: string): string {
  return `${content.endsWith('\n') || content.endsWith('\r') ? '' : '\n'}${state.marker}`;
}

function continuationIndentPrefix(text: string, start: number, startsAtLineStart: boolean): string {
  if (startsAtLineStart || start <= 0) return '';
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let indentEnd = lineStart;
  while (indentEnd < text.length && (text[indentEnd] === ' ' || text[indentEnd] === '\t')) indentEnd += 1;
  if (indentEnd === lineStart || start < indentEnd) return '';
  return text.slice(lineStart, indentEnd);
}

function renderChunk(
  text: string,
  start: number,
  end: number,
  state: FenceState | null,
  startsAtLineStart: boolean,
): { text: string; nextState: FenceState | null; prefix: string } {
  const indentPrefix = continuationIndentPrefix(text, start, startsAtLineStart);
  const prefix = `${state ? reopenFence(state) : ''}${indentPrefix}`;
  const nextState = scanFenceState(text.slice(start, end), state, startsAtLineStart);
  let chunk = prefix + text.slice(start, end);
  if (nextState) chunk += closeFence(nextState, text.slice(start, end));
  return { text: chunk, nextState, prefix };
}

function chunkText(
  text: string,
  start: number,
  limit: number,
  state: FenceState | null,
  startsAtLineStart: boolean,
): { text: string; end: number; nextState: FenceState | null } {
  const indentPrefix = continuationIndentPrefix(text, start, startsAtLineStart);
  const preferredPrefix = `${state ? reopenFence(state) : ''}${indentPrefix}`;
  const minimumSuffixLength = state ? state.marker.length : 0;
  const suffixBase = state ? minimumSuffixLength : 0;
  const prefix = preferredPrefix;
  const rawBudget = limit - prefix.length - suffixBase;
  const initialEnd = preferredSliceEnd(
    text,
    start,
    advanceAtLeastOneUnit(text, start, rawBudget > 0 ? rawBudget : 1),
  );
  let end = initialEnd;
  let rendered = renderChunk(text, start, end, state, startsAtLineStart);
  let nextState = rendered.nextState;
  let chunk = rendered.text;

  while (chunk.length > limit && end > start) {
    const previousEnd = end;
    const reduced = preferredSliceEnd(
      text,
      start,
      safeSliceEnd(text, start, end - 1),
    );
    end = reduced > start ? reduced : advanceAtLeastOneUnit(text, start, Math.max(1, end - start - 1));
    if (end >= previousEnd) break;
    rendered = renderChunk(text, start, end, state, startsAtLineStart);
    nextState = rendered.nextState;
    chunk = rendered.text;
  }

  if (chunk.length > limit) {
    const fallbackEnd = nextTextBoundary(text, start);
    rendered = renderChunk(text, start, fallbackEnd, state, startsAtLineStart);
    chunk = rendered.text;
    nextState = rendered.nextState;
    if (chunk.length > limit) throw new Error('单个字符超过消息上限');
    return {
      text: chunk,
      end: fallbackEnd,
      nextState,
    };
  }

  return {
    text: chunk,
    end,
    nextState: end < text.length ? nextState : null,
  };
}

export function splitMessageForRocketChat(text: string, limitValue: unknown): string[] {
  const limit = normalizeMessageMaxAllowedSize(limitValue);
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  let state: FenceState | null = null;
  while (cursor < text.length) {
    const next = chunkText(text, cursor, limit, state, cursor === 0 || text[cursor - 1] === '\n');
    chunks.push(next.text);
    cursor = next.end;
    state = next.nextState;
  }
  return chunks;
}

export function toSendableMessageChunks(text: string, limitValue: unknown): string[] {
  return splitMessageForRocketChat(text, limitValue)
    .filter((chunk) => chunk.trim().length > 0);
}
