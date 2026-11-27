import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import { resetCodexWorkspaceForTests, useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';

test('项目行直接提供移除入口，不产生下拉层滚动条，并明确不会删除磁盘目录或 Codex 会话', () => {
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');

  assert.match(history, /const removeWorkspaceRoot = useCodexWorkspace\(\(state\) => state\.removeWorkspaceRoot\)/);
  assert.match(history, /className="butler-codex-workspace-actions"/);
  assert.match(history, /const projectEntries = useMemo/);
  assert.match(history, /entry\.configurable \? \(/);
  assert.match(history, /aria-label=\{t\('butler\.history\.removeProjectAria', \{ label: entry\.label \}\)\}/);
  assert.equal(zhCN['butler.history.removeProjectAria'], '移除项目：{label}');
  assert.ok(enUS['butler.history.removeProjectAria'].includes('{label}'));
  assert.match(
    history,
    /title=\{t\(entry\.busy \? 'butler\.history\.removeProjectBusyTitle' : 'butler\.history\.removeProjectTitle'\)\}/,
  );
  assert.equal(zhCN['butler.history.removeProjectBusyTitle'], '活动讨论结束后才能移除项目');
  assert.equal(zhCN['butler.history.removeProjectTitle'], '移除项目');
  assert.ok(enUS['butler.history.removeProjectBusyTitle'].length > 0);
  assert.ok(enUS['butler.history.removeProjectTitle'].length > 0);
  assert.match(history, /<FolderMinus size=\{14\} aria-hidden="true" \/>/);
  assert.doesNotMatch(history, /title=\{path\}/);
  assert.doesNotMatch(history, /role="menu" aria-label="项目操作"/);
  assert.equal(Object.values(zhCN).includes('项目操作'), false);
  assert.match(history, /t\('butler\.history\.removeProjectDialogMessage', \{ path: workspaceToRemove \}\)/);
  assert.match(zhCN['butler.history.removeProjectDialogMessage'], /不会删除磁盘目录或 Codex 会话/);
  assert.ok(enUS['butler.history.removeProjectDialogMessage'].length > 0);
  assert.match(styles, /\.butler-codex-workspace-actions > button \{[^}]*opacity: 0\.72;/s);
});

test('移除项目只更新 RocketX 项目列表，并在移除当前项目后选择剩余项目', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('project-removal');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace-a');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace-b');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace-a');

    const removeWorkspaceRoot = (useCodexWorkspace.getState() as unknown as {
      removeWorkspaceRoot: (workspaceRoot: string) => Promise<void>;
    }).removeWorkspaceRoot;
    await removeWorkspaceRoot('D:/workspace-a');

    assert.equal(useCodexWorkspace.getState().workspaceRoot, 'D:/workspace-b');
    assert.deepEqual(useCodexWorkspace.getState().workspaceRoots, ['D:/workspace-b']);
    assert.deepEqual(JSON.parse(values.get('rcx-codex-workspace-v1:project-removal') ?? '{}'), {
      workspaceRoot: 'D:/workspace-b',
      workspaceRoots: ['D:/workspace-b'],
      selectedEffort: null,
      permissionPreset: 'auto',
      followUpMode: 'steer',
    });

    await removeWorkspaceRoot('D:/workspace-b');
    assert.equal(useCodexWorkspace.getState().workspaceRoot, '');
    assert.deepEqual(useCodexWorkspace.getState().workspaceRoots, []);
  } finally {
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
