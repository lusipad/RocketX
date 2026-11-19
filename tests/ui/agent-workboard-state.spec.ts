import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountBoard(page: Page) {
  await bootAuthenticated(page);
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, domModule, { default: WorkKanbanBoard }, { useWorkLedger }, { useCodexWorkspace }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkKanbanBoard.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/codexWorkspace.ts'),
    ]);
    const card = await useWorkLedger.getState().createCard({ title: '已有的缓存工作', stage: 'in_progress' });
    const runtime = window as any;
    runtime.__workBoardRetryCount = 0;
    useWorkLedger.setState({ cards: [], hydrated: false, loading: true, lastError: null, hydrate: async () => {
      if (runtime.__workBoardFailureReady) {
        runtime.__workBoardRetryCount += 1;
        useWorkLedger.setState({ loading: false, lastError: null, hydrated: true });
      }
    } });
    useCodexWorkspace.setState({ threads: [] });
    runtime.__setWorkBoardState = (patch: any) => useWorkLedger.setState(patch);
    runtime.__showCachedWorkFailure = () => {
      runtime.__workBoardFailureReady = true;
      useWorkLedger.setState({ cards: [card], hydrated: true, loading: false, lastError: '数据库暂时无法读取' });
    };
    runtime.__loadManyWorks = () => useWorkLedger.setState({
      cards: Array.from({ length: 100 }, (_, index) => ({
        ...card, id: `many-${index}`, title: `工作 ${index}：修复多执行器并行处理时状态同步与任务详情归属不一致的问题，保留已有成果并汇报验证依据`,
        createdAt: index + 1, updatedAt: index + 1, state: { ...card.state, todoId: `many-${index}` },
      })), hydrated: true, loading: false, lastError: null,
    });
    const host = document.createElement('div');
    host.id = 'workboard-state-under-test';
    host.style.cssText = 'height:100vh;display:flex';
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    document.body.append(host);
    (domModule.default ?? domModule).createRoot(host).render((reactModule.default ?? reactModule).createElement(WorkKanbanBoard));
  });
}

test('工作台区分加载、缓存读取失败和真实空，重试不会丢失已缓存工作', async ({ page }) => {
  await mountBoard(page);
  const board = page.locator('#workboard-state-under-test');
  await expect(board.getByText('正在读取工作记录')).toBeVisible();
  await expect(board).not.toContainText('智能调度就绪');
  await expect(board.getByText(/^暂无.*卡片$/)).toHaveCount(0);
  await page.evaluate(() => (window as any).__showCachedWorkFailure());
  await expect(board.getByRole('alert')).toContainText('数据库暂时无法读取');
  await expect(board.getByRole('alert')).toContainText('缓存');
  await expect(board.getByText('已有的缓存工作', { exact: true })).toBeVisible();
  await board.getByRole('button', { name: '重试读取工作记录' }).click();
  await expect(board.getByRole('alert')).toHaveCount(0);
  await expect(board.getByText('已有的缓存工作', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__workBoardRetryCount)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__setWorkBoardState({ cards: [], hydrated: true, loading: false }));
  await expect(board.getByText('还没有工作记录', { exact: true })).toBeVisible();
  await board.getByRole('button', { name: /添加已有会话/ }).click();
  await expect(board).toContainText('本机最近 300 条会话');
  await expect(board).not.toContainText('近期本机会话已全部上板');
});

test('百项长标题工作在半屏与缩放下可查找并用键盘打开', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await mountBoard(page);
  await page.evaluate(() => { (window as any).__loadManyWorks(); document.documentElement.style.zoom = '1.25'; });
  const board = page.locator('#workboard-state-under-test');
  await expect(board.getByRole('button', { name: /^工作 \d+：/ })).toHaveCount(100);
  await expect(board.getByRole('button', { name: /需我处理/ })).toBeVisible();
  await expect(board.getByRole('button', { name: /添加已有会话/ })).toBeVisible();
  const card = board.getByRole('button', { name: /^工作 99：/ });
  await card.focus();
  await card.press('Enter');
  await expect(board.getByRole('button', { name: /^工作 99：/, includeHidden: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(board.getByRole('heading', { name: /^工作 99：/ })).toBeVisible();
  await board.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await board.getByRole('button', { name: '查找', exact: true }).click();
  await board.getByRole('searchbox', { name: '查找工作与成果' }).fill('工作 42：');
  const result = board.getByRole('list', { name: '检索结果' }).getByRole('button', { name: /^工作 42：/ });
  await result.focus();
  await result.press('Enter');
  await expect(board.getByRole('heading', { name: /^工作 42：/ })).toBeVisible();
  await board.getByRole('button', { name: '返回我的工作', exact: true }).click();
  const kanban = board.getByRole('region', { name: '工作看板', exact: true });
  await expect(kanban).toHaveAttribute('data-layout', 'list');
  await expect(kanban.getByRole('region')).toHaveCount(1);
  await expect(kanban.getByRole('region', { name: '待开始', exact: true }).getByRole('button', { name: /^工作 \d+：/ })).toHaveCount(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workboard-100-half-screen-125.png') });
});

test('协作区以管家和工作台为主入口，执行器与原有业务入口可直接进入', async ({ page }) => {
  await bootAuthenticated(page);
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, domModule, { default: History }, { useUI }, { useCodexWorkspace }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/ButlerConversationHistory.tsx'), load('/src/stores/ui.ts'), load('/src/stores/codexWorkspace.ts'),
    ]);
    useCodexWorkspace.setState({ hydrate: () => {}, status: 'ready', threads: [], workspaceRoots: [], workspaceRoot: '' });
    useUI.setState({ aiRuntimeProvider: 'pi', butlerView: 'conversation' });
    (window as any).__readNavigationState = () => ({ view: useUI.getState().butlerView, module: useUI.getState().module, tab: useUI.getState().workbenchTab });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'navigation-under-test';
    host.style.height = '100vh';
    document.body.append(host);
    (domModule.default ?? domModule).createRoot(host).render((reactModule.default ?? reactModule).createElement(History));
  });
  const nav = page.locator('#navigation-under-test').getByRole('navigation', { name: 'AI 协作', exact: true });
  const labels = await nav.getByRole('button').allTextContents();
  expect(labels.slice(0, 2).map((text) => text.trim())).toEqual(['管家', '我的工作']);
  await nav.getByRole('button', { name: '我的工作', exact: true }).click();
  await expect(nav.getByRole('button', { name: '我的工作', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByText('更多功能', { exact: true }).click();
  await nav.getByRole('button', { name: '执行器与会话', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__readNavigationState().view)).toBe('acp-hub');
  await nav.getByRole('button', { name: '拉取请求', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__readNavigationState())).toMatchObject({ module: 'workbench', tab: 'prs' });
});
