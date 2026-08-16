import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Codex 工作区入口使用新对话、拉取请求、已安排、插件和项目历史', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const workspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  const ui = readFileSync('apps/web/src/stores/ui.ts', 'utf8');

  assert.match(page, /<ButlerConversationHistory \/>/);
  assert.match(page, /<ManagedSurface><ButlerRoutines \/><\/ManagedSurface>/);
  assert.match(page, /<ManagedSurface><ButlerPluginsPage \/><\/ManagedSurface>/);
  assert.doesNotMatch(page, /Dynamic|ButlerWorkspaceNav|今日纸|技能中心|身份中心/);

  assert.match(history, /aria-label="新对话"/);
  assert.match(history, /startThread\(\)/);
  assert.match(history, /resumeThread\(thread\.id\)/);
  assert.match(history, /aria-label="Codex 工作区"/);
  assert.match(history, /AI 托管/);
  assert.match(history, /aria-label="AI 托管会话"/);
  assert.match(history, />系统工作区</);
  assert.match(history, />个人项目</);
  assert.match(history, /Codex 对话历史/);
  assert.match(history, /setWorkbenchTab\('prs'\)/);
  assert.match(history, /拉取请求/);
  assert.match(history, /已安排/);
  assert.match(history, /插件/);
  assert.match(history, /const projectEntries = useMemo/);
  assert.match(history, /aria-label=\{`项目配置：\$\{entry\.label\}`\}/);
  assert.match(history, /title="项目配置"/);
  assert.doesNotMatch(history, /setButlerView\('hosting'\)/);
  assert.doesNotMatch(history, /aria-label="任务"/);
  assert.doesNotMatch(history, /ButlerSessionSwitcher|today|memory|paper|manage/);

  assert.match(workspace, /importLegacyWorkspaceRoots\(legacyWorkspaceRoots\)/);
  assert.match(workspace, /controller\.listThreads\(threadWorkspaceRoots\(get\(\)\)\)/);

  assert.match(ui, /aiRuntimeProvider: getAiRuntimeProvider\(\)/);
  assert.match(ui, /openButlerConversation: \(focusSessionKey\?: string\) => \{/);
  assert.doesNotMatch(ui, /setButlerTaskProvider|butlerTaskProviderPreference/);
  assert.match(ui, /butlerView: 'conversation'/);
  assert.match(ui, /selectedHostedSessionKey: focusSessionKey \?\? null/);
  assert.match(ui, /setButlerView: \(view\) => \{/);
  assert.match(ui, /module: 'butler-view',[\s\S]*butlerView: view/);
  assert.doesNotMatch(ui, /openButlerManage|openButlerPaper|butlerPaperDate|butlerConversationOpen|butlerManageOpen/);
});
