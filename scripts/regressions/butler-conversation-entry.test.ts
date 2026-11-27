import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';

test('管家首页由 ButlerPage 承载 Codex 式三工作面，任务面由原生线程历史和当前线程组成', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');

  assert.match(page, /piRuntime && activeView === 'routines' \? \(/);
  assert.match(page, /piRuntime && activeView === 'plugins' \? \(/);
  assert.match(page, /<ButlerRoutines \/>/);
  assert.match(page, /<ButlerPluginsPage \/>/);
  assert.match(page, /<section aria-label=\{t\('butler\.page\.tasksAria'\)\} className="butler-task-surface">/);
  assert.match(zhCN['butler.page.tasksAria'], /^任务$/);
  assert.ok(enUS['butler.page.tasksAria'].trim());
  assert.match(page, /const aiRuntimeProvider = useUI\(\(state\) => state\.aiRuntimeProvider\)/);
  assert.doesNotMatch(page, /butler-task-provider-mobile|管家执行引擎/);
  assert.doesNotMatch(page, /任务执行视图|role="tab"/);
  assert.doesNotMatch(page, /localStorage/);
  assert.match(page, /<ButlerConversation embedded workBrief=\{workBrief\} \/>/);
  assert.doesNotMatch(page, /ButlerSessionSwitcher|ButlerIdentityPage|ButlerConnectionsPanel|Today/);

  assert.match(history, /<nav className="butler-codex-surface-nav work-first-primary-nav" aria-label=\{t\('butler\.history\.aiCollabAria'\)\}>/);
  assert.match(zhCN['butler.history.aiCollabAria'], /AI 协作/);
  assert.ok(enUS['butler.history.aiCollabAria'].trim());
  assert.match(history, /setButlerView\('conversation'\)/);
  assert.match(history, /setButlerView\('routines'\)/);
  assert.match(history, /setButlerView\('plugins'\)/);
  assert.match(history, /await startThread\(\)/);
  assert.match(history, /void resumeThread\(thread\.id\)/);
  assert.match(history, /title: t\('butler\.chooseWorkspaceTitle'\)/);
  assert.match(zhCN['butler.chooseWorkspaceTitle'], /选择工作区/);
  assert.ok(enUS['butler.chooseWorkspaceTitle'].trim());
  assert.match(history, /const workspaceRoots = useCodexWorkspace\(\(state\) => state\.workspaceRoots\)/);
  assert.match(history, /aria-label=\{t\('butler\.history\.addHostedProject'\)\}/);
  assert.match(zhCN['butler.history.addHostedProject'], /添加托管项目/);
  assert.ok(enUS['butler.history.addHostedProject'].trim());
  assert.match(history, /const butlerWorkspaceRoot = useCodexWorkspace/);
  assert.match(history, /label: systemDefault \? t\('butler\.workspace\.tempSession'\) : systemButler \? t\('butler\.workspace\.butlerSession'\)/);
  assert.match(zhCN['butler.workspace.tempSession'], /临时会话/);
  assert.match(zhCN['butler.workspace.butlerSession'], /管家会话/);
  assert.ok(enUS['butler.workspace.tempSession'].trim());
  assert.ok(enUS['butler.workspace.butlerSession'].trim());
  assert.match(history, /aria-label=\{t\('butler\.history\.workProjectsAria'\)\}/);
  assert.match(zhCN['butler.history.workProjectsAria'], /工作项目/);
  assert.ok(enUS['butler.history.workProjectsAria'].trim());
  assert.match(history, />\{t\('butler\.history\.personalProjects'\)\}</);
  assert.match(zhCN['butler.history.personalProjects'], /个人项目/);
  assert.ok(enUS['butler.history.personalProjects'].trim());
  assert.match(history, /const butlerRoot = useCodexWorkspace\.getState\(\)\.butlerWorkspaceRoot/);
  assert.match(history, /await setWorkspaceRoot\(butlerRoot\)/);
  assert.match(history, /aria-expanded=\{expanded\}/);
  assert.match(history, /const THREAD_PREVIEW_LIMIT = 5/);
  assert.match(history, /const \[historyExpanded, setHistoryExpanded\] = useState\(false\)/);
  assert.match(history, /const recent = visibleThreads\.slice\(0, THREAD_PREVIEW_LIMIT\)/);
  assert.match(history, /const active = visibleThreads\.find\(\(thread\) => thread\.id === activeThreadId\)/);
  assert.match(history, /displayedThreads\.map\(\(thread\) => \{/);
  assert.match(history, /tp\(hiddenThreadCount, 'butler\.history\.expandOlderOne', 'butler\.history\.expandOlderOther'\)/);
  assert.match(zhCN['butler.history.expandOlderOne'], /展开其余 \{count\} 个/);
  assert.match(zhCN['butler.history.expandOlderOther'], /展开其余 \{count\} 个/);
  assert.ok(enUS['butler.history.expandOlderOne'].trim());
  assert.ok(enUS['butler.history.expandOlderOther'].trim());
  assert.match(history, /t\('butler\.history\.collapseOlder'\)/);
  assert.match(zhCN['butler.history.collapseOlder'], /收起较早对话/);
  assert.ok(enUS['butler.history.collapseOlder'].trim());
  assert.match(history, /aria-expanded=\{historyExpanded\}/);
  assert.match(
    styles,
    /\.codex-history-nav \.codex-native-thread-expand \{[^}]*display: flex;[^}]*grid-template-columns: none;[^}]*white-space: nowrap;/s,
  );
  assert.match(
    styles,
    /\.codex-native-thread-main\[aria-current='page'\] \+ \.codex-native-thread-actions > button \{[^}]*background: var\(--color-fill-hover\);[^}]*opacity: 1;/,
  );
  assert.match(history, /aria-label=\{t\('butler\.history\.switchToCodexAria'\)\}/);
  assert.match(zhCN['butler.history.switchToCodexAria'], /在 Codex App 管理|切换到 Codex App/);
  assert.ok(enUS['butler.history.switchToCodexAria'].trim());

  assert.match(conversation, /const workspaceRoot = useCodexWorkspace\(\(state\) => state\.workspaceRoot\)/);
  assert.match(conversation, /const threads = useCodexWorkspace\(\(state\) => state\.threads\)/);
  assert.match(conversation, /const messages = useCodexWorkspace\(\(state\) => state\.messages\)/);
  assert.match(conversation, /const \{ streamingText, events \} = useCodexStreamingView\(\)/);
  assert.match(conversation, /const requests = useCodexWorkspace\(\(state\) => state\.pendingRequests\)/);
  assert.match(conversation, /const send = useCodexWorkspace\(\(state\) => state\.send\)/);
  assert.match(conversation, /const interrupt = useCodexWorkspace\(\(state\) => state\.interrupt\)/);
  assert.match(conversation, /const handoffToCodex = useCodexWorkspace\(\(state\) => state\.handoffToCodex\)/);
  assert.match(conversation, /const result = await handoffToCodex\(\)/);
  assert.match(conversation, /'butler\.conversation\.openInCodex'/);
  assert.match(zhCN['butler.conversation.openInCodex'], /在 Codex 中打开/);
  assert.ok(enUS['butler.conversation.openInCodex'].trim());
  assert.match(conversation, /t\('butler\.conversation\.continueInRocketX'\)/);
  assert.match(zhCN['butler.conversation.continueInRocketX'], /在 RocketX 继续/);
  assert.ok(enUS['butler.conversation.continueInRocketX'].trim());
  assert.match(conversation, /t\('butler\.conversation\.externalDesc'\)/);
  assert.match(zhCN['butler.conversation.externalDesc'], /不需要退出 Codex App/);
  assert.ok(enUS['butler.conversation.externalDesc'].trim());
  assert.match(conversation, /const composerPlaceholder = status === 'external'/);
  assert.match(conversation, /t\('butler\.conversation\.externalComposerNotice'\)/);
  assert.match(zhCN['butler.conversation.externalComposerNotice'], /Codex App 保留原任务/);
  assert.ok(enUS['butler.conversation.externalComposerNotice'].trim());
  assert.match(conversation, /id="codex-external-composer-notice"/);
  assert.match(conversation, /aria-describedby=\{`butler-composer-target\$\{status === 'external' \? ' codex-external-composer-notice' : ''\}`\}/);
  assert.match(conversation, /requestAnimationFrame\(\(\) => textareaRef\.current\?\.focus\(\)\)/);
  assert.match(conversation, /labelKey: 'butler\.conversation\.permission\.autoLabel'/);
  assert.match(zhCN['butler.conversation.permission.autoLabel'], /替我审批/);
  assert.ok(enUS['butler.conversation.permission.autoLabel'].trim());
  assert.match(conversation, /descriptionKey: 'butler\.conversation\.permission\.autoDesc'/);
  assert.match(zhCN['butler.conversation.permission.autoDesc'], /只在检测到潜在危险时询问/);
  assert.ok(enUS['butler.conversation.permission.autoDesc'].trim());
  assert.match(conversation, /CodexImagePicker/);
  assert.match(conversation, /CodexGeneratedImages/);
  assert.doesNotMatch(conversation, /<select/);
  assert.doesNotMatch(conversation, /useButler\(|ButlerSessionSwitcher|openRoomConversation|openStandaloneConversation/);
});
