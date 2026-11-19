import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountConversation(page: Page, options: { history?: boolean; view?: string } = {}) {
  await bootAuthenticated(page);
  await page.evaluate(async ({ history = false, view = 'conversation' }) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [React, ReactDOM, { default: Conversation }, { useCodexWorkspace }, { useUI }, { useAgentEnvironments }, { useSharedAgent }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/ButlerConversation.tsx'), load('/src/stores/codexWorkspace.ts'),
      load('/src/stores/ui.ts'), load('/src/stores/agentEnvironments.ts'), load('/src/stores/sharedAgent.ts'),
    ]);
    const runtime = window as any;
    runtime.__navigationSends = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: () => 0, unregisterCallback: () => {}, invoke: async () => null,
    } });
    const root = 'D:/work-first-test/butler';
    useAgentEnvironments.setState({ environments: [], bindings: [] });
    useSharedAgent.setState({ sessions: {}, remoteCards: {} });
    useUI.setState({ aiRuntimeProvider: 'pi', butlerSidebarCollapsed: false, butlerView: view });
    const thread = { id: 'prior-work', name: '整理发布说明', preview: '保留真实工作', cwd: root, updatedAt: 1_793_500_000, status: { type: 'idle' } };
    useCodexWorkspace.setState({
      scope: 'work-first-navigation-test', workspaceRoot: root, workspaceRoots: [root, 'D:/work-first-test/temporary'],
      defaultWorkspaceRoot: 'D:/work-first-test/temporary', butlerWorkspaceRoot: root,
      activeThreadId: history ? thread.id : undefined, activeTurnId: undefined,
      status: 'ready', error: null, threads: history ? [thread] : [], threadStates: {},
      messages: [], events: [], models: [], pendingRequests: [], queuedMessages: [], streamingText: '',
      hydrate: () => {}, connect: async () => {},
      ensureDefaultWorkspace: async () => root,
      startThread: async () => useCodexWorkspace.setState({ activeThreadId: 'new-work', threads: [thread, { ...thread, id: 'new-work', name: '新事情' }] }),
      resumeThread: async (id: string) => useCodexWorkspace.setState({ activeThreadId: id }),
      send: async (text: string) => runtime.__navigationSends.push(text),
    });
    runtime.__setNavigationView = (nextView: string) => useUI.setState({ butlerView: nextView });
    runtime.__readNavigationView = () => useUI.getState().butlerView;
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'work-first-conversation-under-test'; host.style.cssText = 'height:100vh;display:flex';
    document.body.append(host);
    (ReactDOM.default ?? ReactDOM).createRoot(host).render((React.default ?? React).createElement(Conversation, { embedded: true }));
  }, options);
  return page.locator('#work-first-conversation-under-test');
}

