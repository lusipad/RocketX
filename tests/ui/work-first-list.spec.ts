import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountWorkList(page: Page) {
  await bootAuthenticated(page);
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [React, ReactDOM, { default: Board }, { useWorkLedger }, bridge, { useCodexWorkspace }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkKanbanBoard.tsx'), load('/src/stores/workLedger.ts'),
      load('/src/agent/superAgentBridge.ts'), load('/src/stores/codexWorkspace.ts'),
    ]);
    bridge.setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [] });
    const base = await useWorkLedger.getState().createCard({ title: '模板', priority: 3, projectKey: 'RocketX' });
    const now = Date.now();
    const card = (id: string, title: string, state: Record<string, unknown> = {}) => ({
      ...base, id, title, createdAt: now, updatedAt: now,
      state: { ...base.state, todoId: id, stage: 'ready', goal: null, nextStep: null, ...state },
    });
    const session = (id: string, title: string, status: string) => ({
      id: `session-${id}`, todoId: id, runtime: 'acp', origin: 'native_cli',
      nativeSessionId: `native-${id}`, sourceScope: 'codex:work-first', title,
      workspaceRoot: 'D:/Repos/RocketX', visibility: 'private', runtimeStatus: status,
      accountScope: localStorage.getItem('rcx-owner'), hostDeviceId: null, controlEndpoint: null,
      controlMode: 'readonly', controlReason: 'unknown_external_writer',
      configSnapshotJson: JSON.stringify({ provider: 'codex', preview: title }),
      updatedAt: now, createdAt: now, lastVerifiedAt: now,
    });
    useWorkLedger.setState({
      cards: [
        card('saved', '检查登录页的键盘操作'),
        card('history', '七月发布说明', { stage: 'done' }),
        card('active', '修复消息重复投递', { stage: 'in_progress' }),
        card('blocked', '确定报告接收范围', { waitState: 'blocked', waitReason: '需要确定报告接收群组', goal: '仅向指定群组发送报告' }),
        card('unknown', '历史中的执行任务', { stage: 'in_progress' }),
        card('result', '检查断线恢复结果', { stage: 'verifying' }),
        card('approval', '同步工作项状态'),
      ],
      sessions: [session('saved', '检查登录页的键盘操作', 'idle'), session('active', '修复消息重复投递', 'running'), session('unknown', '历史中的执行任务', 'unknown')],
      evidences: [{ id: 'e-result', todoId: 'result', kind: 'test_run', title: '重连验证', summary: '三次重连没有重复投递', passed: true, stale: false, verifiedAt: now, createdAt: now }],
      actions: [{ id: 'approval-action', todoId: 'approval', actionKind: 'ado_state_write', state: 'awaiting_approval' }],
      links: [], events: [], hydrated: true, loading: false, lastError: null, hydrate: async () => {},
    });
    const runtime = window as any;
    runtime.__workFirstCalls = [];
    useCodexWorkspace.setState({
      threads: [], workspaceRoot: 'D:/butler', butlerWorkspaceRoot: 'D:/butler', status: 'ready',
      ensureDefaultWorkspace: async () => 'D:/butler',
      startThread: async () => { runtime.__workFirstCalls.push('startThread'); return 'new-thread'; },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: () => 0, unregisterCallback: () => {},
      invoke: async (command: string, input: unknown) => {
        runtime.__workFirstCalls.push({ command, input });
        if (command === 'plugin:dialog|open') return runtime.__workDirectoryChoice?.() ?? null;
        if (command === 'acp_local_session_messages') return [{ id: 'm1', role: 'user', text: '检查登录页键盘焦点', timestamp: now }];
        if (command === 'acp_agent_list' || command === 'acp_agent_discover') return [];
        return null;
      },
    } });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'work-first-under-test'; host.style.cssText = 'height:100vh;display:flex';
    document.body.append(host);
    (ReactDOM.default ?? ReactDOM).createRoot(host).render((React.default ?? React).createElement(Board));
  });
  return page.locator('#work-first-under-test');
}

