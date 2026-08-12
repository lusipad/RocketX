import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  nextMessageScrollState,
  shouldShowUnreadDivider,
} from '../../apps/web/src/components/MessageList';
import {
  messageScrollCommand,
  messageScrollTransactionMatches,
  nextMessageScrollTransaction,
} from '../../apps/web/src/lib/messageScrollTransaction';

test('每次打开都会创建新的滚动事务，同一房间也不复用 generation', () => {
  const first = nextMessageScrollTransaction(0, 'room-a', 'latest');
  const repeated = nextMessageScrollTransaction(first.generation, 'room-a', 'latest');
  const located = nextMessageScrollTransaction(repeated.generation, 'room-b', 'locate', 'message-1');

  assert.equal(first.generation, 1);
  assert.equal(repeated.generation, 2);
  assert.deepEqual(located, {
    generation: 3,
    rid: 'room-b',
    entry: 'locate',
    messageId: 'message-1',
  });
});

test('旧 generation 与旧房间都不能推进当前滚动事务', () => {
  const current = nextMessageScrollTransaction(7, 'room-c', 'latest');

  assert.equal(messageScrollTransactionMatches(current, 8, 'room-c'), true);
  assert.equal(messageScrollTransactionMatches(current, 7, 'room-c'), false);
  assert.equal(messageScrollTransactionMatches(current, 8, 'room-b'), false);
  const located = nextMessageScrollTransaction(8, 'room-c', 'locate', 'message-2');
  assert.equal(messageScrollTransactionMatches(
    located,
    located.generation,
    'room-c',
    'locate',
    'message-2',
  ), true);
  assert.equal(messageScrollTransactionMatches(
    located,
    located.generation,
    'room-c',
    'locate',
    'message-1',
  ), false);
});

test('滚动命令优先级固定为翻页锚点、消息定位、普通贴底、后续跟随', () => {
  assert.equal(messageScrollCommand({
    anchorSettled: true,
    entry: 'latest',
    openPending: true,
    stickToBottom: true,
  }), 'anchor');
  assert.equal(messageScrollCommand({
    anchorSettled: false,
    entry: 'locate',
    openPending: true,
    stickToBottom: true,
  }), 'locate');
  assert.equal(messageScrollCommand({
    anchorSettled: false,
    entry: 'latest',
    openPending: true,
    stickToBottom: false,
  }), 'latest');
  assert.equal(messageScrollCommand({
    anchorSettled: false,
    entry: 'latest',
    openPending: false,
    stickToBottom: true,
  }), 'follow');
  assert.equal(messageScrollCommand({
    anchorSettled: false,
    entry: 'latest',
    openPending: false,
    stickToBottom: false,
  }), 'none');
});

test('内容撑高但滚动位置未动时保持贴底', () => {
  assert.deepEqual(
    nextMessageScrollState({
      stickToBottom: true,
      userInitiated: false,
      scrollHeight: 1300,
      scrollTop: 400,
      clientHeight: 600,
    }),
    { nearBottom: false, stickToBottom: true },
  );
});

test('浏览器滚动锚定同时改变高度和位置时仍保持用户的贴底意图', () => {
  assert.deepEqual(
    nextMessageScrollState({
      stickToBottom: true,
      userInitiated: false,
      scrollHeight: 1300,
      scrollTop: 520,
      clientHeight: 600,
    }),
    { nearBottom: false, stickToBottom: true },
  );
});

test('滚动位置变化时按当前位置判定贴底', () => {
  assert.deepEqual(
    nextMessageScrollState({
      stickToBottom: true,
      userInitiated: true,
      scrollHeight: 1300,
      scrollTop: 500,
      clientHeight: 600,
    }),
    { nearBottom: false, stickToBottom: false },
  );
  assert.deepEqual(
    nextMessageScrollState({
      stickToBottom: false,
      userInitiated: true,
      scrollHeight: 1000,
      scrollTop: 400,
      clientHeight: 600,
    }),
    { nearBottom: true, stickToBottom: true },
  );
});

test('已经离开底部时内容撑高不会恢复贴底', () => {
  assert.deepEqual(
    nextMessageScrollState({
      stickToBottom: false,
      userInitiated: false,
      scrollHeight: 1300,
      scrollTop: 200,
      clientHeight: 600,
    }),
    { nearBottom: false, stickToBottom: false },
  );
});

