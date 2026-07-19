import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '@rcx/rc-client';
import {
  BUTLER_PROPOSAL_HANDLED_KEY,
  collectRecentSentMessages,
  isProposalHandled,
  listProposalHandledRefs,
  markProposalHandled,
  type ButlerOutboxMessageSource,
  type ButlerProposalHandledStorage,
} from '../../apps/web/src/lib/butlerOutbox';

class MemoryStorage implements ButlerProposalHandledStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const NOW = Date.parse('2026-07-19T12:00:00.000Z');

function message(
  id: string,
  text: string,
  at: number,
  overrides: Partial<RcMessage> = {},
): RcMessage {
  return {
    _id: id,
    rid: 'room-1',
    msg: text,
    ts: new Date(at).toISOString(),
    u: { _id: 'me', username: 'me', name: '我' },
    ...overrides,
  };
}

function source(messages: RcMessage[]): ButlerOutboxMessageSource {
  return {
    messages: { 'room-1': messages },
    subscriptions: {
      'room-1': { name: 'alice', fname: 'Alice', t: 'd' },
      'room-2': { name: '开发群', t: 'c' },
    },
    rooms: {},
  };
}

function collect(
  messages: RcMessage[],
  storage = new MemoryStorage(),
  lastRoundsAt: string | null = null,
) {
  return collectRecentSentMessages(lastRoundsAt, {
    getMessageSource: () => source(messages),
    getCurrentUserId: () => 'me',
    storage,
    now: () => NOW,
  });
}

test('出站扫描窗口取上轮时间与 24 小时前的较晚者，并按时间倒序', () => {
  const lastRoundsAt = new Date(NOW - 2 * 60 * 60 * 1_000).toISOString();
  const rows = collect([
    message('before-rounds', '上轮之前', NOW - 3 * 60 * 60 * 1_000),
    message('newer', '较新', NOW - 10 * 60 * 1_000),
    message('older', '较旧', NOW - 60 * 60 * 1_000),
    message('future', '未来消息', NOW + 1),
  ], new MemoryStorage(), lastRoundsAt);

  assert.deepEqual(rows.map((row) => row.ref), ['msg:newer', 'msg:older']);
  assert.equal(rows[0].roomName, 'Alice');
  assert.equal(rows[0].peer, 'Alice');
  assert.equal(rows[0].at, new Date(NOW - 10 * 60 * 1_000).toISOString());

  const fallbackRows = collect([
    message('inside-24h', '窗口内', NOW - 23 * 60 * 60 * 1_000),
    message('outside-24h', '窗口外', NOW - 25 * 60 * 60 * 1_000),
  ]);
  assert.deepEqual(fallbackRows.map((row) => row.ref), ['msg:inside-24h']);
});

test('出站扫描最多返回 50 条，并把正文截断到 280 字符', () => {
  const messages = Array.from({ length: 55 }, (_, index) => (
    message(`m-${index}`, index === 54 ? '长'.repeat(300) : `消息 ${index}`, NOW - index)
  ));
  const rows = collect(messages);

  assert.equal(rows.length, 50);
  assert.equal(rows[0].ref, 'msg:m-0');
  const long = collect([message('long', '长'.repeat(300), NOW - 1)])[0];
  assert.equal(long.text.length, 280);
});

test('出站扫描过滤非本人、系统消息、agent 卡片、斜杠命令与空文本', () => {
  const rows = collect([
    message('valid', '我明天把结论发你', NOW - 1),
    message('other', '别人发的', NOW - 2, { u: { _id: 'other', username: 'other' } }),
    message('system', '加入了房间', NOW - 3, { t: 'uj' }),
    message('agent', 'AI 会话\n<!--rocketx-agent:card-->', NOW - 4),
    message('slash', '   /remind me', NOW - 5),
    message('empty', '   ', NOW - 6),
  ]);

  assert.deepEqual(rows.map((row) => row.ref), ['msg:valid']);
  assert.equal(rows[0].text, '我明天把结论发你');
});

test('已处理消息在收集时剔除，handled 去重并最多保留 200 个最新 ref', () => {
  const storage = new MemoryStorage();
  assert.equal(markProposalHandled('msg:handled', storage), true);
  assert.equal(markProposalHandled('msg:handled', storage), true);
  assert.equal(markProposalHandled('todo:not-message', storage), false);
  assert.equal(isProposalHandled('msg:handled', storage), true);
  assert.deepEqual(collect([
    message('handled', '已经处理', NOW - 1),
    message('fresh', '还没处理', NOW - 2),
  ], storage).map((row) => row.ref), ['msg:fresh']);

  for (let index = 0; index < 201; index += 1) {
    markProposalHandled(`msg:${index}`, storage);
  }
  const handled = listProposalHandledRefs(storage);
  assert.equal(handled.length, 200);
  assert.equal(handled[0], 'msg:1');
  assert.equal(handled.at(-1), 'msg:200');
  assert.equal(JSON.parse(storage.getItem(BUTLER_PROPOSAL_HANDLED_KEY) ?? '[]').length, 200);
});