test('我的工作优先展示实际阻碍，空闲和未知状态不冒充执行，历史完成不冒充验证', async ({ page }) => {
  const board = await mountWorkList(page);
  await expect(board.getByRole('region', { name: '管家简报', exact: true })).toContainText('1 项最近记录在推进');
  await expect(board.getByRole('region', { name: '需要你', exact: true })).toContainText('需要确定报告接收群组');
  await expect(board.getByRole('region', { name: '需要你', exact: true })).toContainText('同步工作项状态');
  const active = board.getByRole('region', { name: '正在推进', exact: true });
  await expect(active).toContainText('修复消息重复投递');
  await expect(active).not.toContainText('检查登录页的键盘操作');
  await expect(active).not.toContainText('历史中的执行任务');
  await expect(board.getByRole('region', { name: '待开始', exact: true })).toContainText('执行状态未核实');
  await expect(board.getByRole('region', { name: '历史完成记录', exact: true })).toBeHidden();
  await board.getByText('历史完成记录 1', { exact: true }).click();
  await expect(board.getByRole('region', { name: '历史完成记录', exact: true })).toContainText('尚无当前验证记录');
  await expect(board).not.toContainText('验收齐备');
  await expect(board.getByRole('region', { name: '结果待看', exact: true })).toContainText('三次重连没有重复投递');
  await expect(board.getByRole('button', { name: '忽略', exact: true })).toHaveCount(0);
  await expect(board.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
  await expect(board.getByRole('button', { name: '检查登录页的键盘操作', exact: true }).locator('..')).not.toContainText('会话摘要');
});

async function enableNativeStarts(page: Page) {
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [{ useWorkLedger }, { useAcpAgents }, { resolveButlerAccountScope }, account] = await Promise.all([
      load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'), load('/src/stores/butlerMemory.ts'),
      load('/src/platform/butlerAccountReady.ts'),
    ]);
    const scope = resolveButlerAccountScope();
    account.beginButlerAccountSelection(scope).activate({ accountScope: scope, generation: 99 });
    const profiles = ['A', 'B'].map(label => ({ id: `codex-${label}`, name: `Codex ${label}`, args: ['--rocketx-acp-bridge=codex'],
      cwd: `D:/Repos/${label}`, enabled: true, sourceScope: `codex:fixture-${label}` }));
    useAcpAgents.setState({ agents: profiles, hydrate: async () => {} });
    const runtime = window as any;
    const originalInvoke = runtime.__TAURI_INTERNALS__.invoke;
    runtime.__starts = []; runtime.__extraPrompts = [];
    runtime.__TAURI_INTERNALS__.invoke = async (command: string, params: any) => {
      if (command === 'butler_native_work_submit') { runtime.__extraPrompts.push(params); throw new Error('另行发送会重复调查'); }
      if (command === 'butler_native_work_snapshot') return runtime.__startedView;
      if (command !== 'butler_native_work_start') return originalInvoke(command, params);
      const input = params.input;
      runtime.__starts.push(structuredClone(input));
      return new Promise((resolve, reject) => {
        runtime.__lostReceipt = () => reject(new Error('测试回执中断'));
        runtime.__invalidWorkspace = () => reject('rocketx.native-start.not-started.v1:原目录不存在');
        runtime.__acceptStart = () => {
          const sourceScope = profiles.find(profile => profile.id === input.executionProfileId)!.sourceScope;
          const session = { id: 'bound-new', todoId: input.todoId, nativeSessionId: 'original-new', runtime: 'codex', origin: 'rocketx_managed',
            runtimeStatus: 'idle', sourceScope, workspaceRoot: input.workspaceRoot, accountScope: input.account.accountScope,
            title: '新的调查', controlMode: 'controllable', createdAt: 1, updatedAt: 1,
            configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: input.executionProfileId, nativeHost: {} }) };
          runtime.__startedView = { protocolVersion: 1, todoId: input.todoId, sessionId: session.id, nativeThreadId: session.nativeSessionId,
            executionProfileId: input.executionProfileId, sourceScope, activeTurnId: null, connectionStatus: 'connected', runtimeStatus: 'idle',
            bindingVersion: 1, connectionId: 'bound-connection', capabilities: { prompt: true, interrupt: true }, messages: [], commands: [], decisions: [], cursor: 1 };
          useWorkLedger.setState((s: any) => ({ sessions: [...s.sessions, session] }));
          resolve(runtime.__startedView);
        };
      });
    };
  });
}

