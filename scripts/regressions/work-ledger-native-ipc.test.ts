import assert from 'node:assert/strict';
import test from 'node:test';

test('工作卡更新使用原生命令的 id 参数并保留版本CAS', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      assert.equal(args.id, 'original-work');
      assert.equal(Object.hasOwn(args, 'todoId'), false);
      return { id: args.id, state: args.patch };
    },
  } } });
  try {
    const { updateNativeWorkCard } = await import('../../apps/web/src/platform/desktopCommands');
    const patch = { goal: '当前目标', expectedRequirementsVersion: 2, expectedContentVersion: 3 };
    const result = await updateNativeWorkCard('original-work', patch);
    assert.equal(result.id, 'original-work');
    assert.deepEqual(calls, [{ command: 'butler_work_card_update', args: { id: 'original-work', patch } }]);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
