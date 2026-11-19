import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountContext(page: Page, mode: 'memory' | 'search' | 'method') {
  await bootAuthenticated(page);
  await page.evaluate(async (mode) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, component, memory, ledger, acp, workspace] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load(mode === 'memory' ? '/src/components/ButlerAssistantCenter.tsx' : mode === 'method' ? '/src/components/WorkMethodReuse.tsx' : '/src/components/WorkContextSearch.tsx'),
      load('/src/stores/butlerMemory.ts'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'), load('/src/stores/codexWorkspace.ts'),
    ]);
    const accountScope = memory.resolveButlerAccountScope();
    memory.useButlerMemory.setState({ accountScope, memories: [], digests: [], memoryPaused: false, hydrate: async () => {} });
    acp.useAcpAgents.setState({ hydrate: async () => {}, agents: [], sessions: {} });
    ledger.useWorkLedger.setState({ hydrate: async () => {}, cards: [], sessions: [], links: [], evidences: [], loading: false, lastError: null });
    workspace.useCodexWorkspace.setState({ workspaceRoot: 'D:/project' });
    await memory.useButlerMemory.getState().upsertMemory({ title: '测试约定', content: '旧的测试命令', category: 'project_fact', sourceKind: 'conversation', sourceRef: 'thread:original', workspaceRoot: 'D:/project' });
    await memory.useButlerMemory.getState().upsertMemory({ title: '其他项目机密', content: '不应展示', category: 'project_fact', sourceKind: 'manual', workspaceRoot: 'D:/other' });
    const card = await ledger.useWorkLedger.getState().createCard({ title: '发布修复' });
    ledger.useWorkLedger.setState({
      cards: [{ ...card, adoWorkItemId: 812, done: mode === 'method', state: { ...card.state, projectKey: 'RocketX', goal: '发布修复', acceptance: ['构建通过'], requirementsVersion: 1, contentVersion: 1 } }],
      sessions: [{ id: 's', todoId: card.id, nativeSessionId: 'native-812', runtime: 'codex', accountScope, workspaceRoot: 'D:/project', updatedAt: 10 }],
      evidences: [{ id: 'e', todoId: card.id, title: 'release-notes.md', summary: 'D:/project/docs/release-notes.md', workspaceRoot: 'D:/project', verifiedAt: 20, kind: 'test_run', passed: true, stale: false, requirementsVersion: 1, contentVersion: 1, criterionIds: ['构建通过'] }],
    });
    const React = react.default ?? react;
    const { createRoot } = dom.default ?? dom;
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'context-under-test';
    host.style.cssText = 'height:100vh;display:flex;flex-direction:column';
    document.body.append(host);
    if (mode === 'method') {
      const { useRoutines } = await load('/src/stores/routines.ts');
      useRoutines.setState({ routines: [], eventCards: [], seenKeys: [], unloadedTemplateIds: [] });
    }
    createRoot(host).render(React.createElement(component.default, mode !== 'memory' ? {
      workspaceRoot: 'D:/project', projectKey: 'RocketX',
      workId: card.id,
      onSelectWork: (id: string) => { host.dataset.selected = id; },
    } : {}));
  }, mode);
  return page.locator('#context-under-test');
}