test('从新建直接调查，配置跟随明确项目，丢回执后重开只核对原请求', async ({ page }) => {
  const board = await mountWorkList(page);
  await enableNativeStarts(page);
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作', exact: true });
  await form.getByLabel('要完成什么').fill('调查重试次数异常');
  await form.getByLabel('工作目录').fill('D:/Repos/A');
  await expect(form.getByLabel('执行者')).toHaveValue('codex-A');
  await form.getByLabel('工作目录').fill('D:/Elsewhere');
  await expect(form.getByLabel('执行者')).toHaveValue('');
  await expect(form.getByRole('button', { name: '开始调查' })).toBeDisabled();
  await form.getByLabel('执行者').selectOption('codex-B');
  await form.getByRole('button', { name: '开始调查' }).dblclick();
  await expect(board.getByRole('region', { name: '调查启动状态' })).toContainText('正在提交调查');
  const first = await page.evaluate(() => (window as any).__starts[0]);
  expect(first).toMatchObject({ workspaceRoot: 'D:/Elsewhere', executionProfileId: 'codex-B', requestId: `native-start:${first.todoId}` });
  await board.getByRole('button', { name: '返回我的工作', exact: true }).click();
  const card = board.getByRole('button', { name: '调查重试次数异常', exact: true });
  await expect(card).toContainText('正在为这个项目准备调查');
  await page.evaluate(() => (window as any).__lostReceipt());
  await expect(card).toContainText('开工回执待核对');
  await card.click();
  const recovery = board.getByRole('region', { name: '调查启动状态' });
  await expect(recovery).toContainText('测试回执中断');
  expect(await page.evaluate(() => (window as any).__starts)).toHaveLength(1);
  await expect(recovery.getByRole('textbox')).toHaveCount(0);
  await recovery.getByRole('button', { name: '核对并重试' }).click();
  expect(await page.evaluate(() => (window as any).__starts)).toEqual([first, first]);
  await page.evaluate(() => (window as any).__acceptStart());
  await expect(board.getByRole('region', { name: 'Codex 工作现场' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__extraPrompts)).toEqual([]);
});

test('仅加入待开始时无启动调用，零原会话时可在已保存目录直接调查', async ({ page }) => {
  const board = await mountWorkList(page); await enableNativeStarts(page);
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作', exact: true });
  await form.getByLabel('要完成什么').fill('调查孤立工作');
  await form.getByLabel('工作目录').fill('D:/Repos/B');
  await form.getByRole('button', { name: '加入待开始' }).click();
  const prepared = board.getByRole('region', { name: '连接项目会话' });
  await expect(prepared.getByLabel('执行者')).toHaveValue('codex-B');
  expect(await page.evaluate(() => (window as any).__starts)).toEqual([]);
  await prepared.getByRole('button', { name: '开始调查' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__starts.length)).toBe(1);
  const [input] = await page.evaluate(() => (window as any).__starts);
  expect(input).toMatchObject({ workspaceRoot: 'D:/Repos/B', executionProfileId: 'codex-B' });
  await page.evaluate(() => (window as any).__acceptStart());
  await expect(board.getByRole('region', { name: 'Codex 工作现场' })).toBeVisible();
});

test('目录中的 Enter 启动主动作，输入法确认或缺少配置选择时不执行，明确未开始可纠正目录重试', async ({ page }) => {
  const board = await mountWorkList(page); await enableNativeStarts(page);
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作' });
  const directory = form.getByLabel('工作目录');
  await form.getByLabel('要完成什么').fill('调查新目录同步');
  await directory.fill('D:/missing');
  await directory.press('Enter');
  await expect(form).toBeVisible();
  expect(await page.evaluate(() => (window as any).__starts)).toEqual([]);
  await directory.fill('D:/Repos/A');
  expect(await directory.evaluate(node => !node.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, key: 'Enter', isComposing: true,
  })))).toBe(true);
  expect(await page.evaluate(() => (window as any).__starts)).toEqual([]);
  await directory.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__starts.length)).toBe(1);
  await page.evaluate(() => (window as any).__invalidWorkspace());
  const status = board.getByRole('region', { name: '调查启动状态' });
  await expect(status).toContainText('调查未开始');
  await status.getByLabel('工作目录').fill('D:/Repos/B');
  await expect(status.getByLabel('执行者')).toHaveValue('codex-B');
  await status.getByRole('button', { name: '开始调查' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__starts.length)).toBe(2);
  const [first, second] = await page.evaluate(() => (window as any).__starts);
  expect(second).toMatchObject({ requestId: first.requestId, todoId: first.todoId, workspaceRoot: 'D:/Repos/B', executionProfileId: 'codex-B' });
  await page.evaluate(() => (window as any).__acceptStart());
  await expect(board.getByRole('region', { name: 'Codex 工作现场' })).toBeVisible();
  const savedPath = await page.evaluate(async id => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    return useWorkLedger.getState().links.find((link: any) => link.todoId === id && link.stateSnapshot === 'workspace')?.repo;
  }, first.todoId);
  expect(savedPath).toBe('D:/Repos/B');
});

