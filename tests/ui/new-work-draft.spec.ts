import { expect, test, type Page } from '@playwright/test';

async function mountNewWork(page: Page) {
  await page.route('**/src/main.tsx', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    await load('/src/styles.css');
    const [react, dom, board, { useWorkLedger, beginWorkLedgerAccount }, { useTodos }, { useAuth }, { useCodexWorkspace }, account, bridge, { resolveButlerAccountScope }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'), load('/src/components/WorkKanbanBoard.tsx'),
      load('/src/stores/workLedger.ts'), load('/src/stores/todos.ts'), load('/src/stores/auth.ts'), load('/src/stores/codexWorkspace.ts'),
      load('/src/platform/butlerAccountReady.ts'), load('/src/agent/superAgentBridge.ts'), load('/src/stores/butlerMemory.ts'),
    ]);
    const React = react.default ?? react; const runtime = window as any;
    localStorage.setItem('rcx-owner', 'draft-account-a');
    useAuth.setState({ localMode: true, status: 'authed', user: { _id: 'draft-account-a' } });
    useCodexWorkspace.setState({ scope: 'draft-runtime-a', threads: [], threadStates: {}, workspaceRoot: 'D:/unrelated' });
    beginWorkLedgerAccount('draft-account-a')();
    let generation = 1;
    account.beginButlerAccountSelection(resolveButlerAccountScope()).activate({ accountScope: resolveButlerAccountScope(), generation });
    useTodos.setState({ todos: [], hydrated: true });
    useWorkLedger.setState({ cards: [], sessions: [], links: [], actions: [], events: [], evidences: [], hydrated: true,
      loading: false, lastError: null, hydrate: async () => {} });
    bridge.setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [] });
    const originalCreate = useWorkLedger.getState().createCard;
    const originalLink = useWorkLedger.getState().upsertLink;
    runtime.__draftCreates = []; runtime.__draftLinks = []; runtime.__delayCreate = false; runtime.__failLink = false;
    useWorkLedger.setState({
      createCard: async (input: any) => {
        runtime.__draftCreates.push(structuredClone(input));
        const card = await originalCreate(input);
        if (runtime.__delayCreate) await new Promise<void>((resolve) => { runtime.__releaseCreate = resolve; });
        return card;
      },
      upsertLink: async (input: any) => {
        runtime.__draftLinks.push(structuredClone(input));
        if (runtime.__failLink) { runtime.__failLink = false; throw new Error('目录保存暂时失败'); }
        return originalLink(input);
      },
    });
    runtime.__switchDraftScope = (kind: 'account' | 'runtime', suffix: 'a' | 'b') => {
      if (kind === 'account') {
        localStorage.setItem('rcx-owner', `draft-account-${suffix}`);
        useAuth.setState({ user: { _id: `draft-account-${suffix}` } });
        beginWorkLedgerAccount(`draft-account-${suffix}`)();
        const scope = resolveButlerAccountScope();
        account.beginButlerAccountSelection(scope).activate({ accountScope: scope, generation: ++generation });
      } else useCodexWorkspace.setState({ scope: `draft-runtime-${suffix}` });
    };
    function Harness() {
      const [view, setView] = React.useState('board');
      return React.createElement('div', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
        React.createElement('nav', { 'aria-label': '测试主视图' },
          React.createElement('button', { onClick: () => setView('butler') }, '管家'),
          React.createElement('button', { onClick: () => setView('board') }, '我的工作')),
        view === 'board' ? React.createElement(board.default) : React.createElement('p', null, '管家视图'));
    }
    const host = document.getElementById('root')!; host.style.cssText = 'height:100vh';
    (dom.default ?? dom).createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.getByRole('button', { name: '新建工作', exact: true })).toBeVisible();
}

const form = (page: Page) => page.getByRole('form', { name: '交代新工作', exact: true });
async function fillDraft(page: Page, goal: string, workspace: string) {
  if (!await form(page).isVisible()) await page.getByRole('button', { name: '新建工作', exact: true }).click();
  await form(page).getByLabel('要完成什么').fill(goal);
  await form(page).getByLabel('工作目录', { exact: true }).fill(workspace);
}
async function remount(page: Page) {
  const navigation = page.getByRole('navigation', { name: '测试主视图' });
  await navigation.getByRole('button', { name: '管家', exact: true }).click();
  await expect(page.getByText('管家视图', { exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: '我的工作', exact: true }).click();
}

test('新工作目标和显式目录在管家与看板卸载重挂后保留，收起状态也保留', async ({ page }) => {
  await mountNewWork(page); await fillDraft(page, '调查登录失败，先保留复现证据', 'D:/explicit-project');
  await remount(page);
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByLabel('要完成什么')).toHaveValue('调查登录失败，先保留复现证据');
  await expect(form(page).getByLabel('工作目录', { exact: true })).toHaveValue('D:/explicit-project');
  await form(page).getByRole('button', { name: '收起，保留新工作草稿' }).click();
  await remount(page);
  await expect(form(page)).toHaveCount(0);
  await page.getByRole('button', { name: '新建工作', exact: true }).click();
  await expect(form(page).getByLabel('要完成什么')).toHaveValue('调查登录失败，先保留复现证据');
  expect(await page.evaluate(() => (window as any).__draftCreates)).toEqual([]);
});

