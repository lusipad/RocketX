import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialMessageScrollTop,
  shouldShowUnreadDivider,
} from '../../apps/web/src/components/MessageList';

test('首次打开会话始终以列表底部为初始位置', () => {
  assert.equal(
    initialMessageScrollTop({
      historyLoaded: true,
      didInitialScroll: false,
      scrollHeight: 2400,
    }),
    2400,
  );
  assert.equal(
    initialMessageScrollTop({
      historyLoaded: true,
      didInitialScroll: true,
      scrollHeight: 2400,
    }),
    undefined,
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
