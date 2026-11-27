import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildSplitDiffRows, parseUnifiedPatch } from '../../apps/web/src/lib/workDiff';

test('parseUnifiedPatch extracts hunk coordinates and line numbers accurately', () => {
  const samplePatch = [
    'diff --git a/src/example.ts b/src/example.ts',
    'index 1111111..2222222 100644',
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    '@@ -10,4 +10,5 @@ export function demo() {',
    ' const keepBefore = 1;',
    '-const oldLine = true;',
    '+const newLine = false;',
    '+const addedLine = 42;',
    ' return keepBefore;',
    ' }',
  ].join('\n');

  const hunks = parseUnifiedPatch(samplePatch);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 10);
  assert.equal(hunks[0].newStart, 10);
  assert.equal(hunks[0].lines.length, 6);

  assert.deepEqual(hunks[0].lines[0], {
    type: 'context',
    oldLine: 10,
    newLine: 10,
    text: 'const keepBefore = 1;',
  });
  assert.deepEqual(hunks[0].lines[1], {
    type: 'del',
    oldLine: 11,
    newLine: null,
    text: 'const oldLine = true;',
  });
  assert.deepEqual(hunks[0].lines[2], {
    type: 'add',
    oldLine: null,
    newLine: 11,
    text: 'const newLine = false;',
  });
  assert.deepEqual(hunks[0].lines[3], {
    type: 'add',
    oldLine: null,
    newLine: 12,
    text: 'const addedLine = 42;',
  });
  assert.deepEqual(hunks[0].lines[4], {
    type: 'context',
    oldLine: 12,
    newLine: 13,
    text: 'return keepBefore;',
  });
});

test('buildSplitDiffRows aligns deletions and additions cleanly side-by-side', () => {
  const [hunk] = parseUnifiedPatch([
    '@@ -1,4 +1,5 @@',
    ' line1',
    '-removed1',
    '-removed2',
    '+added1',
    ' line4',
    '+appended',
  ].join('\n'));

  const split = buildSplitDiffRows(hunk.lines);
  assert.equal(split.length, 5);
  assert.equal(split[0].left?.text, 'line1');
  assert.equal(split[0].right?.text, 'line1');
  assert.equal(split[1].left?.text, 'removed1');
  assert.equal(split[1].right?.text, 'added1');
  assert.equal(split[2].left?.text, 'removed2');
  assert.equal(split[2].right, null);
  assert.equal(split[3].left?.text, 'line4');
  assert.equal(split[4].left, null);
  assert.equal(split[4].right?.text, 'appended');
});

test('WorkDiffDrawer is wired into ButlerConversation, WorkCardPortal, and AcpWorkspaceSurface', () => {
  const butlerConv = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const workPortal = readFileSync('apps/web/src/components/WorkCardPortal.tsx', 'utf8');
  const acpSurface = readFileSync('apps/web/src/components/AcpWorkspaceSurface.tsx', 'utf8');
  const codexWorkspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');

  assert.match(butlerConv, /WorkDiffDrawer/);
  assert.match(workPortal, /WorkDiffDrawer/);
  assert.match(acpSurface, /WorkDiffDrawer/);
  assert.match(codexWorkspace, /createGitCheckpoint/);
});
