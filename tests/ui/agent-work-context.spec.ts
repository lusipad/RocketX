import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountPortal(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, reactDomModule, component, { useWorkLedger }, { useAcpAgents }, { useCodexWorkspace }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/ButlerWorkPortalDock.tsx'), load('/src/stores/workLedger.ts'),
      load('/src/stores/acpAgents.ts'), load('/src/stores/codexWorkspace.ts'),
    ]);
    const a = await useWorkLedger.getState().createCard({ title: '工作 A', stage: 'in_progress' });
    const b = await useWorkLedger.getState().createCard({ title: '工作 B', stage: 'in_progress' });
    const ledgerSession = (runtime: string, nativeSessionId: string, todoId: string, workspaceRoot = 'D:/project') => ({
      id: `${runtime}:${nativeSessionId}:${todoId}`, runtime, nativeSessionId, todoId, workspaceRoot,
      title: todoId, updatedAt: 1, createdAt: 1,
    });
    useWorkLedger.setState({
      cards: [{ ...a, updatedAt: 1 }, { ...b, updatedAt: 2 }],
      sessions: [
        ledgerSession('codex', 'thread-a', b.id),
        ledgerSession('pi', 'thread-a', b.id, 'D:/other-project'),
        ledgerSession('pi', 'thread-a', a.id),
      ],
      hydrate: async () => {}, upsertSession: async () => ({}),
    });
    useAcpAgents.setState({ sessions: {
      b: {
        sessionKey: 'b', acpSessionId: 'native-b', linkedTodoId: b.id, title: '执行 B',
        status: 'running', turnCount: 1, workspaceRoot: 'D:/project-b',
        plan: [
          { content: '检查', priority: 'medium', status: 'completed' },
          { content: '修改', priority: 'medium', status: 'completed' },
          { content: '验证', priority: 'high', status: 'in_progress' },
        ], toolCalls: [], messages: [{ id: 'b', role: 'assistant', text: 'B 的私人结论' }],
        pendingPermissions: [], error: null, createdAt: 1, updatedAt: 1,
      },
    }, activeSessionKey: 'b' });
    useCodexWorkspace.setState({ threads: [] });
    const React = reactModule.default ?? reactModule;
    const { createRoot } = reactDomModule.default ?? reactDomModule;
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'work-context-under-test';
    host.style.cssText = 'height:100vh;display:flex;justify-content:flex-end';
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      onClose: () => {}, activeThreadId: 'thread-a', activeWorkspaceRoot: 'd:\\project',
      currentRuntime: 'pi', initialTab: 'report',
      events: [{ id: 'a-event', type: 'terminal', title: 'A 的执行活动', status: 'completed' }],
      activeArtifact: null,
      artifactThreadId: 'thread-a',
      onTabChange: (tab: string) => (window as any).__updatePortal({ initialTab: tab }),
    };
    const runtime = window as any;
    runtime.__updatePortal = (patch: any) => { Object.assign(props, patch); root.render(React.createElement(component.default, props)); };
    runtime.__deleteWorkB = () => useWorkLedger.setState({ cards: useWorkLedger.getState().cards.filter((card: any) => card.id !== b.id) });
    runtime.__touchWorkA = () => useWorkLedger.setState({ cards: useWorkLedger.getState().cards.map((card: any) => ({ ...card, updatedAt: card.id === a.id ? Date.now() : 1 })) });
    root.render(React.createElement(component.default, props));
  });
}

test('详情随当前会话关联工作，汇报不混入无关 ACP 输出，进度不凭空量化', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#work-context-under-test');
  await expect(portal.getByRole('heading', { name: '工作 A', exact: true })).toBeVisible();
  await expect(portal).not.toContainText('B 的私人结论');
  await expect(portal.getByText('进度未量化')).toBeVisible();
  await expect(portal.getByRole('progressbar')).toHaveCount(0);
  await page.evaluate(() => (window as any).__updatePortal({ activeThreadId: 'unlinked' }));
  await expect(portal.getByText('暂无可汇总的进展汇报')).toBeVisible();
});

test('显式选卡不随后台排序跳转，删除后不回退到其他任务，活动和成果保持归属', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#work-context-under-test');
  await portal.getByRole('button', { name: '任务卡', exact: true }).click();
  await portal.getByRole('button', { name: /工作 A/ }).first().click();
  await portal.getByRole('button', { name: /工作 B/ }).click();
  await page.evaluate(() => (window as any).__touchWorkA());
  await portal.getByRole('button', { name: '汇报', exact: true }).first().click();
  await expect(portal.getByRole('heading', { name: '工作 B', exact: true })).toBeVisible();
  await expect(portal.getByRole('progressbar', { name: '计划步骤完成比例' })).toHaveAttribute('aria-valuenow', '67');
  await portal.getByRole('button', { name: '动态', exact: false }).click();
  await expect(portal).not.toContainText('A 的执行活动');
  await page.evaluate(() => (window as any).__updatePortal({ activeArtifact: { path: 'D:/project/a.md', name: 'A 的成果.md', kind: 'markdown', mimeType: 'text/markdown' } }));
  await portal.getByRole('button', { name: '产物', exact: true }).click();
  await expect(portal).not.toContainText('A 的成果.md');
  await page.evaluate(() => (window as any).__deleteWorkB());
  await portal.getByRole('button', { name: '汇报', exact: true }).first().click();
  await expect(portal.getByText('暂无可汇总的进展汇报')).toBeVisible();
  await portal.getByRole('button', { name: '任务卡', exact: true }).click();
  await expect(portal.getByText('所选任务已不存在')).toBeVisible();
  await expect(portal.getByRole('button', { name: '选择任务' })).toBeVisible();
});

test('后台新成果不打断阅读汇报，用户主动打开成果仍可切换', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#work-context-under-test');
  await expect(portal.getByRole('heading', { name: '工作 A', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__updatePortal({
    activeArtifact: { path: 'D:/project/a.md', name: 'A 的成果.md', kind: 'markdown', mimeType: 'text/markdown' },
  }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(portal.getByRole('heading', { name: '工作 A', exact: true })).toBeVisible();
  await expect(portal.getByText('A 的成果.md')).toHaveCount(0);
  await page.evaluate(() => (window as any).__updatePortal({ initialTab: 'artifact' }));
  await expect(portal.getByText('A 的成果.md')).toBeVisible();
  await portal.getByRole('button', { name: '汇报', exact: true }).first().click();
  await expect(portal.getByRole('heading', { name: '工作 A', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__updatePortal({ initialTab: 'artifact' }));
  await expect(portal.getByText('A 的成果.md')).toBeVisible();
});
