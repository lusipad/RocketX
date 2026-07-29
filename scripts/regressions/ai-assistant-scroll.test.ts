import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('对话类页面打开时停在最新内容，滚上去阅读时不被拽回底部（issue #90）', () => {
  // 共享贴底 hook：绘制前定位 + 底部附近才跟随 + 可强制回底
  const lib = readFileSync('apps/web/src/lib/stickToBottom.ts', 'utf8');
  assert.match(lib, /useLayoutEffect\(\(\) => \{[\s\S]*?scrollTop = element\.scrollHeight;[\s\S]*?\}, deps\)/);
  assert.match(lib, /element\.scrollHeight - element\.scrollTop - element\.clientHeight < NEAR_BOTTOM_PX/);

  // 管家桌面对话：对话流 + 发送后强制回底
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  // 按「必须包含」而不是「必须恰好等于」断言：焊死整个数组既挡不住漏加
  // （2026-07-26 漏掉 errandDraft，让从桌面页派活整条链路静默失败），
  // 又让每次新增卡片都误伤一条无关的滚动测试。
  const conversationDeps = /useStickToBottom\(\[([\s\S]*?)\]\)/.exec(conversation)?.[1] ?? '';
  assert.ok(conversationDeps, '找不到管家对话的 stickToBottom 依赖数组');
  for (const dep of ['visibleLines', 'activity', 'butlerError', 'routineDraft', 'errandDraft', 'errands', 'runtimeCheckpoints', 'actionDraft', 'steps', 'activeArtifacts', 'selectedHostedId']) {
    assert.ok(conversationDeps.includes(dep), `管家对话的贴底依赖漏了 ${dep}`);
  }
  assert.match(conversation, /<main ref=\{scrollRef\} onScroll=\{onScroll\}/);
  assert.match(conversation, /stickToBottom\.current = true/);

  // 执行间：消息流 + 发送后强制回底（issue #90 同类）
  const codexPage = readFileSync('apps/web/src/pages/CodexPage.tsx', 'utf8');
  assert.match(codexPage, /useStickToBottom\(\[messages, status, approvals\]\)/);
  assert.match(codexPage, /<div ref=\{scrollRef\} onScroll=\{onScroll\}/);
  assert.match(codexPage, /stickToBottom\.current = true/);

  // 托管面板「本地过程」：运行时 trace 持续追加也要贴底
  const agentPanel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  assert.match(agentPanel, /useStickToBottom\(\[sessionTraces\]\)/);
  assert.match(agentPanel, /<div ref=\{scrollRef\} onScroll=\{onScroll\}/);
});