for (const width of [390, 940]) test(`${width}×640 的新建表单可以直接看到并点击开始调查`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 640 });
  const board = await mountWorkList(page); await enableNativeStarts(page);
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作' });
  await form.getByLabel('要完成什么').fill('核对订单同步后偶发的重复提醒');
  await form.getByLabel('工作目录').fill('D:/Repos/B');
  const start = form.getByRole('button', { name: '开始调查', exact: true });
  await expect(start).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath(`new-work-${width}.png`) });
  expect(await start.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2));
  })).toBe(true);
});

test('默认四列看板，原位展开保持卡片坐标，返回保留筛选与焦点', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const board = await mountWorkList(page);
  await expect(board.getByRole('searchbox')).not.toBeVisible();
  const saved = board.getByRole('button', { name: '检查登录页的键盘操作', exact: true });
  const unknown = board.getByRole('button', { name: '历史中的执行任务', exact: true });
  const first = (await saved.boundingBox())!;
  const second = (await unknown.boundingBox())!;
  expect(Math.abs(first.x - second.x)).toBeLessThan(2);
  expect(Math.abs(first.y - second.y)).toBeGreaterThan(50);
  const active = (await board.getByRole('region', { name: '正在推进', exact: true }).boundingBox())!;
  const ready = (await board.getByRole('region', { name: '待开始', exact: true }).boundingBox())!;
  expect(active.x).toBeGreaterThan(ready.x + ready.width);
  await board.getByRole('button', { name: /需我处理/ }).click();
  const target = board.getByRole('button', { name: '确定报告接收范围', exact: true });
  const targetDom = board.locator('button[data-work-id="blocked"]');
  const beforeOpen = (await target.boundingBox())!;
  await target.focus();
  await page.keyboard.press('Enter');
  await expect(board.getByRole('heading', { name: '确定报告接收范围', exact: true })).toBeVisible();
  await expect(board.getByRole('region', { name: '工作看板', exact: true })).toBeVisible();
  await expect(target).toHaveCount(0); // The unchanged card is covered by the detail, so it leaves the accessibility tree.
  const openPosition = (await targetDom.boundingBox())!;
  expect(openPosition.x).toBe(beforeOpen.x);
  expect(openPosition.y).toBe(beforeOpen.y);
  await board.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await expect(target).toBeFocused();
  await expect(board.getByRole('button', { name: /需我处理/ })).toHaveAttribute('aria-pressed', 'true');
  await board.getByRole('button', { name: '查找', exact: true }).click();
  const search = board.getByRole('searchbox', { name: '查找工作与成果' });
  await expect(search).toBeFocused();
  await search.fill('键盘');
  const result = board.getByRole('list', { name: '检索结果' }).getByRole('button', { name: '检查登录页的键盘操作', exact: true }).first();
  await result.focus();
  await page.keyboard.press('Enter');
  await expect(board.getByRole('heading', { name: '检查登录页的键盘操作', exact: true })).toBeVisible();
  await board.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await expect(search).toHaveValue('键盘');
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('work-first-list-900.png') });
});