test('用户纠正后只见当前背景，来源和旧版可查看，过期后不再召回', async ({ page }) => {
  const host = await mountContext(page, 'memory');
  await host.getByRole('button', { name: /长期记忆库/ }).click();
  await expect(host.getByText('其他项目机密', { exact: true })).toHaveCount(0);
  await host.getByTitle('纠正记忆').click();
  await host.getByRole('textbox', { name: '记忆内容' }).fill('改为 pnpm test:pure');
  await host.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(host.getByText('改为 pnpm test:pure', { exact: true })).toBeVisible();
  await expect(host.getByText('旧的测试命令', { exact: true })).toHaveCount(0);
  await host.getByText('查看来源与有效性', { exact: true }).click();
  await expect(host.getByText(/thread:original/)).toBeVisible();
  await host.getByRole('checkbox', { name: /显示停用/ }).check();
  await expect(host.getByText('旧的测试命令', { exact: true })).toBeVisible();
  await expect(host.getByText('已纠正', { exact: true })).toBeVisible();
  await host.getByRole('checkbox', { name: /显示停用/ }).uncheck();
  await host.getByRole('button', { name: '这条信息已过期' }).click();
  await expect(host.getByText('改为 pnpm test:pure', { exact: true })).toHaveCount(0);
  const recalled = await page.evaluate(async () => {
    const module = await new Function('return import("/src/stores/butlerMemory.ts")')();
    return module.useButlerMemory.getState().recallRelevantMemories({ workspaceRoot: 'D:/project' });
  });
  expect(recalled).toEqual([]);
});

test('从验收完成的工作保存方法并在项目中创建独立新工作', async ({ page }) => {
  const host = await mountContext(page, 'method');
  await host.getByRole('button', { name: '将成功方法保存为模板' }).click();
  await host.getByRole('textbox', { name: '方法名称', exact: true }).fill('发布修复方法');
  await host.getByRole('textbox', { name: '输入及来源说明' }).fill('从项目缺陷中读取编号与复现步骤');
  await host.getByRole('textbox', { name: '可复用步骤' }).fill('复现，修复，执行构建');
  await host.getByRole('textbox', { name: '失败处理' }).fill('保存日志，交回负责人处理');
  await host.getByRole('button', { name: '保存方法', exact: true }).click();
  await host.getByRole('button', { name: '从方法创建工作' }).click();
  await host.getByRole('textbox', { name: '新工作名称' }).fill('修复下一个发布问题');
  await host.getByRole('textbox', { name: '本次输入及来源', exact: true }).fill('ADO #813');
  await host.getByRole('button', { name: '创建新工作', exact: true }).click();
  await expect(host).toHaveAttribute('data-selected', /.+/);
  const actual = await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [{ useWorkLedger }, { useRoutines }] = await Promise.all([load('/src/stores/workLedger.ts'), load('/src/stores/routines.ts')]);
    const state = useWorkLedger.getState();
    const id = document.querySelector<HTMLElement>('#context-under-test')!.dataset.selected;
    const card = state.cards.find((c: any) => c.id === id);
    const method = useRoutines.getState().routines[0];
    useRoutines.setState({ routines: [] });
    useRoutines.getState().hydrate();
    return { card, evidenceCount: state.evidences.filter((e: any) => e.todoId === id).length, methodEnabled: method.enabled, restoredMethodId: useRoutines.getState().routines[0]?.id, methodId: method.id };
  });
  expect(actual.card.title).toBe('修复下一个发布问题');
  expect(actual.card.state.acceptance).toEqual(['构建通过']);
  expect(actual.card.done).toBe(false);
  expect(actual.evidenceCount).toBe(0);
  expect(actual.methodEnabled).toBe(false);
  expect(actual.restoredMethodId).toBe(actual.methodId);
});

test('在项目范围检索 ADO、会话与成果文件，选择结果回到同一工作', async ({ page }) => {
  const host = await mountContext(page, 'search');
  await host.getByText('检索范围与更新时间 · 仅当前账号缓存', { exact: true }).click();
  await expect(host.getByText(/不读取磁盘全文/)).toBeVisible();
  const search = host.getByRole('searchbox');
  await search.fill('812');
  await host.getByRole('button', { name: '发布修复' }).click();
  await expect(host).toHaveAttribute('data-selected', /.+/);
  await search.fill('native-812');
  await expect(host.getByText(/原生会话 ·/)).toBeVisible();
  await search.fill('release-notes.md');
  await expect(host.getByRole('button', { name: 'release-notes.md', exact: true })).toBeVisible();
  await expect(host.getByText(/验证成果 ·/)).toBeVisible();
  await search.fill('不存在的内容');
  await expect(host.getByRole('status')).toContainText('当前缓存范围内没有匹配结果');
});
