export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface SplitDiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/** Parse a unified git patch into structured hunks with exact old/new line numbers. */
export function parseUnifiedPatch(patch: string): DiffHunk[] {
  if (!patch.trim()) return [];
  const rawLines = patch.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const raw of rawLines) {
    const match = HUNK_HEADER_RE.exec(raw);
    if (match) {
      if (current) hunks.push(current);
      const oldStart = Number.parseInt(match[1], 10) || 1;
      const oldLines = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      const newStart = Number.parseInt(match[3], 10) || 1;
      const newLines = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
      oldCursor = oldStart;
      newCursor = newStart;
      current = {
        id: `hunk-${hunks.length + 1}-${oldStart}-${newStart}`,
        header: raw,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      continue;
    }

    if (!current) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.lines.push({
        type: 'add',
        oldLine: null,
        newLine: newCursor++,
        text: raw.slice(1),
      });
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      current.lines.push({
        type: 'del',
        oldLine: oldCursor++,
        newLine: null,
        text: raw.slice(1),
      });
    } else if (raw.startsWith('\\')) {
      current.lines.push({
        type: 'meta',
        oldLine: null,
        newLine: null,
        text: raw,
      });
    } else {
      current.lines.push({
        type: 'context',
        oldLine: oldCursor++,
        newLine: newCursor++,
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
      });
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

/** Pair deletions and additions within a hunk for clean side-by-side Split view. */
export function buildSplitDiffRows(lines: readonly DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.type === 'context' || line.type === 'meta') {
      rows.push({ left: line, right: line });
      idx += 1;
      continue;
    }

    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (idx < lines.length && lines[idx].type === 'del') {
      deletions.push(lines[idx]);
      idx += 1;
    }
    while (idx < lines.length && lines[idx].type === 'add') {
      additions.push(lines[idx]);
      idx += 1;
    }
    const maxLen = Math.max(deletions.length, additions.length);
    for (let k = 0; k < maxLen; k += 1) {
      rows.push({
        left: deletions[k] ?? null,
        right: additions[k] ?? null,
      });
    }
  }

  return rows;
}
