import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('Codex 任务流和托管会话过程流都使用共享贴底 hook，旧独立 CodexPage 已退役', () => {
  const hook = readFileSync('apps/web/src/lib/stickToBottom.ts', 'utf8');
  assert.match(hook, /useLayoutEffect\(\(\) => \{/);
  assert.match(hook, /scrollTop = element\.scrollHeight/);
  assert.match(hook, /element\.scrollHeight - element\.scrollTop - element\.clientHeight < NEAR_BOTTOM_PX/);

  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  assert.match(conversation, /const \{ streamingText, events \} = useCodexStreamingView\(\)/);
  assert.doesNotMatch(conversation, /useCodexWorkspace\(\(state\) => state\.events\)/);
  assert.match(
    conversation,
    /useStickToBottom\(\[\s*messages,\s*streamingText,\s*events,\s*requests,\s*queuedMessages,\s*\]\)/,
  );
  assert.match(conversation, /<main ref=\{scrollRef\} onScroll=\{onScroll\} className="codex-native-transcript">/);
  assert.match(conversation, /stickToBottom\.current = true/);
  assert.match(conversation, /\{streamingText\}/);
  assert.doesNotMatch(conversation, /renderMarkdown\(streamingText/);

  const roomPanel = readFileSync('apps/web/src/components/ButlerPanel.tsx', 'utf8');
  const hostedConversation = readFileSync('apps/web/src/components/HostedConversation.tsx', 'utf8');
  assert.match(roomPanel, /useStickToBottom\(\[/);
  assert.match(roomPanel, /<div ref=\{scrollRef\} onScroll=\{onScroll\}/);
  assert.match(roomPanel, /\{streamingText\}/);
  assert.doesNotMatch(roomPanel, /renderMarkdown\(streamingText/);
  assert.match(hostedConversation, /useStickToBottom\(\[session\.key, messages\]\)/);
  assert.match(hostedConversation, /<div ref=\{scrollRef\} onScroll=\{onScroll\} className="codex-native-transcript">/);

  const styles = readFileSync('apps/web/src/styles.css', 'utf8');
  assert.match(styles, /\.codex-native-transcript\s*\{[^}]*overflow-anchor:\s*none/s);

  const agentPanel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  assert.match(agentPanel, /useStickToBottom\(\[sessionTraces\]\)/);
  assert.match(agentPanel, /<div ref=\{scrollRef\} onScroll=\{onScroll\}/);

  assert.equal(existsSync('apps/web/src/pages/CodexPage.tsx'), false);
});
