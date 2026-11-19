import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountReader(page: Page, initialCount = 60) {
  await page.evaluate(async (initialCount) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, domModule, { useStickToBottom }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/lib/stickToBottom.ts'),
    ]);
    const React = reactModule.default ?? reactModule;
    const host = document.createElement('div');
    host.id = 'reader-under-test';
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    document.body.append(host);
    function Reader() {
      const [target, setTarget] = React.useState('account-a|project-a|thread-a');
      const [count, setCount] = React.useState(initialCount);
      const { scrollRef, onScroll } = useStickToBottom([count], target);
      (window as any).__selectReader = setTarget;
      (window as any).__appendReader = () => setCount((current: number) => current + 1);
      (window as any).__setReaderCount = setCount;
      return React.createElement('div', { ref: scrollRef, onScroll, role: 'log', style: { height: 300, overflow: 'auto' } },
        Array.from({ length: count }, (_, index) => React.createElement('div', { key: index, style: { height: 40 } }, `历史消息 ${index}`)),
      );
    }
    (domModule.default ?? domModule).createRoot(host).render(React.createElement(Reader));
  }, initialCount);
  await expect(page.getByRole('log')).toBeVisible();
}

test('阅读位置按账号、项目和会话恢复，后台追加不会拉走历史阅读者', async ({ page }) => {
  await bootAuthenticated(page);
  await mountReader(page);
  const log = page.getByRole('log');
  await log.evaluate((element) => { element.scrollTop = 420; element.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => (window as any).__appendReader());
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(420);
  await page.evaluate(() => (window as any).__selectReader('account-a|project-a|thread-b'));
  await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
  await log.evaluate((element) => { element.scrollTop = 820; element.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => (window as any).__selectReader('account-a|project-a|thread-a'));
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(420);
  await page.evaluate(() => (window as any).__selectReader('account-b|project-a|thread-a'));
  await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
  await page.evaluate(() => (window as any).__selectReader('account-a|project-b|thread-a'));
  await log.evaluate((element) => { element.scrollTop = 120; element.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => (window as any).__selectReader('account-a|project-a|thread-b'));
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(820);
  await page.reload();
  await mountReader(page);
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(420);
});

test('主动回到底部后恢复跟随，并保留到下一次进入', async ({ page }) => {
  await bootAuthenticated(page);
  await mountReader(page);
  const log = page.getByRole('log');
  await log.evaluate((element) => { element.scrollTop = 200; element.dispatchEvent(new Event('scroll')); });
  await log.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => (window as any).__appendReader());
  await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
});

test('历史延迟加载时保留待恢复位置，内容到达后再定位', async ({ page }) => {
  await bootAuthenticated(page);
  await mountReader(page);
  const log = page.getByRole('log');
  await log.evaluate((element) => { element.scrollTop = 900; element.dispatchEvent(new Event('scroll')); });
  await page.reload();
  await mountReader(page, 0);
  await page.evaluate(() => (window as any).__setReaderCount(60));
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(900);
});

for (const kind of ['butler', 'acp'] as const) {
  test(`${kind} 真实会话切换恢复阅读位置，后台更新不抢焦点`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await bootAuthenticated(page);
    await page.evaluate(async (kind) => {
      const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
      const [reactModule, domModule, { useUI }, { useCodexWorkspace }, { useAcpAgents }, component] = await Promise.all([
        load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
        load('/src/stores/ui.ts'), load('/src/stores/codexWorkspace.ts'), load('/src/stores/acpAgents.ts'),
        load(kind === 'butler' ? '/src/components/ButlerConversation.tsx' : '/src/components/AcpWorkspaceSurface.tsx'),
      ]);
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true, value: { invoke: async () => null, transformCallback: () => 0, unregisterCallback: () => {} },
      });
      const messages = Array.from({ length: 60 }, (_, index) => ({ id: `message-${index}`, role: 'user', text: `历史要求 ${index}：请检查当前工作并保留验证依据。` }));
      useUI.setState({ aiRuntimeProvider: 'pi', butlerSidebarCollapsed: true });
      useCodexWorkspace.setState({
        scope: 'reading-account', workspaceRoot: 'D:/project', workspaceRoots: ['D:/project'],
        activeThreadId: 'a', status: 'ready', threads: [], messages, events: [],
        pendingRequests: [], queuedMessages: [], streamingText: '',
      });
      const session = (key: string) => ({
        sessionKey: key, agentId: 'agent', agentName: 'Test Agent', workspaceRoot: 'D:/project',
        acpSessionId: key, status: 'ready', availableCommands: [], modes: null, models: null,
        messages, plan: [], toolCalls: [], pendingPermissions: [], streamingText: '',
        streamingThought: '', stderrLogs: [], turnCount: 1, createdAt: 1, updatedAt: 1,
      });
      useAcpAgents.setState({
        agents: [{ id: 'agent', name: 'Test Agent', preset: 'custom', args: [], enabled: true }],
        sessions: { a: session('a'), b: session('b') }, activeSessionKey: 'a',
        hydrate: async () => {}, discoverLocalSessions: async () => [],
      });
      (window as any).__selectActualReader = (key: string) => {
        useCodexWorkspace.setState({ activeThreadId: key, messages: [...messages] });
        useAcpAgents.setState({ activeSessionKey: key });
      };
      (window as any).__appendActualReader = () => {
        const added = { id: 'new', role: 'assistant', text: '新增执行结果' };
        useCodexWorkspace.setState({ messages: [...messages, added] });
        useAcpAgents.setState((state: any) => ({ sessions: { ...state.sessions, a: { ...state.sessions.a, messages: [...messages, added] } } }));
      };
      (window as any).__setReaderRuntime = (patch: any) => useCodexWorkspace.setState(patch);
      (window as any).__showExpiredApprovals = async () => {
        const { resolveButlerAccountScope } = await load('/src/stores/butlerMemory.ts');
        const accountScope = resolveButlerAccountScope();
        useAcpAgents.setState({ expiredPermissions: [
          { accountScope, requestId: 'own-expired', status: 'expired' },
          { accountScope: 'another-account', requestId: 'other-expired', status: 'expired' },
        ], loading: false, lastError: '执行器读取失败' });
      };
      document.querySelector<HTMLElement>('#root')!.style.display = 'none';
      const host = document.createElement('div');
      host.id = 'actual-reader-under-test';
      host.style.cssText = 'height:100vh;display:flex;flex-direction:column';
      document.body.append(host);
      (domModule.default ?? domModule).createRoot(host).render((reactModule.default ?? reactModule).createElement(component.default));
    }, kind);
    const host = page.locator('#actual-reader-under-test');
    const transcript = kind === 'butler' ? host.locator('main.codex-native-transcript') : host.getByRole('log', { name: '执行器会话记录' });
    await expect(host.locator('textarea').first()).toBeEditable().catch((error) => {
      throw new Error(`${pageErrors.join('\n')}\n${String(error)}`);
    });
    await transcript.evaluate((element) => { element.scrollTop = 330; element.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => (window as any).__selectActualReader('b'));
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBe(0);
    await transcript.evaluate((element) => { element.scrollTop = 730; element.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => (window as any).__selectActualReader('a'));
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(330);
    await host.locator('textarea').first().focus();
    await page.evaluate(() => (window as any).__appendActualReader());
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(330);
    await expect(host.locator('textarea').first()).toBeFocused();
    if (kind === 'butler') {
      await page.evaluate(() => (window as any).__setReaderRuntime({ status: 'connecting' }));
      await expect(transcript).toContainText('当前保留已读取的历史记录');
      await expect(transcript).toContainText('历史要求 0');
      await page.evaluate(() => (window as any).__setReaderRuntime({ status: 'unavailable', error: '本地执行器已断开' }));
      await expect(transcript.getByRole('button', { name: '重新连接执行器' })).toBeVisible();
      await expect(transcript).toContainText('历史要求 0');
    } else {
      await page.evaluate(() => (window as any).__showExpiredApprovals());
      await expect(host).toContainText('有 1 条旧权限请求已失效');
      await expect(host).not.toContainText('有 2 条旧权限请求已失效');
      await expect(host.getByRole('alert')).toContainText('当前保留已收到的数据');
      await expect(transcript).toContainText('历史要求 0');
      await expect(host.getByRole('button', { name: '重新加载执行器与会话' })).toBeVisible();
    }
  });
}