test('只读来源仍可直接查看，收录和查看都不启动执行', async ({ page }) => {
  const board = await mountWorkList(page);
  const row = board.getByRole('button', { name: '检查登录页的键盘操作', exact: true }).locator('..');
  await row.getByRole('button', { name: '查看 Codex 对话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '会话记录' })).toContainText('检查登录页键盘焦点');
  await page.keyboard.press('Escape');
  await board.getByRole('button', { name: '添加已有会话', exact: true }).click();
  await expect(board.getByRole('region', { name: '添加已有会话', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__workFirstCalls);
  expect(calls.some((call: any) => typeof call === 'string' || /process_start|process_write|handoff|start_turn/.test(call.command))).toBe(false);
});

test('新建工作先显式绑定目录，保存为准备状态，不沿用管家目录或向既有工作发送', async ({ page }) => {
  const board = await mountWorkList(page);
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作', exact: true });
  await expect(form.getByLabel('工作目录')).toHaveValue('');
  await form.getByLabel('要完成什么').fill('调查新的登录失败');
  await expect(form.getByRole('button', { name: '加入待开始', exact: true })).toBeDisabled();
  await form.getByLabel('工作目录').fill('D:/Repos/LoginProject');
  await form.getByRole('button', { name: '加入待开始', exact: true }).click();
  await expect(board.getByRole('heading', { name: '调查新的登录失败', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const card = useWorkLedger.getState().cards.find((item: any) => item.title === '调查新的登录失败');
    const link = useWorkLedger.getState().links.find((item: any) => item.todoId === card.id && item.stateSnapshot === 'workspace');
    return { stage: card.state.stage, repo: link.repo, sessions: useWorkLedger.getState().sessions.filter((item: any) => item.todoId === card.id).length };
  })).toEqual({ stage: 'ready', repo: 'D:/Repos/LoginProject', sessions: 0 });
  expect(await page.evaluate(() => (window as any).__workFirstCalls.filter((call: unknown) => call === 'startThread'))).toHaveLength(0);
});

test('新工作可明确选择已有项目或文件夹，取消保留草稿，保存精确选择路径且不执行', async ({ page }) => {
  const board = await mountWorkList(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const ledger = useWorkLedger.getState();
    useWorkLedger.setState({ sessions: [...ledger.sessions, { ...ledger.sessions[0], id: 'foreign-project', accountScope: 'another-account', workspaceRoot: 'D:/PrivateOther' }],
      links: [{ id: 'workspace-fixture', todoId: ledger.cards[0].id, kind: 'kanban_card', stateSnapshot: 'workspace', repo: 'd:\\repos\\rocketx\\' }] });
  });
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作', exact: true });
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue('');
  const projects = form.getByRole('combobox', { name: '选择已有项目目录', exact: true });
  await expect(projects.locator('option')).toHaveCount(2);
  await projects.selectOption('D:/Repos/RocketX');
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue('D:/Repos/RocketX');
  await form.getByLabel('要完成什么').fill('保留当前工作草稿');
  await form.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue('D:/Repos/RocketX');
  await expect(form.getByLabel('要完成什么')).toHaveValue('保留当前工作草稿');
  const selected = 'D:\\Projects\\Exact Space';
  await page.evaluate((selected) => { (window as any).__workDirectoryChoice = async () => selected; }, selected);
  await form.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue(selected);
  await form.getByRole('button', { name: '加入待开始', exact: true }).click();
  expect(await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const ledger = useWorkLedger.getState(); const card = ledger.cards.find((item: any) => item.title === '保留当前工作草稿');
    return { repo: ledger.links.find((item: any) => item.todoId === card.id && item.stateSnapshot === 'workspace').repo,
      sessions: ledger.sessions.filter((item: any) => item.todoId === card.id).length };
  })).toEqual({ repo: selected, sessions: 0 });
  const calls = await page.evaluate(() => (window as any).__workFirstCalls);
  expect(calls.filter((call: any) => call.command === 'plugin:dialog|open').map((call: any) => call.input.options)).toEqual([
    { directory: true, multiple: false, title: '选择工作目录' }, { directory: true, multiple: false, title: '选择工作目录' },
  ]);
  expect(calls.filter((call: any) => typeof call === 'string' || /process_start|process_write|handoff|start_turn/.test(call.command))).toEqual([]);
});

test('文件夹浏览的迟到结果不串入关闭重开的工作或切换后的账号', async ({ page }) => {
  const board = await mountWorkList(page);
  await page.evaluate(() => { (window as any).__workDirectoryChoice = () => new Promise((resolve) => { (window as any).__finishDirectoryChoice = resolve; }); });
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = board.getByRole('form', { name: '交代新工作', exact: true });
  await form.getByLabel('要完成什么').fill('第一项工作');
  await form.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await form.getByRole('button', { name: '收起，保留新工作草稿', exact: true }).click();
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  await form.getByLabel('要完成什么').fill('另一项工作');
  await form.getByLabel('工作目录', { exact: true }).fill('D:/different-target');
  await page.evaluate(() => (window as any).__finishDirectoryChoice('D:/late-first-work'));
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue('D:/different-target');
  await form.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [{ useAuth }, account, { resolveButlerAccountScope }] = await Promise.all([load('/src/stores/auth.ts'), load('/src/platform/butlerAccountReady.ts'), load('/src/stores/butlerMemory.ts')]);
    useAuth.setState({ user: { ...useAuth.getState().user, _id: 'folder-picker-next-account' } });
    account.beginButlerAccountSelection(resolveButlerAccountScope()).activate({ accountScope: resolveButlerAccountScope(), generation: 1 });
  });
  await board.getByRole('button', { name: '新建工作', exact: true }).click();
  await form.getByLabel('要完成什么').fill('新账号的目标');
  await form.getByLabel('工作目录', { exact: true }).fill('D:/next-account-project');
  await page.evaluate(() => (window as any).__finishDirectoryChoice('D:/late-prior-account'));
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue('D:/next-account-project');
  await expect(form.getByLabel('要完成什么')).toHaveValue('新账号的目标');
  expect(await page.evaluate(() => (window as any).__workFirstCalls.filter((call: any) => typeof call === 'string' || /process_start|process_write|handoff|start_turn/.test(call.command)))).toEqual([]);
});

