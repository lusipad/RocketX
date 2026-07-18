import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('AI 页面打开时停在最新对话，滚上去阅读时不被拽回底部（issue #90）', () => {
  const page = readFileSync('apps/web/src/pages/AiAssistantPage.tsx', 'utf8');
  // 打开页面/新内容到达时贴底；useLayoutEffect 在绘制前定位，避免先看到顶部再跳一下
  assert.match(
    page,
    /useLayoutEffect\(\(\) => \{[\s\S]*?scrollTop = element\.scrollHeight;[\s\S]*?\}, \[lines, activity, butlerError, routineDraft\]\)/,
  );
  // 滚动容器挂了 ref 和滚动监听
  assert.match(page, /<div ref=\{scrollRef\} onScroll=\{handleScroll\}/);
  // 用户滚上去阅读历史时停止跟随，回到底部附近恢复
  assert.match(page, /stickToBottom\.current = element\.scrollHeight - element\.scrollTop - element\.clientHeight < 48/);
  // 发送新消息后总是回到最新
  assert.match(page, /stickToBottom\.current = true/);
});
