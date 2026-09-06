import assert from 'node:assert/strict';
import test from 'node:test';
import { diffChatMessages } from '../../apps/web/src/kernel/chatEvents';
import type { KernelChatEventState } from '../../apps/web/src/kernel/host';
import type { RcMessage } from '../../packages/rc-client/src/index';

const message = (id: string, msg = `m-${id}`): RcMessage =>
  ({ _id: id, rid: 'r1', msg, ts: 1, u: { _id: 'u1', username: 'admin' } }) as RcMessage;

const state = (messages: RcMessage[], rid: string | null = 'r1'): KernelChatEventState => ({
  activeRid: rid,
  messages: rid ? { [rid]: messages } : {},
});

test('新消息触发 received，未变化的消息不算 updated', () => {
  // store 的契约是「未变化的消息保持引用」，这里必须共享对象
  const a = message('a');
  const b = message('b');
  const c = message('c');
  const diff = diffChatMessages(state([a, b, c]), state([a, b]));
  assert.equal(diff.received?._id, 'c');
  assert.deepEqual(diff.updated, []);
});

test('回应/编辑（同 id 引用替换）触发 updated，received 不发', () => {
  const a = message('a');
  const before = state([a, message('b')]);
  const reacted = {
    ...message('b'),
    reactions: { ':one:': { usernames: ['admin'] } },
  } as RcMessage;
  const diff = diffChatMessages(state([a, reacted]), before);
  assert.equal(diff.received, undefined);
  assert.deepEqual(diff.updated.map((m) => m._id), ['b']);
  assert.ok(diff.updated[0].reactions, '更新事件必须带最新 reactions');
});

test('会话切换或数组未变时不产生消息事件', () => {
  const list = [message('a')];
  assert.deepEqual(diffChatMessages(state(list), state(list)), { updated: [] });
  // 切换会话后第一次看到的是历史加载，不是新消息（room.changed 已单独通知）
  assert.deepEqual(diffChatMessages(state([message('a')], 'r2'), state([message('a')], 'r1')), {
    updated: [],
  });
  assert.deepEqual(diffChatMessages(state([]), state([], null)), { updated: [] });
});

test('一次批量替换多条消息时 updated 有上限保护', () => {
  const before = state(Array.from({ length: 60 }, (_, i) => message(`m${i}`)));
  const after = state(
    before.messages['r1']!.map((m) => ({ ...m, editedAt: 1 }) as RcMessage),
  );
  const diff = diffChatMessages(after, before);
  assert.equal(diff.received, undefined);
  assert.equal(diff.updated.length, 20);
});
