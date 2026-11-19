import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const output = '.omx/logs/work-first-redesign-20261116';

async function mountShell(page: Page, initialView: 'conversation' | 'kanban' = 'kanban') {
  // This fixture mounts the whole Butler workspace; a second hidden app would also read its native sessions.
  await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await page.evaluate(async (initialView) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    localStorage.setItem('rcx-owner', 'local-user@local');
    await load('/src/styles.css');
    const [react, dom, shell, rail, { useUI }, { useAuth }, { useCodexWorkspace }, { useWorkLedger }, { useAcpAgents }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/pages/ButlerPage.tsx'), load('/src/components/NavRail.tsx'), load('/src/stores/ui.ts'),
      load('/src/stores/auth.ts'), load('/src/stores/codexWorkspace.ts'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'),
    ]);
    const specs = [
      { title: '确认发布范围', goal: '整理本周发布内容，保留尚未验证的改动', stage: 'ready', projectKey: 'RocketX', waitState: 'waiting_input', waitReason: '发布说明已起草，需要确定是否包含实验性语音功能' },
      { title: '修复附件重复发送', goal: '网络恢复后不再重复发出同一条附件消息', stage: 'in_progress', projectKey: 'RocketX', waitState: 'none', nextStep: '执行器最近记录：正在检查重连后的消息去重' },
      { title: '继续电视端播放方案', goal: '接着原会话核对电视端播放方案的实现范围', stage: 'ready', projectKey: 'guojunwang-tv', waitState: 'none' },
      { title: '整理工作周报', goal: '汇总本周已完成事项与待处理问题', stage: 'done', projectKey: '个人工作', waitState: 'none' },
    ];
    const cards = [];
    for (const [index, spec] of specs.entries()) {
      const card = await useWorkLedger.getState().createCard({ title: spec.title, goal: spec.goal, stage: spec.stage, projectKey: spec.projectKey, priority: 3 });
      cards.push({ ...card, done: spec.stage === 'done', updatedAt: Date.now() - index * 60000, state: { ...card.state, stage: spec.stage, waitState: spec.waitState, waitReason: spec.waitReason ?? null, nextStep: spec.nextStep ?? null } });
    }
    const sessions = cards.slice(1, 3).map((card: any, index) => ({
      id: `source-${index}`, todoId: card.id, runtime: 'acp', origin: 'native_cli', nativeSessionId: `original-${index}`,
      sourceScope: 'antigravity:demo', title: index === 1 ? 'Git Code Commit' : card.title,
      workspaceRoot: index === 1 ? 'D:/Repos/guojunwang-tv' : 'D:/Repos/RocketX', visibility: 'private',
      runtimeStatus: index === 0 ? 'running' : 'unknown', controlMode: 'readonly', controlReason: 'external_activity_unknown',
      accountScope: localStorage.getItem('rcx-owner'), configSnapshotJson: JSON.stringify({ provider: 'antigravity', preview: index === 1 ? '最近讨论电视端播放方案，尚未核对后续进展。' : '正在核对重连后的消息标识。' }),
      createdAt: Date.now(), updatedAt: Date.now(), lastVerifiedAt: Date.now(),
    }));
    useAuth.setState({ localMode: true });
    const accounts = await load('/src/platform/butlerAccountReady.ts');
    accounts.beginButlerAccountSelection('local-user@local').activate({ accountScope: 'local-user@local', generation: 1 });
    useUI.setState({ module: 'butler-view', butlerView: initialView, aiRuntimeProvider: 'pi', butlerSidebarCollapsed: false, navRailCollapsed: true });
    useCodexWorkspace.setState({ scope: 'design-test', status: 'ready', workspaceRoot: 'D:/RocketX/Butler', workspaceRoots: ['D:/RocketX/Butler'], defaultWorkspaceRoot: 'D:/RocketX/Butler', butlerWorkspaceRoot: 'D:/RocketX/Butler',
      threads: [], activeThreadId: null, messages: [], models: [], pendingRequests: [], queuedMessages: [], events: [], streamingText: '', hydrate: () => {}, connect: async () => {},
    });
    const resultCard = cards[1];
    const evidence = { id: 'fresh', todoId: resultCard.id, kind: 'test_run', title: '重连测试', summary: '三次重连都只发送了一条消息。', passed: true, stale: false, verifiedAt: Date.now(),
      requirementsVersion: resultCard.state.requirementsVersion, contentVersion: resultCard.state.contentVersion };
    useWorkLedger.setState({ cards, sessions, evidences: [evidence, { ...evidence, id: 'old', summary: '旧版本测试', requirementsVersion: (evidence.requirementsVersion ?? 0) + 1, verifiedAt: evidence.verifiedAt + 2 },
      { ...evidence, id: 'invalidated', stale: true, summary: '过期测试', verifiedAt: evidence.verifiedAt + 1 }], links: [], actions: [], events: [], hydrated: true, loading: false, hydrate: async () => {} });
    useAcpAgents.setState({ agents: [], sessions: {}, localSessions: [], hydrate: async () => {}, discoverLocalSessions: async () => [] });
    const bridge = await load('/src/agent/superAgentBridge.ts');
    bridge.setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [] });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { transformCallback: () => 0, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === 'acp_local_session_messages') return [{ id: 'last-user', role: 'user', text: '先核对之前的电视端方案，再决定如何继续。', timestamp: Date.now() }];
      return null;
    } } });
    document.documentElement.dataset.theme = 'dark';
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div'); host.id = 'work-first-shell'; host.style.cssText = 'height:100vh;display:flex;min-width:0'; document.body.append(host);
    const React = react.default ?? react;
    (dom.default ?? dom).createRoot(host).render(React.createElement(React.StrictMode, null,
      React.createElement(rail.default, { onOpenShortcuts: () => {} }),
      React.createElement('div', { style: { flex: 1, minWidth: 0 } }, React.createElement(shell.default)),
    ));
  }, initialView);
}

