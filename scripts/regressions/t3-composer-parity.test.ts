import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyComposerReplacement,
  detectComposerTrigger,
  rankSlashCommands,
  stripAnsiSequences,
} from '../../apps/web/src/lib/composerCommands';

test('detectComposerTrigger recognizes @file mentions and leading /slash commands at cursor', () => {
  assert.deepEqual(detectComposerTrigger('check @src/main', 15), {
    kind: 'file',
    query: 'src/main',
    start: 6,
    end: 15,
  });
  assert.deepEqual(detectComposerTrigger('/rev', 4), {
    kind: 'slash',
    query: 'rev',
    start: 0,
    end: 4,
  });
  assert.deepEqual(detectComposerTrigger('hello\n/pl', 9), {
    kind: 'slash',
    query: 'pl',
    start: 6,
    end: 9,
  });
  // Slash inside middle of a sentence or path is not a slash command
  assert.equal(detectComposerTrigger('path a/b', 8), null);
});

test('applyComposerReplacement inserts clean chip with single trailing space', () => {
  const token = detectComposerTrigger('inspect @Work', 13)!;
  const result = applyComposerReplacement('inspect @Work', token, '@apps/web/src/WorkDiffDrawer.tsx');
  assert.equal(result.nextText, 'inspect @apps/web/src/WorkDiffDrawer.tsx ');
  assert.equal(result.nextCursor, result.nextText.length);
});

test('rankSlashCommands filters and prioritizes built-ins plus custom skills', () => {
  const ranked = rankSlashCommands(
    'rev',
    (k) => k,
    [{ id: 's1', slug: 'rev-security', name: 'Security Review', description: 'Check auth', promptTemplate: 'Audit auth' }],
  );
  assert.equal(ranked[0].command, 'rev-security');
  assert.ok(ranked.some((c) => c.command === 'review'));
});

test('stripAnsiSequences cleans terminal escape codes without altering plain output', () => {
  const raw = '\u001b[32mPASS\u001b[0m\r\nDone in \u001b[1m1.2s\u001b[0m';
  assert.equal(stripAnsiSequences(raw), 'PASS\nDone in 1.2s');
});

test('Phase 3 integrated terminal, unified composer, and ACP model/queue wiring exist', () => {
  const butlerConv = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const acpSurface = readFileSync('apps/web/src/components/AcpWorkspaceSurface.tsx', 'utf8');
  const acpStore = readFileSync('apps/web/src/stores/acpAgents.ts', 'utf8');

  assert.match(butlerConv, /ButlerTerminalDrawer/);
  assert.match(butlerConv, /ButlerComposerFilePopover/);
  assert.match(butlerConv, /ButlerComposerSlashPopover/);
  assert.match(butlerConv, /planModePrefix/);
  assert.match(acpSurface, /setModel/);
  assert.match(acpSurface, /enqueuePrompt/);
  assert.match(acpStore, /setModel:/);
  assert.match(acpStore, /queuedPrompts/);
});
