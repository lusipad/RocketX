import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

const title = '检查 guojunwang-tv 当前改动并完成提交前验证';
const screenshots = '.omx/logs/acp-conversation-layout-20261116';

async function mountWorkspace(page: Page): Promise<void> {
  await page.evaluate(async (title) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, component, nav, { useUI }, { useCodexWorkspace }, { useAcpAgents }, { useWorkLedger }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/pages/ButlerPage.tsx'), load('/src/components/NavRail.tsx'),
      load('/src/stores/ui.ts'), load('/src/stores/codexWorkspace.ts'),
      load('/src/stores/acpAgents.ts'), load('/src/stores/workLedger.ts'),
    ]);
    const runtime = window as any;
    runtime.__layoutSends = [];
    runtime.__layoutNativeCalls = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: () => 0, unregisterCallback: () => {},
      invoke: async (command: string) => { runtime.__layoutNativeCalls.push(command); return null; },
    } });
    useUI.setState({ module: 'butler-view', butlerView: 'acp-hub', aiRuntimeProvider: 'pi', butlerSidebarCollapsed: false });
    useCodexWorkspace.setState({
      scope: 'layout-account', workspaceRoot: 'D:/Repos/guojunwang-tv', workspaceRoots: ['D:/Repos/guojunwang-tv'],
      defaultWorkspaceRoot: 'D:/Repos/guojunwang-tv', butlerWorkspaceRoot: 'D:/Repos/guojunwang-tv',
      status: 'ready', threads: [], messages: [], hydrate: () => {}, connect: async () => {},
    });
    useWorkLedger.setState({ cards: [], sessions: [], evidences: [], links: [], hydrated: true, hydrate: async () => {} });
    const session = (key: string) => ({
      sessionKey: key, agentId: 'antigravity', agentName: 'Google Antigravity', workspaceRoot: 'D:/Repos/guojunwang-tv',
      acpSessionId: `original-${key}`, status: 'ready', availableCommands: [], modes: null, models: null,
      messages: [{ id: `${key}-user`, role: 'user', text: '检查当前改动，保留已有工作，先完成验证。' },
        { id: `${key}-answer`, role: 'assistant', text: '已读取当前项目的改动。\n\n下一步会核对变更范围、运行相关检查，并整理还需要处理的问题。' }],
      plan: [], toolCalls: [], pendingPermissions: [], streamingText: '', streamingThought: '', stderrLogs: [],
      title: key === 'a' ? title : '另一项工作：整理测试结果', linkedTodoId: null,
      autonomyMode: 'confirm', turnCount: 1, createdAt: 1, updatedAt: key === 'a' ? 3 : 2,
    });
    useAcpAgents.setState({
      agents: [{ id: 'antigravity', name: 'Google Antigravity', preset: 'antigravity', command: 'test-agentapi', args: [], enabled: true }],
      discovered: ['OpenAI Codex CLI', 'Claude Code', 'Kimi Code'].map((name, index) => ({
        id: `discovered-${index}`, name, preset: 'custom', command: 'test-only', args: [], version: '1.0', alreadyRegistered: false,
      })),
      sessions: { a: session('a'), b: session('b') }, activeSessionKey: 'a', localSessions: [],
      hydrate: async () => {}, discoverLocalAgents: async () => [], discoverLocalSessions: async () => [],
      sendPrompt: async (target: string, text: string) => { runtime.__layoutSends.push({ target, text }); },
    });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    document.documentElement.dataset.theme = 'dark';
    const host = document.createElement('div');
    host.id = 'acp-layout-under-test';
    host.style.cssText = 'height:100vh;display:flex;min-width:0';
    document.body.append(host);
    const React = react.default ?? react;
    (dom.default ?? dom).createRoot(host).render(React.createElement(React.StrictMode, null,
      React.createElement(nav.default),
      React.createElement('div', { style: { flex: 1, minWidth: 0 } }, React.createElement(component.default)),
    ));
  }, title);
  await expect(page.locator('#acp-layout-under-test textarea')).toBeEditable();
}

test.beforeEach(async ({ page }) => { await bootAuthenticated(page); });

test('初始化失败保留历史和草稿，按钮与 Enter 都不能发送', async ({ page }) => {
  await mountWorkspace(page);
  const host = page.locator('#acp-layout-under-test');
  const input = host.locator('textarea').first();
  await input.fill('按照方案 1 继续');
  for (const sessionId of ['', 'original-a']) {
    await page.evaluate(async (sessionId) => {
      const { useAcpAgents } = await new Function('return import("/src/stores/acpAgents.ts")')();
      useAcpAgents.setState((state: any) => ({ sessions: { ...state.sessions, a: { ...state.sessions.a,
        acpSessionId: sessionId, connectionReady: false, status: 'error', error: '无法连接 Antigravity，原会话未启动。',
      } } }));
    }, sessionId);
    await expect(host.getByText('无法连接 Antigravity，原会话未启动。', { exact: true })).toBeVisible();
    await expect(host.getByText('执行连接尚未建立，要求会保留为草稿；已有记录仍可查看。', { exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: '发送指令', exact: true })).toBeDisabled();
    await input.press('Enter');
    await expect(input).toHaveValue('按照方案 1 继续');
    expect(await page.evaluate(() => (window as any).__layoutSends)).toEqual([]);
  }
  await expect(host.getByText('检查当前改动，保留已有工作，先完成验证。', { exact: true })).toBeVisible();
});

