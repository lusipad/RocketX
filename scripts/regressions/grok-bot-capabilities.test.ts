import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSpecialistPlan,
  capDelegationAutonomy,
  parseDelegationEvent,
  synthesizeDelegationSummary,
} from '../../apps/web/src/agent/chiefOfStaff';
import {
  extractMemoryCandidates,
  formatRecalledMemoriesBlock,
} from '../../apps/web/src/agent/memoryAutoRecall';
import { rankSlashCommands } from '../../apps/web/src/lib/composerCommands';
import { t } from '../../apps/web/src/i18n';
import { useButlerMemory, type ButlerMemoryEntry } from '../../apps/web/src/stores/butlerMemory';
import {
  buildSkillExecutionPrompt,
  parseSkillMarkdownDraft,
  serializeSkillToMarkdown,
  STARTER_SKILL_TEMPLATES,
  useButlerSkills,
} from '../../apps/web/src/stores/butlerSkills';
import {
  dueRoutines,
  evaluateNotificationPolicy,
  isWithinQuietHours,
  useRoutines,
} from '../../apps/web/src/stores/routines';

test('Skills Studio store supports starter templates, markdown roundtrip, secret guard, and slash ranking', async () => {
  const store = useButlerSkills.getState();
  const tpl = STARTER_SKILL_TEMPLATES[0];
  const installed = await store.seedStarterTemplate(tpl.id, t, 'd:/Repos/rocketchatx');
  assert.equal(installed.slug, 'pr-review');

  const md = await store.exportMarkdown(installed.id);
  assert.match(md, /slug:\s*"pr-review"/);
  const parsed = parseSkillMarkdownDraft(serializeSkillToMarkdown(installed));
  assert.equal(parsed.name, installed.name);
  assert.equal(parsed.approvalPolicy, 'confirm_write');

  await assert.rejects(
    () => store.upsertSkill({
      name: 'Unsafe Skill',
      instructionsMd: 'Use token sk-abcdefghijklmnopqrstuvwxyz123456',
    }),
    /secret|密钥|凭据/iu,
  );

  const ranked = rankSlashCommands('pr-', t, [
    {
      id: installed.id,
      slug: installed.slug,
      name: installed.name,
      description: installed.description,
      promptTemplate: buildSkillExecutionPrompt(installed),
    },
  ]);
  assert.ok(ranked.some((opt) => opt.kind === 'skill' && opt.command === 'pr-review'));
  await store.deleteSkill(installed.id);
});

test('Chief-of-Staff delegation enforces autonomy ceiling, plans fan-out, and parses Delegation Tree events', () => {
  assert.equal(capDelegationAutonomy('autonomous', 'confirm'), 'confirm');
  assert.equal(capDelegationAutonomy('readonly', 'autonomous'), 'readonly');

  const plan = buildSpecialistPlan({
    tasks: [
      { role: 'researcher', title: 'Audit storage', prompt: 'Inspect keyring usage', autonomyMode: 'autonomous' },
      { role: 'coder', title: 'Implement fix', prompt: 'Patch keyring call', isolateWorktree: true },
    ],
    parentCeiling: 'confirm',
    defaultWorkspaceRoot: 'd:/Repos/rocketchatx',
    availableAgents: [
      { id: 'claude-1', name: 'Claude Code', preset: 'claude', enabled: true },
      { id: 'codex-1', name: 'Codex CLI', preset: 'codex', enabled: true },
    ],
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].autonomyMode, 'confirm');
  assert.equal(plan[1].isolateWorktree, true);

  const summary = synthesizeDelegationSummary([
    { role: 'researcher', title: 'Audit storage', status: 'completed', summary: 'Found fallback' },
    { role: 'coder', title: 'Implement fix', status: 'awaiting_approval', agentName: 'Codex CLI', autonomyMode: 'confirm' },
  ]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.awaitingApproval, 1);

  const parsedEvent = parseDelegationEvent({
    id: 'evt-1',
    type: 'dynamicToolCall',
    title: 'delegate_specialists',
    status: 'completed',
    detail: JSON.stringify([
      {
        type: 'inputText',
        text: JSON.stringify({
          delegationId: 'req-1',
          todoId: 'todo-1',
          dispatches: [
            { index: 0, role: 'researcher', title: 'Audit storage', agentName: 'Claude Code', state: 'queued', isolateWorktree: false },
          ],
        }),
      },
    ]),
  });
  assert.ok(parsedEvent);
  assert.equal(parsedEvent?.nodes.length, 1);
  assert.equal(parsedEvent?.nodes[0].role, 'researcher');
});