test('管家直达当前工作与同版证据，切回保留输入和手动侧栏偏好', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountShell(page, 'conversation');
  const host = page.locator('#work-first-shell');
  const notices = host.getByRole('navigation', { name: '管家工作提醒' });
  await expect(notices).toBeVisible();
  await expect(host.locator('.work-first-board')).toHaveCount(0);
  await expect(notices).not.toContainText(/旧版本测试|过期测试/);
  const shots = '.omx/logs/conversation-home-20261119';
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/home-1280.png`, animations: 'disabled' });
  const input = host.getByRole('textbox', { name: '给管家的要求' });
  await input.fill('先保留这段草稿。');
  await notices.getByRole('button', { name: /待补充.*确认发布范围/ }).click();
  await expect(host.getByRole('complementary', { name: '工作详情' })).toContainText('确认发布范围');
  await host.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await expect(host.locator('.butler-surface-layout > aside')).toHaveCSS('width', '172px');
  await host.getByRole('button', { name: '收起会话列表', exact: true }).click();
  await host.getByRole('button', { name: '返回管家', exact: true }).click();
  await expect(input).toHaveValue('先保留这段草稿。');
  await expect(host.getByRole('button', { name: '展开会话列表', exact: true })).toBeVisible();
  await notices.getByRole('button', { name: /最新记录.*三次重连/ }).click();
  const detail = host.getByRole('complementary', { name: '工作详情' });
  await expect(detail.getByRole('heading', { name: '修复附件重复发送' })).toBeVisible();
  await expect(detail.getByText('三次重连都只发送了一条消息。', { exact: true })).toBeVisible();
  await host.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = host.getByRole('button', { name: '打开任务列表', exact: true });
  await toggle.click();
  const drawer = host.getByRole('dialog', { name: '任务列表' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '搜索对话' }).click();
  await expect(drawer.getByRole('searchbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await host.getByRole('button', { name: '返回管家', exact: true }).click();
  await expect(input).toHaveValue('先保留这段草稿。');
  await expect(notices).toBeVisible();
  await expect(notices.getByRole('button').first()).toBeInViewport();
  await expect(notices.getByRole('button').last()).toBeInViewport();
  expect(await notices.evaluate(el => {
    const item = el.querySelector('button')!;
    const rect = item.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return item.contains(hit) || { hit: hit?.outerHTML.slice(0, 180), header: el.previousElementSibling?.getBoundingClientRect().toJSON(), first: rect.toJSON() };
  })).toBe(true);
  expect(await host.evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${shots}/home-390.png`, animations: 'disabled' });
  await host.getByRole('button', { name: '工作看板', exact: true }).click();
  await expect(host.getByRole('region', { name: '工作看板' })).toBeVisible();
  await expect(detail).toHaveCount(0);
});

