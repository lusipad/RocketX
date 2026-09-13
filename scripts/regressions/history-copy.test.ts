import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  COPY_ALL_CAP,
  COPY_LIMITS,
  isCopyableMessage,
  limitForKey,
  selectRecent,
} from '../../apps/web/src/lib/historyCopy';
import { rest } from '../../apps/web/src/lib/client';
import { useChat } from '../../apps/web/src/stores/chat';

function message(id: string, text: string, ts: string, extra: Partial<RcMessage> = {}): RcMessage {
  return {
    _id: id,
    rid: 'source-room',
    msg: text,
    ts,
    u: { _id: 'u1', username: 'alice' },
    ...extra,
  } as RcMessage;
}

const originalGetHistory = rest.getHistory;
const originalSendMessageRaw = rest.sendMessageRaw;

test.afterEach(() => {
  rest.getHistory = originalGetHistory;
  rest.sendMessageRaw = originalSendMessageRaw;
});

test('复制档位：30 / 100 / 全部，且「全部」有硬上限', () => {
  assert.deepEqual(
    COPY_LIMITS.map((item) => item.value),
    [30, 100, 0],
  );
  assert.equal(limitForKey('recent'), 30);
  assert.equal(limitForKey('medium'), 100);
  assert.equal(limitForKey('all'), 0);
  assert.ok(COPY_ALL_CAP > 0 && COPY_ALL_CAP <= 5000, '「全部」必须有界');
});

test('selectRecent 取最近 N 条并按时间正序（复制顺序与原会话一致）', () => {
  const history = [
    message('m1', '第一条', '2026-01-01T00:00:01.000Z'),
    message('m2', '第二条', '2026-01-01T00:00:02.000Z'),
    message('m3', '第三条', '2026-01-01T00:00:03.000Z'),
    message('m4', '第四条', '2026-01-01T00:00:04.000Z'),
  ];
  assert.deepEqual(selectRecent(history, 2).map((m) => m._id), ['m3', 'm4']);
  assert.deepEqual(selectRecent(history, 30).map((m) => m._id), ['m1', 'm2', 'm3', 'm4']);
  // 乱序输入也要按时间排好
  const shuffled = [history[2], history[0], history[3], history[1]];
  assert.deepEqual(selectRecent(shuffled, 0).map((m) => m._id), ['m1', 'm2', 'm3', 'm4']);
});

test('系统消息 / 空消息不进复制队列', () => {
  assert.equal(isCopyableMessage(message('m1', '正常消息', '2026-01-01T00:00:01.000Z')), true);
  assert.equal(
    isCopyableMessage(message('m2', '加入了频道', '2026-01-01T00:00:02.000Z', { t: 'uj' })),
    false,
    '系统消息（t 有值）不复制',
  );
  assert.equal(isCopyableMessage(message('m3', '   ', '2026-01-01T00:00:03.000Z')), false);
  assert.equal(
    isCopyableMessage({
      ...message('m4', '', '2026-01-01T00:00:04.000Z'),
      u: undefined,
    } as RcMessage),
    false,
    '没有发送人的不复制',
  );
  assert.equal(
    isCopyableMessage(
      message('m5', '', '2026-01-01T00:00:05.000Z', { attachments: [{ title: '图片' }] as never }),
    ),
    true,
    '只有附件的消息也要复制',
  );
});

test('复制是转发不是搬移：逐条发送、带引用链接、不动原会话', async () => {
  const sent: Array<{ rid: string; msg: string }> = [];
  const history = [
    message('m1', '第一条', '2026-01-01T00:00:01.000Z'),
    message('m2', '第二条', '2026-01-01T00:00:02.000Z'),
    message('m3', '第三条', '2026-01-01T00:00:03.000Z'),
  ];
  rest.getHistory = (async () => history) as typeof rest.getHistory;
  rest.sendMessageRaw = (async (payload: { rid: string; msg: string }) => {
    sent.push({ rid: payload.rid, msg: payload.msg });
    return { _id: `copy-${sent.length}` } as never;
  }) as typeof rest.sendMessageRaw;
  useChat.setState({ subscriptions: {} });

  const result = await useChat.getState().copyHistoryToRoom('source-room', 'target-room', 2);

  assert.equal(result.copied, 2, '只复制最近 2 条');
  assert.equal(result.skipped, 0);
  assert.deepEqual(
    sent.map((item) => item.rid),
    ['target-room', 'target-room'],
    '全部发到目标会话',
  );
  assert.match(sent[0].msg, /^\[ \]\(.*\) 第二条$/, '带引用链接 + 正文（引用块显示原作者）');
  assert.match(sent[1].msg, /第三条$/);
});

test('来源与目标相同不做任何事；单条失败不中断整批', async () => {
  const sent: string[] = [];
  rest.getHistory = (async () =>
    [
      message('m1', '第一条', '2026-01-01T00:00:01.000Z'),
      message('m2', '第二条', '2026-01-01T00:00:02.000Z'),
    ]) as typeof rest.getHistory;
  rest.sendMessageRaw = (async (payload: { msg: string }) => {
    sent.push(payload.msg);
    if (sent.length === 1) throw new Error('网络抖动');
    return { _id: 'ok' } as never;
  }) as typeof rest.sendMessageRaw;

  assert.deepEqual(await useChat.getState().copyHistoryToRoom('same', 'same', 30), {
    copied: 0,
    skipped: 0,
  });
  assert.equal(sent.length, 0, '同一个会话直接返回');

  const result = await useChat.getState().copyHistoryToRoom('source-room', 'target-room', 30);
  assert.equal(result.copied, 1, '第一条失败后继续复制第二条');
  assert.equal(result.skipped, 1);
});

test('入口：加人后的提示带「带过来」，群信息面板有复制记录', async () => {
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );
  const roomInfo = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );
  const app = await readFile(new URL('../../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const dialog = await readFile(
    new URL('../../apps/web/src/components/CopyHistoryDialog.tsx', import.meta.url),
    'utf8',
  );

  // 加人（DM）后给一个把历史带过来的入口，而不是只提示「记录还在」
  assert.match(chatStore, /openHistoryCopy\(\{ sourceRid: rid, targetRid \}\)/);
  assert.match(chatStore, /action: \{ label: '带过来'/);
  assert.match(roomInfo, /复制聊天记录到其他会话/);
  assert.match(roomInfo, /openHistoryCopy\(\{ sourceRid: rid \}\)/);
  // 弹窗挂到应用根部，任何触发点都能唤起
  assert.match(app, /<HistoryCopyDialogHost \/>/);
  // 三档都在，且说明「复制不是搬移」
  assert.match(dialog, /COPY_LIMITS\.map/);
  assert.match(dialog, /这是转发副本/);
});