test('Event routines, notificationPolicy enforcement, quiet hours, and dryRun work accurately', () => {
  const quiet = { start: '22:00', end: '08:00' };
  assert.equal(isWithinQuietHours(quiet, new Date('2026-01-01T23:30:00')), true);
  assert.equal(isWithinQuietHours(quiet, new Date('2026-01-01T14:00:00')), false);

  assert.equal(
    evaluateNotificationPolicy({ notificationPolicy: 'silent' }, { status: 'error', text: 'boom' }).shouldNotifyDesktop,
    false,
  );
  assert.equal(
    evaluateNotificationPolicy({ notificationPolicy: 'digest_only' }, { status: 'ok', text: 'hi' }).shouldDigest,
    true,
  );
  assert.equal(
    evaluateNotificationPolicy({ notificationPolicy: 'failed_runs_only' }, { status: 'ok', text: 'all green' }).shouldNotifyDesktop,
    false,
  );
  assert.equal(
    evaluateNotificationPolicy({ notificationPolicy: 'important_updates' }, { status: 'ok', text: 'PR blocked on CI' }).shouldNotifyDesktop,
    true,
  );
  assert.equal(
    evaluateNotificationPolicy(
      { notificationPolicy: 'all_runs', quietHours: quiet, notifyRoomId: 'GENERAL' },
      { status: 'ok', text: 'done' },
      new Date('2026-01-01T23:15:00'),
    ).requiresRoomConfirmation,
    true,
  );

  const store = useRoutines.getState();
  const id = 'evt-routine-test';
  store.addRoutine({
    id,
    name: 'Watch blocked cards',
    prompt: 'Summarize blockers on board',
    trigger: { kind: 'event', eventType: 'work_card_blocked', filter: 'auth' },
    enabled: true,
    createdAt: Date.now(),
    runs: [],
  });
  // Event routines must never be scheduled by cron dueRoutines
  assert.equal(dueRoutines(useRoutines.getState().routines, Date.now()).some((r) => r.id === id), false);
  const dryRun = useRoutines.getState().dryRunRoutine(id);
  assert.equal(dryRun.found, true);
  assert.equal(dryRun.triggerKind, 'event');
  store.removeRoutine(id);
});

test('Memory Auto-Recall formats active entries and filters secrets from extracted candidates', () => {
  const now = Date.now();
  const sample: ButlerMemoryEntry[] = [
    {
      id: 'm1',
      accountScope: 'local',
      category: 'preference',
      title: 'Package manager',
      content: 'Always use pnpm rather than npm in this repository.',
      tags: ['tooling'],
      workspaceRoot: null,
      sourceKind: 'manual',
      sourceRef: null,
      pinned: true,
      confidence: 1,
      enabled: true,
      recallCount: 2,
      lastRecalledAt: now,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      expiresAt: null,
    },
    {
      id: 'm2',
      accountScope: 'local',
      category: 'preference',
      title: 'Expired',
      content: 'Should not appear',
      tags: [],
      workspaceRoot: null,
      sourceKind: 'manual',
      sourceRef: null,
      pinned: false,
      confidence: 1,
      enabled: true,
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      expiresAt: 1,
    },
  ];
  const block = formatRecalledMemoriesBlock(sample);
  assert.match(block, /<recalled_memory>/);
  assert.match(block, /Always use pnpm/);
  assert.doesNotMatch(block, /Should not appear/);

  const candidates = extractMemoryCandidates(
    'Please remember we prefer Vitest over Jest, and always use pnpm test.',
    '',
    sample,
  );
  assert.ok(candidates.length >= 1);

  const secretCandidates = extractMemoryCandidates(
    'Always use sk-abcdefghijklmnopqrstuvwxyz123456 for tests',
    '',
    sample,
  );
  assert.equal(secretCandidates.length, 0);

  // Ensure paused memory returns empty recall block cleanly
  useButlerMemory.setState({ memoryPaused: true });
  assert.equal(useButlerMemory.getState().memoryPaused, true);
  useButlerMemory.setState({ memoryPaused: false });
});
