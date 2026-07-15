import assert from 'node:assert/strict';
import test from 'node:test';
import { applyScopedResult, settleScopedResult } from '../../apps/web/src/lib/scopedResult';

test('旧房间的慢结果不会覆盖当前房间结果', async () => {
  let activeRid: string | null = 'room-a';
  let releaseA!: (members: string[]) => void;
  const applied: string[][] = [];

  const roomA = applyScopedResult(
    () => new Promise<string[]>((resolve) => (releaseA = resolve)),
    (members) => applied.push(members),
    () => activeRid === 'room-a',
  );

  activeRid = 'room-b';
  await applyScopedResult(
    async () => ['member-b'],
    (members) => applied.push(members),
    () => activeRid === 'room-b',
  );
  releaseA(['member-a']);
  await roomA;

  assert.deepEqual(applied, [['member-b']]);
});

test('返回结果不受作用域变化影响，只有本地回写会被阻止', async () => {
  const applied: string[][] = [];
  const result = await applyScopedResult(
    async () => ['member-a'],
    (members) => applied.push(members),
    () => false,
  );

  assert.deepEqual(result, ['member-a']);
  assert.deepEqual(applied, []);
});

test('旧查询的失败和完成回调不会清空新查询状态', async () => {
  let activeQuery = 'old';
  let rejectOld!: (error: Error) => void;
  const events: string[] = [];

  const oldRequest = settleScopedResult(
    () => new Promise<string>((_resolve, reject) => (rejectOld = reject)),
    {
      success: (value) => events.push(`success:${value}`),
      error: () => events.push('error:old'),
      complete: () => events.push('complete:old'),
    },
    () => activeQuery === 'old',
  );

  activeQuery = 'new';
  await settleScopedResult(
    async () => 'new-result',
    {
      success: (value) => events.push(`success:${value}`),
      error: () => events.push('error:new'),
      complete: () => events.push('complete:new'),
    },
    () => activeQuery === 'new',
  );
  rejectOld(new Error('old failed'));
  await oldRequest;

  assert.deepEqual(events, ['success:new-result', 'complete:new']);
});
