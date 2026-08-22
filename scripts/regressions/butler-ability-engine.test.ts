import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BUTLER_ABILITY_TEMPLATES,
  findButlerAbilityTemplate,
} from '../../apps/web/src/lib/butlerAbilityTemplates';
import { MIN_INTERVAL_MINUTES } from '../../apps/web/src/stores/routines';

test('协作动作继续走 Skill，晨报和晚间回顾使用内置任务说明', () => {
  assert.deepEqual(
    BUTLER_ABILITY_TEMPLATES.map(({ id, skillName, precheck }) => ({ id, skillName, precheck })),
    [
      { id: 'mention-triage', skillName: 'butler-reply-guardian', precheck: 'new-mentions' },
      { id: 'room-digest', skillName: 'room-digest', precheck: 'room-activity' },
      { id: 'morning-brief', skillName: undefined, precheck: 'none' },
      { id: 'evening-review', skillName: undefined, precheck: 'none' },
    ],
  );
});

test('mention-triage 仍使用十五分钟下限，room-digest 仍要求 rooms 参数', () => {
  const mentions = findButlerAbilityTemplate('mention-triage');
  const digest = findButlerAbilityTemplate('room-digest');

  assert.equal(MIN_INTERVAL_MINUTES, 15);
  assert.deepEqual(mentions?.defaultTrigger, { kind: 'interval', everyMinutes: 15 });
  assert.equal(mentions?.category, 'watch');
  assert.equal(digest?.params, 'rooms');
  assert.deepEqual(digest?.defaultTrigger, { kind: 'daily', time: '21:00' });
});

test('调度仍由共同 App Server 侧的 routines scheduler 直接启动', () => {
  const runtime = readFileSync('apps/web/src/kernel/runtime.tsx', 'utf8');
  const routines = readFileSync('apps/web/src/stores/routines.ts', 'utf8');

  assert.match(runtime, /activeKernelHost\.background\.startRoutines\(\)/);
  assert.match(readFileSync('apps/web/src/lib/kernelHost.ts', 'utf8'), /background: \{ startRoutines: startRoutineScheduler \}/);
  assert.match(routines, /const ROUTINES_KEY = 'rcx-codex-automations-v1:routines';/);
  assert.doesNotMatch(routines, /rcx-butler-v1:routines/);
});