test('已有会话默认让出阅读空间，任务标题完整且输入框可见', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mountWorkspace(page);
  const host = page.locator('#acp-layout-under-test');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/default-current.png`, fullPage: true });
  await expect(host.getByText('发现本机 Agent (3)', { exact: true })).toBeHidden();
  await expect(host.getByText('当前会话尚未产生结构化执行计划。代理发送 ACP 计划更新后将实时展示于此。', { exact: true })).toBeHidden();
  const heading = host.getByRole('heading', { name: title, exact: true });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const transcript = await host.getByRole('log', { name: '执行器会话记录' }).boundingBox();
  const stage = await host.locator('.butler-managed-surface').boundingBox();
  expect(transcript!.width / stage!.width).toBeGreaterThan(0.75);
  await expect(host.locator('textarea')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await host.getByRole('button', { name: '收起主导航', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/default-user-navigation-current.png`, fullPage: true, animations: 'disabled' });
});

test('管理和任务详情按需打开，关闭后保留原会话与草稿', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountWorkspace(page);
  const host = page.locator('#acp-layout-under-test');
  const input = host.locator('textarea').first();
  await input.fill('继续验证这项工作，保留原会话');
  const manage = host.getByRole('button', { name: '管理执行器', exact: true });
  await manage.click();
  const management = host.getByRole('dialog', { name: '管理执行器', exact: true });
  await expect(management).toBeVisible();
  await expect(management.getByText('OpenAI Codex CLI', { exact: true })).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/management-1280-current.png`, fullPage: true });
  await management.getByRole('button', { name: '关闭执行器管理', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await management.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(management).toBeHidden();
  await expect(manage).toBeFocused();
  await expect(input).toHaveValue('继续验证这项工作，保留原会话');
  await host.getByRole('button', { name: '任务详情', exact: true }).click();
  const details = host.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(details).toBeVisible();
  await expect(details.getByRole('button', { name: '执行计划', exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/details-1280-current.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(input).toHaveValue('继续验证这项工作，保留原会话');
  expect(await page.evaluate(() => (window as any).__layoutSends.length)).toBe(0);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__layoutSends)).toEqual([{ target: 'a', text: '继续验证这项工作，保留原会话' }]);
});

test('窄窗口的导航与辅助面板不挤走对话，切换会话保留各自草稿', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await mountWorkspace(page);
  const host = page.locator('#acp-layout-under-test');
  const input = host.locator('textarea').first();
  await expect(host.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(input).toBeInViewport();
  await input.fill('A 的未发送要求');
  await host.getByRole('combobox', { name: '切换会话', exact: true }).selectOption('b');
  await expect(input).toHaveValue('');
  await input.fill('B 的未发送要求');
  await host.getByRole('combobox', { name: '切换会话', exact: true }).selectOption('a');
  await expect(input).toHaveValue('A 的未发送要求');
  await host.getByRole('button', { name: '任务详情', exact: true }).click();
  const details = host.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(details).toBeInViewport();
  const detailsBox = await details.boundingBox();
  expect(detailsBox!.width).toBeLessThanOrEqual(900);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/narrow-current.png`, fullPage: true });
  await expect(input).toBeInViewport();
});

test('收起辅助面板后仍能看见审批请求，切换列表保留待审批提示和权限入口', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountWorkspace(page);
  await page.evaluate(async () => {
    const { useAcpAgents } = await new Function('return import("/src/stores/acpAgents.ts")')();
    const runtime = window as any;
    runtime.__layoutModes = [];
    runtime.__layoutApprovals = [];
    useAcpAgents.setState((state: any) => ({
      setMode: async (...args: unknown[]) => { runtime.__layoutModes.push(args); },
      resolvePermission: async (...args: unknown[]) => { runtime.__layoutApprovals.push(args); },
      sessions: {
        ...state.sessions,
        a: { ...state.sessions.a, status: 'waiting_approval',
          modes: { currentModeId: 'confirm', availableModes: [{ id: 'confirm', name: '确认后执行' }, { id: 'auto', name: '自动执行' }] },
          pendingPermissions: [{ requestId: 'request-a', toolCall: { title: '修改当前项目文件' }, reason: '需要你确认本次修改',
            options: [{ optionId: 'allow-a', kind: 'allow_once', name: '允许本次修改' }] }],
        },
      },
    }));
  });
  const host = page.locator('#acp-layout-under-test');
  await expect(host.getByText('权限请求：修改当前项目文件', { exact: true })).toBeVisible();
  await expect(host.getByRole('combobox', { name: '切换会话', exact: true }).getByRole('option', { name: /待审批 1 项/ })).toHaveCount(1);
  await host.getByRole('button', { name: '任务详情', exact: true }).click();
  const details = host.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(details.getByRole('button', { name: '确认后执行', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await details.getByRole('button', { name: '自动执行', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__layoutModes)).toEqual([['a', 'auto']]);
  await page.keyboard.press('Escape');
  await host.getByRole('button', { name: '允许本次修改', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__layoutApprovals)).toEqual([['a', 'request-a', 'allow-a']]);
  await expect(host.locator('textarea')).toBeInViewport();
});

test('当前会话被移除后关闭详情并解除焦点约束', async ({ page }) => {
  await mountWorkspace(page);
  const host = page.locator('#acp-layout-under-test');
  await host.getByRole('button', { name: '任务详情', exact: true }).click();
  await expect(host.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { useAcpAgents } = await new Function('return import("/src/stores/acpAgents.ts")')();
    useAcpAgents.setState((state: any) => ({ sessions: { b: state.sessions.b } }));
  });
  await expect(host.getByRole('dialog', { name: '任务详情', exact: true })).toBeHidden();
  const manage = host.getByRole('button', { name: '管理执行器', exact: true });
  await manage.focus();
  await page.keyboard.press('Tab');
  await expect(manage).not.toBeFocused();
});