test('完整日常界面突出工作和下一步，桌面与窄窗均可操作', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await mountShell(page);
  const host = page.locator('#work-first-shell');
  await expect(host.getByRole('button', { name: '确认发布范围', exact: true })).toBeVisible();
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/work-list-1440.png`, fullPage: true });
  await host.getByRole('button', { name: '继续电视端播放方案', exact: true }).click();
  await expect(host.getByRole('heading', { name: '继续电视端播放方案', exact: true })).toBeVisible();
  await page.screenshot({ path: `${output}/work-detail-1440.png`, fullPage: true });
  const back = host.getByRole('button', { name: /返回.*工作|关闭卡片工作面|返回列表/ }).first();
  await back.click();
  await page.setViewportSize({ width: 900, height: 900 });
  await host.locator('.work-first-groups').evaluate((element) => { element.scrollTop = 0; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/work-list-900.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await host.getByRole('navigation', { name: 'AI 协作' }).getByRole('button', { name: '管家', exact: true }).click();
  await expect(host.getByRole('heading', { name: '有什么事交给我？', exact: true })).toBeVisible();
  await page.screenshot({ path: `${output}/assistant-1440.png`, fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect(host.locator('.work-first-suggestions button').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(host.getByRole('navigation', { name: 'AI 协作' }).getByRole('button', { name: '管家', exact: true })).toHaveCSS('color', 'rgb(22, 25, 32)');
  await page.screenshot({ path: `${output}/assistant-light-1440.png`, fullPage: true, animations: 'disabled' });
});

test('管家按当前工作和已结束轮次只读一次原端结果，来源不匹配时保留可看的验证记录', async ({ page }) => {
  await mountShell(page, 'conversation');
  const host = page.locator('#work-first-shell');
  const notices = host.getByRole('navigation', { name: '管家工作提醒' });
  await expect(notices).toContainText('三次重连都只发送了一条消息');
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [{ useWorkLedger }, { resolveButlerAccountScope }] = await Promise.all([
      load('/src/stores/workLedger.ts'), load('/src/stores/butlerMemory.ts'),
    ]);
    const state = useWorkLedger.getState();
    const card = state.cards.find((item: any) => item.title === '继续电视端播放方案');
    const scope = resolveButlerAccountScope();
    const session = { ...state.sessions.find((item: any) => item.todoId === card.id), runtime: 'codex', runtimeStatus: 'idle', accountScope: scope,
      nativeSessionId: 'original-thread', sourceScope: 'original-source', configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: 'original-profile' }) };
    const binding = { sessionId: session.id, nativeThreadId: session.nativeSessionId, executionProfileId: 'original-profile', sourceScope: session.sourceScope };
    const action = { id: 'original-prompt', todoId: card.id, sessionId: session.id, actionKind: 'session_prompt', state: 'completed', updatedAt: Date.now() + 10,
      specJson: JSON.stringify({ binding, expected: { requirementsVersion: card.state.requirementsVersion, contentVersion: card.state.contentVersion } }),
      receiptRef: JSON.stringify({ nativeTurnId: 'original-turn', nativeThreadId: session.nativeSessionId, terminalStatus: 'completed' }) };
    const later = { ...session, id: 'other-session', nativeSessionId: 'other-thread', updatedAt: session.updatedAt + 1 };
    const runtime = window as any;
    runtime.__briefReads = [];
    runtime.__briefOffline = false;
    runtime.__briefMismatch = false;
    const original = runtime.__TAURI_INTERNALS__.invoke;
    runtime.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command !== 'butler_native_work_snapshot') return original(command, args);
      runtime.__briefReads.push(args.input.sessionId);
      return { ...binding, protocolVersion: 1, todoId: card.id, sourceScope: runtime.__briefMismatch ? 'another-source' : binding.sourceScope, connectionStatus: runtime.__briefOffline ? 'unknown' : 'connected', runtimeStatus: runtime.__briefOffline ? 'unknown' : 'idle', commands: [action],
        messages: [{ role: 'assistant', text: '原端刚完成了播放检查', turnId: 'original-turn', streaming: false }, { role: 'assistant', text: '不属于这项工作的回复', turnId: 'other-turn', streaming: false }] };
    };
    useWorkLedger.setState({ sessions: [...state.sessions.filter((item: any) => item.id !== session.id), session, later], actions: [action] });
    runtime.__disconnectBrief = () => {
      runtime.__briefOffline = true;
      useWorkLedger.setState({ sessions: useWorkLedger.getState().sessions.map((s: any) => s.id === session.id ? { ...s, runtimeStatus: 'unknown', updatedAt: s.updatedAt + 1 } : s) });
    };
    runtime.__changeBriefResult = () => {
      runtime.__briefMismatch = true;
      useWorkLedger.setState({ actions: [{ ...action, id: 'another-prompt' }] });
    };
  });
  await expect(notices.getByRole('button', { name: /执行者回复.*原端刚完成了播放检查/ })).toBeVisible();
  await expect(notices).not.toContainText('不属于这项工作的回复');
  expect(await page.evaluate(() => (window as any).__briefReads)).toEqual(['source-1']);
  await page.evaluate(() => (window as any).__disconnectBrief());
  await expect(notices.getByRole('button', { name: /历史回复.*原端刚完成了播放检查/ })).toBeVisible();
  await page.evaluate(() => (window as any).__changeBriefResult());
  await expect(notices.getByRole('button', { name: /最新记录.*三次重连/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__briefReads.length)).toBe(3);
  await expect(notices).not.toContainText('原端刚完成了播放检查');
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const state = useWorkLedger.getState(), action = state.actions[0];
    (window as any).__briefMismatch = false;
    useWorkLedger.setState({ actions: [...state.actions, { ...action, id: 'unsettled', actionKind: 'session_interrupt',
      state: 'verifying_delivery', receiptRef: null, updatedAt: Date.now() + 1000 }] });
  });
  await expect(notices.getByRole('button', { name: /待核对.*继续电视端播放方案.*上次操作的送达结果待核对/ })).toBeVisible();
  await expect(notices).not.toContainText('原端刚完成了播放检查');
  await expect(notices).toContainText('三次重连都只发送了一条消息');
  expect(await page.evaluate(() => (window as any).__briefReads.length)).toBe(3);
});