for (const kind of ['account', 'runtime'] as const) {
  test(`${kind}切换有独立草稿，返回后仍是各自目标和目录`, async ({ page }) => {
    await mountNewWork(page); await fillDraft(page, 'A 的目标', 'D:/a');
    await page.evaluate((kind) => (window as any).__switchDraftScope(kind, 'b'), kind);
    await expect(form(page)).toHaveCount(0);
    await fillDraft(page, 'B 的目标', 'D:/b');
    await page.evaluate((kind) => (window as any).__switchDraftScope(kind, 'a'), kind);
    await expect(form(page).getByLabel('要完成什么')).toHaveValue('A 的目标');
    await expect(form(page).getByLabel('工作目录', { exact: true })).toHaveValue('D:/a');
    await page.evaluate((kind) => (window as any).__switchDraftScope(kind, 'b'), kind);
    await expect(form(page).getByLabel('要完成什么')).toHaveValue('B 的目标');
    await expect(form(page).getByLabel('工作目录', { exact: true })).toHaveValue('D:/b');
  });

  test(`保存期间切换${kind}后迟到回执不绑定新范围，返回原稿幂等重试`, async ({ page }) => {
    await mountNewWork(page); await fillDraft(page, 'A 的待保存工作', 'D:/a');
    await page.evaluate(() => { (window as any).__delayCreate = true; });
    await form(page).getByRole('button', { name: '加入待开始', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseCreate)).toBe('function');
    await page.evaluate((kind) => (window as any).__switchDraftScope(kind, 'b'), kind);
    await fillDraft(page, 'B 的独立草稿', 'D:/b');
    await page.evaluate(() => { (window as any).__delayCreate = false; (window as any).__releaseCreate(); });
    await expect(form(page).getByLabel('要完成什么')).toHaveValue('B 的独立草稿');
    await expect(form(page).getByLabel('工作目录', { exact: true })).toHaveValue('D:/b');
    await page.evaluate((kind) => (window as any).__switchDraftScope(kind, 'a'), kind);
    await expect(form(page).getByRole('button', { name: '加入待开始', exact: true })).toBeEnabled();
    await expect(form(page).getByLabel('要完成什么')).toHaveValue('A 的待保存工作');
    expect(await page.evaluate(() => (window as any).__draftLinks)).toEqual([]);
    await remount(page);
    await form(page).getByRole('button', { name: '加入待开始', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    const calls = await page.evaluate(() => ({ creates: (window as any).__draftCreates, links: (window as any).__draftLinks }));
    expect(calls.creates).toHaveLength(2); expect(calls.creates[0].requestId).toBe(calls.creates[1].requestId);
    expect(calls.links).toEqual([expect.objectContaining({ repo: 'D:/a' })]);
  });
}

test('保存中跨视图后仍显示原请求，不重复创建，成功只清除已保存原稿', async ({ page }) => {
  await mountNewWork(page); await fillDraft(page, '保存中的第一件工作', 'D:/first');
  await page.evaluate(() => { (window as any).__delayCreate = true; });
  await form(page).getByRole('button', { name: '加入待开始', exact: true }).click();
  await remount(page);
  await expect(form(page).getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
  await expect(form(page).getByLabel('要完成什么')).toHaveValue('保存中的第一件工作');
  await page.evaluate(() => { (window as any).__delayCreate = false; (window as any).__releaseCreate(); });
  await expect(form(page)).toHaveCount(0);
  await page.getByRole('button', { name: '新建工作', exact: true }).click();
  await expect(form(page).getByLabel('要完成什么')).toHaveValue('');
  const calls = await page.evaluate(() => ({ creates: (window as any).__draftCreates, links: (window as any).__draftLinks }));
  expect(calls.creates).toHaveLength(1); expect(calls.links).toHaveLength(1);
  expect(calls.links[0].repo).toBe('D:/first');
});

test('旧保存跨视图完成时保留后来编辑的另一份目标和目录，不关闭或跳走', async ({ page }) => {
  await mountNewWork(page); await fillDraft(page, '第一件工作', 'D:/first');
  await page.evaluate(() => { (window as any).__delayCreate = true; });
  await form(page).getByRole('button', { name: '加入待开始', exact: true }).click();
  await remount(page); await fillDraft(page, '第二件未保存草稿', 'D:/second');
  await page.evaluate(() => { (window as any).__delayCreate = false; (window as any).__releaseCreate(); });
  await expect(form(page).getByRole('button', { name: '加入待开始', exact: true })).toBeEnabled();
  await expect(form(page).getByLabel('要完成什么')).toHaveValue('第二件未保存草稿');
  await expect(form(page).getByLabel('工作目录', { exact: true })).toHaveValue('D:/second');
  await expect(page.getByRole('complementary', { name: '工作详情', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__draftLinks)).toEqual([expect.objectContaining({ repo: 'D:/first' })]);
});

test('工作已创建但目录保存失败后跨视图重试复用同一请求，只保留一张工作卡', async ({ page }) => {
  await mountNewWork(page); await fillDraft(page, '目录写入需要重试', 'D:/retry');
  await page.evaluate(() => { (window as any).__failLink = true; });
  await form(page).getByRole('button', { name: '加入待开始', exact: true }).click();
  await expect(form(page)).toContainText('目录保存暂时失败');
  await remount(page);
  await expect(form(page).getByLabel('要完成什么')).toHaveValue('目录写入需要重试');
  await form(page).getByRole('button', { name: '加入待开始', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  const calls = await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    return { creates: (window as any).__draftCreates, cards: useWorkLedger.getState().cards, links: useWorkLedger.getState().links };
  });
  expect(calls.creates).toHaveLength(2); expect(calls.creates[0].requestId).toBe(calls.creates[1].requestId);
  expect(calls.cards).toHaveLength(1); expect(calls.links).toHaveLength(1);
  expect(calls.links[0].repo).toBe('D:/retry');
});
