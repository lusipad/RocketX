import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { messagesInMain } from '../../apps/web/src/components/MessageList';

function message(
  id: string,
  thread?: { tmid: string; tshow?: boolean },
): RcMessage {
  return {
    _id: id,
    rid: 'room-1',
    msg: id,
    ts: '2026-07-26T00:00:00.000Z',
    u: { _id: 'user-1', username: 'zhangsan' },
    ...thread,
  };
}

test('主消息流保留同时发送到频道的话题回复，并隐藏普通话题回复（issue #232）', () => {
  const visible = messagesInMain(
    [
      message('root'),
      message('shown-reply', { tmid: 'root', tshow: true }),
      message('thread-only-reply', { tmid: 'root' }),
    ],
    false,
  );

  assert.deepEqual(visible.map(({ _id }) => _id), ['root', 'shown-reply']);
});
