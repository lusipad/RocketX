import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACT_CONVERSATION_WIDTH,
  effectiveConversationWidth,
} from '../../apps/web/src/lib/conversationPanelLayout';

test('右侧面板触发的标记会把会话列表临时收窄', () => {
  assert.equal(
    effectiveConversationWidth(320, true, null, 480),
    COMPACT_CONVERSATION_WIDTH,
  );
});

test('拖动中的会话列表宽度优先于临时收窄', () => {
  assert.equal(effectiveConversationWidth(320, true, 360, 480), 360);
});

test('清除临时收窄标记后恢复用户宽度', () => {
  assert.equal(effectiveConversationWidth(320, false, null, 480), 320);
});
