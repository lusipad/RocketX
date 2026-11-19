import assert from 'node:assert/strict';
import test from 'node:test';
import { beginButlerAccountSelection } from '../../apps/web/src/platform/butlerAccountReady';
import { readWorkRuntimeEvents } from '../../apps/web/src/platform/workRuntimeEvents';

test('原生事件读取固定原账号和游标，切账号后不展示迟到结果', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: Array<{ command: string; args: any }> = [];
  let finish!: (value: unknown) => void;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: any) => {
      calls.push({ command, args });
      return new Promise((resolve) => { finish = resolve; });
    },
  } } });
  try {
    beginButlerAccountSelection('events-A').activate({ accountScope: 'events-A', generation: 1 });
    const pending = readWorkRuntimeEvents({ todoId: 'original-work', afterSequence: 17, limit: 50 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{ command: 'butler_work_runtime_events', args: { query: {
      account: { accountScope: 'events-A', generation: 1 }, todoId: 'original-work', afterSequence: 17, limit: 50,
    } } }]);
    beginButlerAccountSelection('events-B').activate({ accountScope: 'events-B', generation: 2 });
    finish({ events: [{ todoId: 'original-work' }], cursor: 18, hasMore: false });
    await assert.rejects(pending, /账号已切换/);
    for (const query of [{ afterSequence: -1 }, { afterSequence: 0, limit: 501 }, { afterSequence: 1.5 }]) {
      await assert.rejects(readWorkRuntimeEvents(query), /游标/);
    }
    assert.equal(calls.length, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
