import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('管家首页由 ButlerPage 承载 Codex 式三工作面，任务面由原生线程历史和当前线程组成', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');

  assert.match(page, /activeView === 'routines' \? \(/);
  assert.match(page, /activeView === 'plugins' \? \(/);
  assert.match(page, /<ButlerRoutines \/>/);
  assert.match(page, /<ButlerPluginsPage \/>/);
  assert.match(page, /<section aria-label="任务" className="h-full min-h-0">/);
  assert.match(page, /<ButlerConversation embedded \/>/);
  assert.doesNotMatch(page, /ButlerSessionSwitcher|ButlerIdentityPage|ButlerConnectionsPanel|Today/);

  assert.match(history, /<nav className="butler-codex-surface-nav" aria-label="Codex 工作区">/);
  assert.match(history, /setButlerView\('conversation'\)/);
  assert.match(history, /setButlerView\('routines'\)/);
  assert.match(history, /setButlerView\('plugins'\)/);
  assert.match(history, /await startThread\(\)/);
  assert.match(history, /void resumeThread\(thread\.id\)/);
  assert.match(history, /选择工作区/);
  assert.match(history, /在 Codex App 管理|切换到 Codex App/);

  assert.match(conversation, /const workspaceRoot = useCodexWorkspace\(\(state\) => state\.workspaceRoot\)/);
  assert.match(conversation, /const threads = useCodexWorkspace\(\(state\) => state\.threads\)/);
  assert.match(conversation, /const messages = useCodexWorkspace\(\(state\) => state\.messages\)/);
  assert.match(conversation, /const events = useCodexWorkspace\(\(state\) => state\.events\)/);
  assert.match(conversation, /const requests = useCodexWorkspace\(\(state\) => state\.pendingRequests\)/);
  assert.match(conversation, /const send = useCodexWorkspace\(\(state\) => state\.send\)/);
  assert.match(conversation, /const interrupt = useCodexWorkspace\(\(state\) => state\.interrupt\)/);
  assert.match(conversation, /在 Codex 中打开/);
  assert.match(conversation, /placeholder=\{running \? \(followUpMode === 'steer'/);
  assert.match(conversation, /替我审批/);
  assert.match(conversation, /只在检测到潜在危险时询问/);
  assert.match(conversation, /CodexImagePicker/);
  assert.doesNotMatch(conversation, /<select/);
  assert.doesNotMatch(conversation, /useButler\(|ButlerSessionSwitcher|openRoomConversation|openStandaloneConversation/);
});
