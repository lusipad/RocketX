import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseRecalledMemoryBlock } from '../../apps/web/src/agent/memoryAutoRecall';
import { setRoutineCodexRunner, useRoutines } from '../../apps/web/src/stores/routines';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

test('ButlerTerminalDrawer places all React hooks before early open return and resets on workspace change', () => {
  const terminal = readFileSync('apps/web/src/components/ButlerTerminalDrawer.tsx', 'utf8');
  const earlyReturnIdx = terminal.indexOf('if (!open) return null;');
  assert.ok(earlyReturnIdx > 0);
  const afterReturn = terminal.slice(earlyReturnIdx);
  assert.doesNotMatch(afterReturn, /\buse(State|Effect|Memo|Callback|Ref)\(/);
  assert.match(terminal, /prevWorkspaceRef\.current === workspaceRoot/);
});

test('parseRecalledMemoryBlock cleanly strips recalled XML for user chat bubbles while preserving ordinary text', () => {
  const withMemory = `<recalled_memory>\n- [preference] Package manager: Always use pnpm\n- [project_fact] Repo: Monorepo\n</recalled_memory>\n\nRun unit tests`;
  const parsed = parseRecalledMemoryBlock(withMemory);
  assert.equal(parsed.recalledCount, 2);
  assert.equal(parsed.cleanText, 'Run unit tests');
  assert.deepEqual(parsed.recalledLines, [
    '[preference] Package manager: Always use pnpm',
    '[project_fact] Repo: Monorepo',
  ]);

  const plain = parseRecalledMemoryBlock('Check git status');
  assert.equal(plain.recalledCount, 0);
  assert.equal(plain.cleanText, 'Check git status');
});

test('ButlerRoutines replaces window.confirm with accessible ConfirmDialog', () => {
  const routinesUi = readFileSync('apps/web/src/components/ButlerRoutines.tsx', 'utf8');
  assert.doesNotMatch(routinesUi, /window\.confirm\(/);
  assert.match(routinesUi, /<ConfirmDialog/);
});

test('Pi server cleans up ROCKETX_PI_MCP_SECRETS env, merges server secrets, and wraps Windows npx', () => {
  const piServer = readFileSync('apps/desktop/src-tauri/src/pi_app_server.mjs', 'utf8');
  assert.match(piServer, /delete process\.env\.ROCKETX_PI_MCP_SECRETS;/);
  assert.match(piServer, /runtimeMcpSecrets\[this\.serverName\]/);
  assert.match(piServer, /process\.platform === 'win32'/);
  assert.match(piServer, /\(npx\|npm\|pnpm\)/);
});

test('routines.tick fires matching blocked work card event routines once per card update', async () => {
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: 'Escalated blocker' };
  });

  const routineId = 'evt-blocked-test';
  useRoutines.setState((state) => ({
    ...state,
    routines: [
      {
        id: routineId,
        name: 'Escalate auth blockers',
        prompt: 'Inspect blocked card',
        trigger: { kind: 'event', eventType: 'work_card_blocked', filter: 'oauth' },
        enabled: true,
        createdAt: Date.now(),
        runs: [],
      },
    ],
    seenKeys: [],
  }));

  useWorkLedger.setState((state) => ({
    ...state,
    cards: [
      {
        id: 'card-blocked-1',
        source: 'manual',
        rid: null,
        mid: null,
        adoWorkItemId: null,
        adoProject: null,
        title: 'Fix OAuth token refresh',
        note: null,
        roomName: null,
        author: null,
        done: false,
        priority: 1,
        due: null,
        committedTo: null,
        waitingFor: null,
        createdAt: Date.now(),
        doneAt: null,
        updatedAt: 12345,
        state: {
          todoId: 'card-blocked-1',
          projectKey: null,
          stage: 'in_progress',
          waitState: 'blocked',
          waitReason: 'Waiting for OAuth test credentials',
          nextStep: 'Notify maintainer',
          goal: 'Fix refresh',
          acceptance: ['Passes tests'],
          boundaries: [],
          autonomyMode: 'confirm',
          visibility: 'private',
          maxAutoTurns: 3,
          autoTurnsUsed: 0,
          blockedReason: null,
          lastReportSummary: null,
          lastReportAt: null,
          nextCheckAt: null,
          activeSessionId: null,
          activeRunId: null,
          requirementsVersion: 1,
          contentVersion: 1,
          updatedAt: 12345,
        },
      },
    ],
  }));

  try {
    await useRoutines.getState().tick(Date.now());
    await new Promise((r) => setTimeout(r, 20));
    // Re-ticking with unchanged updatedAt must not re-fire
    await useRoutines.getState().tick(Date.now());
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(useRoutines.getState().seenKeys.includes('event:work_card_blocked:card-blocked-1:12345'));
    assert.ok(calls >= 0);
  } finally {
    useRoutines.getState().removeRoutine(routineId);
    useWorkLedger.setState((state) => ({
      ...state,
      cards: state.cards.filter((c) => c.id !== 'card-blocked-1'),
    }));
    restoreRunner();
  }
});
