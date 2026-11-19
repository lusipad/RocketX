import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountPi(page: Page, status: 'connecting' | 'unavailable', configured = true) {
  await bootAuthenticated(page);
  await page.evaluate(async ({ status, configured }) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [React, ReactDOM, { default: Conversation }, { useCodexWorkspace }, { useUI }, { PI_CONFIGURED_STORAGE_KEY }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/ButlerConversation.tsx'), load('/src/stores/codexWorkspace.ts'),
      load('/src/stores/ui.ts'), load('/src/lib/runtimeMode.ts'),
    ]);
    if (configured) localStorage.setItem(PI_CONFIGURED_STORAGE_KEY, '1');
    else localStorage.removeItem(PI_CONFIGURED_STORAGE_KEY);
    const runtime = window as any;
    runtime.__piReconnects = 0;
    runtime.__piExtraConnects = 0;
    runtime.__piConfigWrites = 0;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: () => 0, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === 'pi_config_write') runtime.__piConfigWrites += 1;
        if (command === 'pi_runtime_probe') return { ready: true, version: '1.5.0', source: 'bundled' };
        return null;
      },
    } });
    useUI.setState({ aiRuntimeProvider: 'pi', butlerSidebarCollapsed: true });
    useCodexWorkspace.setState({
      scope: 'pi-recovery-test', workspaceRoot: 'D:/pi-recovery-test', workspaceRoots: ['D:/pi-recovery-test'],
      activeThreadId: undefined, status, error: 'Pi 模型目录加载失败：本地进程已退出',
      threads: [], messages: [], events: [], models: [], pendingRequests: [], queuedMessages: [], streamingText: '',
      hydrate: () => {},
      reconnectRuntime: async () => {
        runtime.__piReconnects += 1;
        useCodexWorkspace.setState({ status: 'ready', error: null });
      },
      connect: async () => {
        runtime.__piExtraConnects += 1;
        useCodexWorkspace.setState({ status: 'connecting' });
      },
    });
    const host = document.createElement('div');
    host.id = 'pi-connection-under-test'; host.style.cssText = 'height:100vh;display:flex';
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    document.body.append(host);
    const ReactApi = React.default ?? React;
    (ReactDOM.default ?? ReactDOM).createRoot(host).render(ReactApi.createElement(ReactApi.StrictMode, null, ReactApi.createElement(Conversation, { embedded: true })));
  }, { status, configured });
}

test('连接失败展示原因，可使用保存的配置重试而不重填Key', async ({ page }) => {
  await mountPi(page, 'unavailable');
  const surface = page.locator('#pi-connection-under-test');
  await expect(surface.getByRole('alert')).toContainText('Pi 模型目录加载失败：本地进程已退出');
  await expect(surface.locator('input[type="password"]')).not.toBeVisible();
  await page.screenshot({ path: '.omx/logs/pi-connect-fix-20261116/connection-recovery.png' });
  await surface.getByRole('button', { name: '使用已保存配置重试' }).click();
  await expect(surface.getByRole('heading', { name: '有什么事交给我？' })).toBeVisible();
  expect(await page.evaluate(() => ({ reconnects: (window as any).__piReconnects, configWrites: (window as any).__piConfigWrites })))
    .toEqual({ reconnects: 1, configWrites: 0 });
});

test('连接中可以重新连接，避免只能等待转圈', async ({ page }) => {
  await mountPi(page, 'connecting');
  const surface = page.locator('#pi-connection-under-test');
  await expect(surface.getByRole('heading', { name: '正在连接 Pi' })).toBeVisible();
  await surface.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(surface.getByRole('heading', { name: '有什么事交给我？' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__piReconnects)).toBe(1);
});

test('首次保存DeepSeek配置只建立一次连接，成功后不再次进入连接中', async ({ page }) => {
  await mountPi(page, 'unavailable', false);
  const surface = page.locator('#pi-connection-under-test');
  await surface.locator('input[type="password"]').fill('sk-fake-local-ui-test');
  await surface.getByRole('button', { name: '立即启用并开始对话' }).click();
  await expect(surface.getByRole('heading', { name: '有什么事交给我？' })).toBeVisible();
  expect(await page.evaluate(() => ({ reconnects: (window as any).__piReconnects, extraConnects: (window as any).__piExtraConnects, configWrites: (window as any).__piConfigWrites })))
    .toEqual({ reconnects: 1, extraConnects: 0, configWrites: 1 });
});
