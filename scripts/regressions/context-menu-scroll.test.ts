import assert from 'node:assert/strict';
import test from 'node:test';
import { listenUserDismiss } from '../../apps/web/src/components/ContextMenu';

type Handler = (event: { type: string; key?: string }) => void;

/** 最小 document 替身：记录监听、可手动派发，验证「关菜单」监听的事件选择 */
function fakeTarget() {
  const listeners = new Map<string, Handler[]>();
  return {
    addEventListener(type: string, handler: Handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener(type: string, handler: Handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter((h) => h !== handler));
    },
    dispatch(type: string, event: { key?: string } = {}) {
      for (const handler of listeners.get(type) ?? []) handler({ type, ...event });
    },
    registeredTypes() {
      return [...listeners.entries()].filter(([, list]) => list.length > 0).map(([type]) => type).sort();
    },
  } as unknown as Document & {
    dispatch: (type: string, event?: { key?: string }) => void;
    registeredTypes: () => string[];
  };
}

test('程序化 scroll（presence/未读刷新引发的列表自滚）不关闭菜单', () => {
  const target = fakeTarget();
  let closed = 0;
  const cleanup = listenUserDismiss(target, () => {
    closed += 1;
  });
  // scrollIntoView / scrollTop 赋值产生的真实 scroll 事件，以及合成 scroll 事件，都不应关菜单
  target.dispatch('scroll');
  assert.equal(closed, 0);
  cleanup();
});

test('用户主动滚动（滚轮 / 触摸滑动）仍关闭菜单', () => {
  const target = fakeTarget();
  let closed = 0;
  const cleanup = listenUserDismiss(target, () => {
    closed += 1;
  });
  target.dispatch('wheel');
  assert.equal(closed, 1);
  target.dispatch('touchmove');
  assert.equal(closed, 2);
  cleanup();
});

test('点击菜单外与 Esc 的关闭语义不变，cleanup 后不再响应', () => {
  const target = fakeTarget();
  let closed = 0;
  const cleanup = listenUserDismiss(target, () => {
    closed += 1;
  });
  target.dispatch('mousedown');
  target.dispatch('keydown', { key: 'Escape' });
  target.dispatch('keydown', { key: 'Enter' });
  assert.equal(closed, 2);
  cleanup();
  assert.deepEqual(target.registeredTypes(), []);
  target.dispatch('wheel');
  assert.equal(closed, 2);
});