test('普通打开会做有界帧复核，并同时观察内容与视口尺寸', () => {
  const source = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');
  const verification = source.slice(
    source.indexOf('const scheduleBottomVerification'),
    source.indexOf('const scrollToBottom'),
  );
  assert.match(source, /const OPEN_SETTLE_FRAME_LIMIT = 4/);
  assert.match(verification, /if \(!transactionIsCurrent\(\) \|\| openPhase\.current === 'cancelled'\) return/);
  assert.match(verification, /settleScrollFrame\.current = requestAnimationFrame/);
  assert.match(verification, /if \(gap > 2\)[\s\S]*if \(remaining > 1\) \{\s*verify\(remaining - 1\);/);
  assert.doesNotMatch(verification, /if \(gap <= 2\)[\s\S]*?return;/);
  assert.match(source, /ro\.observe\(el\)/);
  assert.match(source, /ro\.observe\(content\)/);
});

test('只有真正离开底部的用户滚动才会取消打开事务', () => {
  const source = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');
  const markStart = source.indexOf('const markUserScrollIntent = useCallback');
  const onScrollStart = source.indexOf('const onScroll = () =>', markStart);
  const mark = source.slice(markStart, onScrollStart);
  const onScroll = source.slice(onScrollStart, source.indexOf('// 每个 generation 都是新的打开事务', onScrollStart));

  assert.equal(mark.includes("openPhase.current = 'cancelled'"), false);
  assert.match(onScroll, /if \(userInitiated && !nearBottom\) \{\s*openPhase\.current = 'cancelled';\s*cancelSettleFrame\(\);/);
});

test('普通打开会话会清除旧消息定位，避免贴底后又平滑回弹', () => {
  const source = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const openRoom = source.slice(
    source.indexOf('openRoom: async (rid, options) => {'),
    source.indexOf('openThread: async'),
  );

  assert.match(openRoom, /highlightMid: null/);
  assert.match(openRoom, /messageScrollTransaction: transaction/);
  assert.match(openRoom, /messageScrollGeneration: transaction\.generation/);
});

test('并发消息定位会在等待历史前锁定 generation 与目标消息', () => {
  const source = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const jumpStart = source.indexOf('jumpToMessage: async');
  const jump = source.slice(jumpStart, source.indexOf('emitTyping: () =>', jumpStart));
  const start = jump.indexOf('const opening = get().openRoom');
  const capture = jump.indexOf('const generation = get().messageScrollTransaction?.generation');
  const wait = jump.indexOf('await opening');

  assert.ok(start >= 0 && start < capture && capture < wait);
  assert.match(jump, /'locate',\s*mid/);
  assert.match(jump, /if \(isCurrent\(\) && get\(\)\.highlightMid === mid\)/);
});

test('切换房间会重建消息列表，避免复用上一会话的滚动位置（issue #115）', () => {
  const source = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');
  assert.match(
    source,
    /key=\{`\$\{activeRid\}:\$\{messageScrollTransaction\?\.rid === activeRid \? messageScrollTransaction\.generation : 0\}`\}/,
  );
  assert.match(
    source,
    /transaction=\{messageScrollTransaction\?\.rid === activeRid \? messageScrollTransaction : null\}/,
  );
});

test('有更早消息时，当前页首条不能伪装成真实未读分界', () => {
  assert.equal(
    shouldShowUnreadDivider({
      unreadMark: 100,
      messageTs: 200,
      previousMessageTs: undefined,
      hasMore: true,
    }),
    false,
  );
});

test('当前页包含上次已读消息时，仍显示真实未读分界', () => {
  assert.equal(
    shouldShowUnreadDivider({
      unreadMark: 150,
      messageTs: 200,
      previousMessageTs: 100,
      hasMore: true,
    }),
    true,
  );
});

test('历史已完整加载时，首条消息可以是真实未读分界', () => {
  assert.equal(
    shouldShowUnreadDivider({
      unreadMark: 100,
      messageTs: 200,
      previousMessageTs: undefined,
      hasMore: false,
    }),
    true,
  );
});
