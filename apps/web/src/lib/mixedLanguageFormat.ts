const HAN_CHARACTER = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const ASCII_WORD_CHARACTER = /[A-Za-z0-9]/u;

type Segment = {
  text: string;
  kind: 'plain' | 'code' | 'url';
};

// Code and URL spans are kept intact so formatting cannot change executable
// examples, inline code, or links.
const PROTECTED_SPAN = /```[\s\S]*?(?:```|$)|`[^`\r\n]*`|(?:https?|ftp):\/\/[^\s<>()\u3000-\u303F\uFF00-\uFF65]+|www\.[^\s<>()\u3000-\u303F\uFF00-\uFF65]+/giu;

function isHanCharacter(value: string): boolean {
  return HAN_CHARACTER.test(value);
}

function isAsciiWordCharacter(value: string): boolean {
  return ASCII_WORD_CHARACTER.test(value);
}

function needsSpace(left: string, right: string): boolean {
  return (
    (isHanCharacter(left) && isAsciiWordCharacter(right)) ||
    (isAsciiWordCharacter(left) && isHanCharacter(right))
  );
}

function formatPlainText(text: string): string {
  const characters = Array.from(text);
  let result = '';
  for (const [index, character] of characters.entries()) {
    const previous = characters[index - 1];
    if (previous && needsSpace(previous, character)) result += ' ';
    result += character;
  }
  return result;
}

function splitProtectedSpans(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PROTECTED_SPAN)) {
    const start = match.index ?? cursor;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), kind: 'plain' });
    const kind = match[0].startsWith('`') ? 'code' : 'url';
    segments.push({ text: match[0], kind });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: 'plain' });
  return segments;
}

export function formatMixedLanguageText(text: string): string {
  let result = '';
  let previousEdge: string | undefined;
  for (const segment of splitProtectedSpans(text)) {
    const value = segment.kind === 'plain' ? formatPlainText(segment.text) : segment.text;
    const characters = Array.from(value);
    const first = characters[0];
    if (previousEdge && first && needsSpace(previousEdge, first)) result += ' ';
    result += value;
    // URLs participate in spacing at their edges, while code delimiters and
    // contents are entirely opaque to the formatter.
    previousEdge = segment.kind === 'code' ? undefined : characters.at(-1);
  }
  return result;
}
