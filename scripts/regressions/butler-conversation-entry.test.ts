import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('管家首页由 ButlerPage 承载 Codex 式三工作面，任务面由原生线程历史和当前线程组成', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');

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
  assert.match(history, /选择 Codex 工作区/);
  assert.match(history, /const workspaceRoots = useCodexWorkspace\(\(state\) => state\.workspaceRoots\)/);
  assert.match(history, /aria-label="添加托管项目"/);
  assert.match(history, /const butlerWorkspaceRoot = useCodexWorkspace/);
  assert.match(history, /const label = systemDefault \? '临时会话' : systemButler \? '管家会话'/);
  assert.match(history, /aria-label="托管项目"/);
  assert.match(history, /const butlerRoot = useCodexWorkspace\.getState\(\)\.butlerWorkspaceRoot/);
  assert.match(history, /await setWorkspaceRoot\(butlerRoot\)/);
  assert.match(history, /aria-expanded=\{expanded\}/);
  assert.match(history, /const THREAD_PREVIEW_LIMIT = 5/);
  assert.match(history, /const \[historyExpanded, setHistoryExpanded\] = useState\(false\)/);
  assert.match(history, /const recent = visibleThreads\.slice\(0, THREAD_PREVIEW_LIMIT\)/);
  assert.match(history, /const active = visibleThreads\.find\(\(thread\) => thread\.id === activeThreadId\)/);
  assert.match(history, /displayedThreads\.map\(\(thread\) => \{/);
  assert.match(history, /展开其余 \$\{hiddenThreadCount\} 个/);
  assert.match(history, /收起较早对话/);
  assert.match(history, /aria-expanded=\{historyExpanded\}/);
  assert.match(
    styles,
    /nav\[aria-label='Codex 对话历史'\] \.codex-native-thread-expand \{[^}]*display: flex;[^}]*grid-template-columns: none;[^}]*white-space: nowrap;/s,
  );
  assert.match(
    styles,
    /\.codex-native-thread-main\[aria-current='page'\] \+ \.codex-native-thread-actions > button \{[^}]*background: var\(--color-fill-hover\);[^}]*opacity: 1;/,
  );
  assert.match(history, /在 Codex App 管理|切换到 Codex App/);

  assert.match(conversation, /const workspaceRoot = useCodexWorkspace\(\(state\) => state\.workspaceRoot\)/);
  assert.match(conversation, /const threads = useCodexWorkspace\(\(state\) => state\.threads\)/);
  assert.match(conversation, /const messages = useCodexWorkspace\(\(state\) => state\.messages\)/);
  assert.match(conversation, /const events = useCodexWorkspace\(\(state\) => state\.events\)/);
  assert.match(conversation, /const requests = useCodexWorkspace\(\(state\) => state\.pendingRequests\)/);
  assert.match(conversation, /const send = useCodexWorkspace\(\(state\) => state\.send\)/);
  assert.match(conversation, /const interrupt = useCodexWorkspace\(\(state\) => state\.interrupt\)/);
  assert.match(conversation, /const handoffToCodex = useCodexWorkspace\(\(state\) => state\.handoffToCodex\)/);
  assert.match(conversation, /await handoffToCodex\(\);[\s\S]*await openCodexThread\(activeThreadId\)/);
  assert.match(conversation, /在 Codex 中打开/);
  assert.match(conversation, /在 RocketX 继续/);
  assert.match(conversation, /不需要退出 Codex App/);
  assert.match(conversation, /const composerPlaceholder = status === 'external'/);
  assert.match(conversation, /Codex App 保留原任务/);
  assert.match(conversation, /id="codex-external-composer-notice"/);
  assert.match(conversation, /aria-describedby=\{status === 'external' \? 'codex-external-composer-notice' : undefined\}/);
  assert.match(conversation, /requestAnimationFrame\(\(\) => textareaRef\.current\?\.focus\(\)\)/);
  assert.match(conversation, /替我审批/);
  assert.match(conversation, /只在检测到潜在危险时询问/);
  assert.match(conversation, /CodexImagePicker/);
  assert.match(conversation, /CodexGeneratedImages/);
  assert.doesNotMatch(conversation, /<select/);
  assert.doesNotMatch(conversation, /useButler\(|ButlerSessionSwitcher|openRoomConversation|openStandaloneConversation/);
});