test('默认导航突出管家与我的工作，管理按需展开且没有空分组', async ({ page }) => {
  const surface = await mountConversation(page);
  const nav = surface.getByRole('navigation', { name: 'AI 协作', exact: true });
  expect(await nav.getByRole('button').allTextContents()).toEqual(['管家', '我的工作']);
  await expect(surface.getByRole('button', { name: '执行器与会话', exact: true })).toBeHidden();
  await expect(surface.getByText('系统工作区', { exact: true })).toHaveCount(0);
  await expect(surface.getByText('个人项目', { exact: true })).toHaveCount(0);
  await expect(surface.getByRole('region', { name: '共享 AI 托管' })).toHaveCount(0);
  await surface.locator('.work-first-more-features > summary').click();
  await expect(nav.getByRole('button', { name: '执行器与会话', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: '执行器与会话', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__readNavigationView())).toBe('acp-hub');
  await expect(nav.getByRole('button', { name: '执行器与会话', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('直接进入管理页时展开对应入口，并保留真实当前历史', async ({ page }) => {
  const surface = await mountConversation(page, { history: true, view: 'plugins' });
  await expect(surface.getByRole('button', { name: '插件', exact: true })).toBeVisible();
  await expect(surface.getByRole('button', { name: '插件', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(surface.getByRole('navigation', { name: 'Codex 对话历史' }).getByRole('button', { name: /整理发布说明/ }).first()).toBeVisible();
  await expect(surface.getByRole('region', { name: '项目：临时会话' })).toHaveCount(0);
  await expect(surface.locator('.work-first-composer-target')).toContainText('发给管家·整理发布说明');
});

test('示例只补入草稿并聚焦，发送前保留用户已写的内容', async ({ page }) => {
  const surface = await mountConversation(page);
  const input = surface.getByRole('textbox', { name: '给管家的要求' });
  const suggestion = surface.getByRole('button', { name: '检查项目改动 看清改了什么、哪里有问题' });
  await expect(suggestion).toBeEnabled();
  await input.fill('请先不要改文件。');
  await suggestion.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('请先不要改文件。\n检查当前项目的改动，说明已经完成什么、还有哪些问题需要处理。');
  expect(await page.evaluate(() => (window as any).__navigationSends)).toEqual([]);
  await expect(surface.getByRole('heading', { name: '有什么事交给我？' })).toBeVisible();
  await expect(surface.getByText('启用本地语音（可选）', { exact: true })).toBeHidden();
  await surface.getByRole('button', { name: '发送', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__navigationSends)).toEqual(['请先不要改文件。\n检查当前项目的改动，说明已经完成什么、还有哪些问题需要处理。']);
});

test('新管家对话有独立输入对象，返回旧对话仍保留草稿', async ({ page }) => {
  const surface = await mountConversation(page, { history: true });
  const input = surface.getByRole('textbox', { name: '给管家的要求' });
  await input.fill('这是发布说明尚未发送的补充');
  await surface.getByRole('button', { name: '新管家对话' }).click();
  await expect(surface.locator('.work-first-composer-target')).toContainText('新事情');
  await expect(input).toHaveValue('');
  await surface.getByRole('navigation', { name: 'Codex 对话历史' }).getByRole('button', { name: /整理发布说明/ }).first().click();
  await expect(input).toHaveValue('这是发布说明尚未发送的补充');
});

for (const changedScope of ['account', 'runtime'] as const) {
  test(`准备新事情期间切换${changedScope}，旧入口不在新账户创建工作`, async ({ page }) => {
    const surface = await mountConversation(page, { history: true });
    await page.evaluate(async () => {
      const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
      const runtime = window as any;
      runtime.__newWorkStarts = 0;
      useCodexWorkspace.setState({
        ensureDefaultWorkspace: () => new Promise((resolve) => { runtime.__releaseNewWorkPreparation = resolve; }),
        startThread: async () => { runtime.__newWorkStarts += 1; },
      });
    });
    await surface.getByRole('button', { name: '新管家对话' }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__releaseNewWorkPreparation))).toBe(true);
    await page.evaluate(async (changedScope) => {
      const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
      const [{ useAuth }, { useCodexWorkspace }, { useUI }] = await Promise.all([
        load('/src/stores/auth.ts'), load('/src/stores/codexWorkspace.ts'), load('/src/stores/ui.ts'),
      ]);
      if (changedScope === 'account') useAuth.setState({ user: { ...useAuth.getState().user, _id: 'different-work-account' } });
      else useCodexWorkspace.setState({ scope: 'different-runtime-scope' });
      useUI.setState({ butlerView: 'kanban' });
      (window as any).__releaseNewWorkPreparation('D:/work-first-test/butler');
    }, changedScope);
    await expect(surface.getByRole('button', { name: '我的工作', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => (window as any).__newWorkStarts)).toBe(0);
  });
}

test('窄屏导航展开更多或搜索时不关闭，完成导航或Escape后返回输入页面', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const surface = await mountConversation(page);
  const opener = surface.getByRole('button', { name: '打开任务列表' });
  await opener.click();
  const drawer = surface.getByRole('dialog', { name: '任务列表', exact: true });
  await drawer.locator('.work-first-more-features > summary').click();
  await expect(drawer.getByRole('button', { name: '执行器与会话', exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: '搜索对话', exact: true }).click();
  await expect(drawer.getByRole('searchbox', { name: '搜索对话' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await drawer.getByRole('button', { name: '我的工作', exact: true }).click();
  await expect(drawer).toBeHidden();
  expect(await page.evaluate(() => (window as any).__readNavigationView())).toBe('kanban');
});