test('后续会话和当前验证确认恢复后，历史错误退出待处理，独立待回答仍保留', async ({ page }) => {
  const board = await mountWorkList(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const state = useWorkLedger.getState();
    const original = state.cards[0];
    const source = state.sessions[0];
    const now = Date.now();
    const cards = ['recovered', 'still-waiting'].map((id) => ({
      ...original, id, title: id === 'recovered' ? '已恢复的旧错误' : '独立问题仍待回答',
      state: { ...original.state, todoId: id, stage: 'verifying' },
    }));
    useWorkLedger.setState({
      cards, actions: [],
      sessions: cards.flatMap((card: any) => [
        { ...source, id: `${card.id}-old`, todoId: card.id, runtimeStatus: card.id === 'recovered' ? 'error' : 'waiting_input', updatedAt: now - 3000 },
        { ...source, id: `${card.id}-new`, todoId: card.id, runtimeStatus: 'idle', updatedAt: now - 2000 },
      ]),
      evidences: cards.map((card: any) => ({
        id: `verified-${card.id}`, todoId: card.id, kind: 'test_run', passed: true, stale: false,
        title: '恢复验证通过', summary: '当前版本已验证恢复', verifiedAt: now - 1000,
      })),
    });
  });
  await expect(board.getByRole('region', { name: '需要你', exact: true })).not.toContainText('已恢复的旧错误');
  await expect(board.getByRole('region', { name: '结果待看', exact: true })).toContainText('已恢复的旧错误');
  await expect(board.getByRole('region', { name: '需要你', exact: true })).toContainText('独立问题仍待回答');
});

for (const changedScope of ['account', 'runtime'] as const) {
  test(`保存新工作期间切换${changedScope === 'account' ? '登录账号' : '运行账号'}，不把旧目录绑定到新账号或跳转`, async ({ page }) => {
    const board = await mountWorkList(page);
    await page.evaluate(async () => {
      const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
      const [{ useWorkLedger }, { useUI }] = await Promise.all([load('/src/stores/workLedger.ts'), load('/src/stores/ui.ts')]);
      useUI.getState().setButlerView('kanban');
      const template = useWorkLedger.getState().cards[0];
      (window as any).__newWorkBinds = [];
      useWorkLedger.setState({ createCard: () => new Promise((resolve) => {
        (window as any).__finishWorkFirstPreparation = () => resolve({ ...template, id: 'stale-created-work', title: '旧账号工作' });
      }), upsertLink: async (input: unknown) => { (window as any).__newWorkBinds.push(input); return input; } });
    });
    await board.getByRole('button', { name: '新建工作', exact: true }).click();
    const form = board.getByRole('form', { name: '交代新工作', exact: true });
    await form.getByLabel('要完成什么').fill('仅属于旧账号的工作');
    await form.getByLabel('工作目录').fill('D:/old-project');
    await form.getByRole('button', { name: '加入待开始', exact: true }).click();
    await expect(form.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
    await page.evaluate(async (changedScope) => {
      const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
      if (changedScope === 'account') {
        const { useAuth } = await load('/src/stores/auth.ts');
        useAuth.setState({ user: { ...useAuth.getState().user, _id: 'new-work-first-account' } });
      } else {
        const { useCodexWorkspace } = await load('/src/stores/codexWorkspace.ts');
        useCodexWorkspace.setState({ scope: 'new-work-first-runtime-scope' });
      }
      (window as any).__finishWorkFirstPreparation();
    }, changedScope);
    await expect(board.getByRole('heading', { name: '旧账号工作', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__newWorkBinds)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__workFirstCalls.filter((call: unknown) => call === 'startThread'))).toHaveLength(0);
    expect(await page.evaluate(async () => (await new Function('return import("/src/stores/ui.ts")')()).useUI.getState().butlerView)).toBe('kanban');
  });
}
