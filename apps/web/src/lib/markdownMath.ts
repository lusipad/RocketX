export type MarkdownMathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; display: boolean };

const BLOCK_TEX_SIGNAL_RE = /\\[A-Za-z]+|[_^]\{/;
const INLINE_TEX_SIGNAL_RE =
  /\\[A-Za-z]+|[_^]\{|[_^]|[=<>+\-*/]|^[A-Za-z](?:[A-Za-z0-9]|\\[A-Za-z]+)*$/;

function pushText(segments: MarkdownMathSegment[], value: string) {
  if (!value) return;
  const last = segments.at(-1);
  if (last?.kind === 'text') {
    last.value += value;
    return;
  }
  segments.push({ kind: 'text', value });
}

function pushMath(segments: MarkdownMathSegment[], value: string, display: boolean) {
  segments.push({ kind: 'math', value: value.trim(), display });
}

function collectMultiLineBlock(
  lines: string[],
  startIndex: number,
  closeMarker: string,
  allowTrailingText = false,
): { endIndex: number; body: string; trailingText: string } | null {
  const body: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmedStart = raw.trimStart();
    if (trimmedStart.startsWith(closeMarker)) {
      const trailingText = trimmedStart.slice(closeMarker.length);
      if (!trailingText || allowTrailingText) {
        return { endIndex: i, body: body.join('\n'), trailingText };
      }
    }
    body.push(raw);
  }
  return null;
}

function matchesStandaloneSingleLine(
  trimmed: string,
  openMarker: string,
  closeMarker: string,
): string | null {
  if (!trimmed.startsWith(openMarker) || !trimmed.endsWith(closeMarker)) return null;
  if (trimmed === openMarker || trimmed === closeMarker) return null;
  const body = trimmed.slice(openMarker.length, trimmed.length - closeMarker.length).trim();
  return body ? body : null;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function findInlineCodeEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '`' && !isEscaped(text, i)) {
      return i;
    }
  }
  return -1;
}

function findEscapedDelimiterEnd(text: string, start: number): number {
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '`' && !isEscaped(text, i)) {
      const codeEnd = findInlineCodeEnd(text, i);
      if (codeEnd === -1) return -1;
      i = codeEnd;
      continue;
    }
    if (text[i] === '\\' && text[i + 1] === ')' && !isEscaped(text, i)) {
      return i;
    }
  }
  return -1;
}

function findDollarEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '`' && !isEscaped(text, i)) {
      const codeEnd = findInlineCodeEnd(text, i);
      if (codeEnd === -1) return -1;
      i = codeEnd;
      continue;
    }
    if (
      text[i] === '$' &&
      !isEscaped(text, i) &&
      text[i - 1] !== ' ' &&
      text[i - 1] !== '\t' &&
      text[i + 1] !== '$'
    ) {
      return i;
    }
  }
  return -1;
}

function isLikelyInlineMath(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (/^\d+(?:[.,]\d+)*$/.test(trimmed)) return false;
  return INLINE_TEX_SIGNAL_RE.test(trimmed);
}

export function splitBlockMath(text: string): MarkdownMathSegment[] {
  const lines = text.split('\n');
  const segments: MarkdownMathSegment[] = [];
  const textLines: string[] = [];

  const flushText = () => {
    if (!textLines.length) return;
    pushText(segments, textLines.join('\n'));
    textLines.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const singleDollar = matchesStandaloneSingleLine(trimmed, '$$', '$$');
    if (singleDollar !== null) {
      flushText();
      pushMath(segments, singleDollar, true);
      continue;
    }

    const singleBracket = matchesStandaloneSingleLine(trimmed, '\\[', '\\]');
    if (singleBracket !== null) {
      flushText();
      pushMath(segments, singleBracket, true);
      continue;
    }

    if (trimmed === '$$') {
      const block = collectMultiLineBlock(lines, i, '$$', true);
      if (block) {
        flushText();
        pushMath(segments, block.body, true);
        if (block.trailingText) {
          textLines.push(block.trailingText);
        }
        i = block.endIndex;
        continue;
      }
    }

    if (trimmed === '\\[') {
      const block = collectMultiLineBlock(lines, i, '\\]', true);
      if (block) {
        flushText();
        pushMath(segments, block.body, true);
        if (block.trailingText) {
          textLines.push(block.trailingText);
        }
        i = block.endIndex;
        continue;
      }
    }

    if (trimmed === '[') {
      const block = collectMultiLineBlock(lines, i, ']');
      if (block && BLOCK_TEX_SIGNAL_RE.test(block.body)) {
        flushText();
        pushMath(segments, block.body, true);
        i = block.endIndex;
        continue;
      }
    }

    textLines.push(line);
  }

  flushText();
  return segments.length ? segments : [{ kind: 'text', value: text }];
}

export function splitInlineMath(text: string): MarkdownMathSegment[] {
  const segments: MarkdownMathSegment[] = [];
  let textStart = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === '`' && !isEscaped(text, i)) {
      const codeEnd = findInlineCodeEnd(text, i);
      if (codeEnd === -1) break;
      i = codeEnd + 1;
      continue;
    }

    if (text[i] === '\\' && text[i + 1] === '(' && !isEscaped(text, i)) {
      const end = findEscapedDelimiterEnd(text, i + 2);
      if (end !== -1 && isLikelyInlineMath(text.slice(i + 2, end))) {
        pushText(segments, text.slice(textStart, i));
        pushMath(segments, text.slice(i + 2, end), false);
        i = end + 2;
        textStart = i;
        continue;
      }
    }

    if (
      text[i] === '$' &&
      !isEscaped(text, i) &&
      text[i + 1] !== '$' &&
      text[i + 1] !== ' ' &&
      text[i + 1] !== '\t'
    ) {
      const end = findDollarEnd(text, i + 1);
      if (end !== -1 && isLikelyInlineMath(text.slice(i + 1, end))) {
        pushText(segments, text.slice(textStart, i));
        pushMath(segments, text.slice(i + 1, end), false);
        i = end + 1;
        textStart = i;
        continue;
      }
    }

    i++;
  }

  pushText(segments, text.slice(textStart));
  return segments.length ? segments : [{ kind: 'text', value: text }];
}
