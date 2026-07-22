import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '@rcx/rc-client';
import { agentMessageBridgeChanges } from '../../apps/web/src/agent/messageBridge';

function message(id: string, msg: string, pending = false): RcMessage {
  return {
    _id: id,
    rid: 'room-1',
    msg,
    ts: '2026-07-22T00:00:00.000Z',
    u: { _id: 'member', username: 'member' },
    pending,
  };
}

test('首次打开房间只摄取历史状态卡，不重新执行旧 Agent 指令（issue #158）', () => {
  const history = [
    message('lease', '<!-- rcx-agent-session:v1:{} -->'),
    message('old-command', '@ai 帮我处理'),
  ];
  const changes = agentMessageBridgeChanges(history, [], true);

  assert.deepEqual(changes.ingestOnly, history);
  assert.deepEqual(changes.handle, []);
});

test('实时新增、编辑和发送确认仍进入 Agent 指令处理', () => {
  const original = message('command', '@ai 第一版', true);
  const edited = message('command', '@ai 第二版');
  assert.deepEqual(
    agentMessageBridgeChanges([original, message('new', '@ai 新消息')], [original], false).handle.map((item) => item._id),
    ['new'],
  );
  assert.deepEqual(
    agentMessageBridgeChanges([edited], [original], false).handle.map((item) => item._id),
    ['command'],
  );
});
