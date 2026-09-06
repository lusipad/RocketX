import test from 'node:test';
import assert from 'node:assert/strict';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  aggregateBoard,
  cardTitleFromMessage,
  findBoardRoot,
  kanbanEventFromMessage,
  kanbanEventText,
} from '../../apps/web/src/lib/kanban';
import {
  aggregateOncall,
  findOncallRoot,
  oncallEventFromMessage,
  oncallSummaryText,
} from '../../apps/web/src/lib/oncall';

function msg(overrides: Partial<RcMessage>): RcMessage {
  return {
    _id: 'm',
    rid: 'r1',
    msg: '',
    ts: '2026-01-01T00:00:00.000Z',
    u: { _id: 'u1', username: 'admin' },
    ...overrides,
  } as RcMessage;
}

// ---------------------------------------------------------------------------
// 看板：根消息 + 事件重放
// ---------------------------------------------------------------------------

test('看板：识别根消息，重放建卡/移动/删除事件', () => {
  const root = msg({
    _id: 'root',
    msg: '📋 已创建消息看板',
    attachments: [{ type: 'rcx-kanban-board', text: '消息看板' } as never],
  });
  assert.equal(findBoardRoot([root])._id, 'root');
  assert.equal(findBoardRoot([]), null);

  const events = [
    msg({
      _id: 'card-a',
      tmid: 'root',
      ts: '2026-01-01T00:00:01.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📋 新建看板卡片「写周报」',
      attachments: [
        { type: 'rcx-kanban', text: '', ev: { op: 'create', cardId: 'card-a', title: '写周报', column: 'todo' } } as never,
      ],
    }),
    msg({
      _id: 'card-b',
      tmid: 'root',
      ts: '2026-01-01T00:00:02.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📋 新建看板卡片「修 bug」',
      attachments: [
        { type: 'rcx-kanban', text: '', ev: { op: 'create', cardId: 'card-b', title: '修 bug', column: 'doing', sourceMid: 'm99' } } as never,
      ],
    }),
    msg({
      _id: 'move-1',
      tmid: 'root',
      ts: '2026-01-01T00:00:03.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📋 把卡片「写周报」移到 进行中',
      attachments: [
        { type: 'rcx-kanban', text: '', ev: { op: 'move', cardId: 'card-a', column: 'done' } } as never,
      ],
    }),
    msg({
      _id: 'rm-1',
      tmid: 'root',
      ts: '2026-01-01T00:00:04.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📋 删除看板卡片「修 bug」',
      attachments: [{ type: 'rcx-kanban', text: '', ev: { op: 'remove', cardId: 'card-b' } } as never],
    }),
  ];

  const cards = aggregateBoard([...events, root]);
  assert.equal(cards.length, 1);
  assert.deepEqual(
    { id: cards[0].id, column: cards[0].column, title: cards[0].title },
    { id: 'card-a', column: 'done', title: '写周报' },
  );

  // 普通消息不是事件
  assert.equal(kanbanEventFromMessage(msg({ _id: 'x', tmid: 'root', msg: 'hello' })), null);
  // 事件正文是人话，官方客户端可读
  assert.match(kanbanEventText({ op: 'move', title: '写周报', column: 'done' }), /移到 已完成/);
});

test('看板：残缺事件被忽略，消息收纳标题有截断', () => {
  const bad = msg({
    _id: 'bad',
    tmid: 'root',
    attachments: [{ type: 'rcx-kanban', text: '', ev: { op: 'create' } } as never],
  });
  assert.equal(kanbanEventFromMessage(bad), null);
  const long = cardTitleFromMessage(msg({ _id: 'long', msg: `前缀：${'啊'.repeat(100)}` }));
  assert.ok(long.length <= 81);
  assert.ok(long.endsWith('…'));
});

// ---------------------------------------------------------------------------
// 值班表：同一套事件流
// ---------------------------------------------------------------------------

test('值班表：重放排班增删，按日期排序，快照文本可读', () => {
  const root = msg({
    _id: 'oroot',
    msg: '📅 已创建团队值班表',
    attachments: [{ type: 'rcx-oncall-board', text: '团队值班表' } as never],
  });
  assert.equal(findOncallRoot([root])._id, 'oroot');

  const events = [
    msg({
      _id: 'os-2',
      tmid: 'oroot',
      ts: '2026-01-01T00:00:02.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📅 排班：2026-01-05 早班 → @zhangsan',
      attachments: [
        { type: 'rcx-oncall', text: '', ev: { op: 'add', shiftId: 'os-2', date: '2026-01-05', shift: '早班', username: 'zhangsan' } } as never,
      ],
    }),
    msg({
      _id: 'os-1',
      tmid: 'oroot',
      ts: '2026-01-01T00:00:03.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📅 排班：2026-01-03 全天 → @admin',
      attachments: [
        { type: 'rcx-oncall', text: '', ev: { op: 'add', shiftId: 'os-1', date: '2026-01-03', shift: '全天', username: 'admin' } } as never,
      ],
    }),
    msg({
      _id: 'orm-1',
      tmid: 'oroot',
      ts: '2026-01-01T00:00:04.000Z',
      u: { _id: 'u1', username: 'admin' },
      msg: '📅 取消一条排班',
      attachments: [{ type: 'rcx-oncall', text: '', ev: { op: 'remove', shiftId: 'os-2' } } as never],
    }),
  ];

  const shifts = aggregateOncall([...events, root]);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].id, 'os-1');
  assert.equal(shifts[0].username, 'admin');
  assert.match(oncallSummaryText(shifts), /📅 团队值班表[\s\S]*2026-01-03 · 全天 · @admin/);

  // 残缺事件忽略（日期格式非法）
  const bad = msg({
    _id: 'bad',
    tmid: 'oroot',
    attachments: [
      { type: 'rcx-oncall', text: '', ev: { op: 'add', shiftId: 'x', date: '明天', shift: '全天', username: 'a' } } as never,
    ],
  });
  assert.equal(oncallEventFromMessage(bad), null);
});
