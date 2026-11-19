import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const evidence = '.omx/logs/workspace-layout-20261119';

async function mountBoard(page: Page) {
  await page.route('**/src/main.tsx', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    await load('/src/styles.css');
    const [react, dom, component, { useWorkLedger }, { useAcpAgents }, account, bridge] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkKanbanBoard.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'),
      load('/src/platform/butlerAccountReady.ts'), load('/src/agent/superAgentBridge.ts'),
    ]);
    localStorage.setItem('rcx-owner', 'kanban-fixture');
    account.beginButlerAccountSelection('kanban-fixture').activate({ accountScope: 'kanban-fixture', generation: 1 });
    const runtime = window as any; runtime.__controlCalls = []; const now = Date.now();
    const snapshot = (id: string) => ({ protocolVersion: 1, todoId: `work-${id}`, sessionId: `session-${id}`,
      nativeThreadId: `original-${id}`, sourceScope: 'codex:kanban-fixture', executionProfileId: 'fixture-profile',
      bindingVersion: 1, connectionId: `connection-${id}`, connectionStatus: 'connected', runtimeStatus: 'running',
      activeTurnId: `turn-${id}`, capabilities: { resume: false, prompt: true, steer: true, interrupt: true, answer: true, externalLiveAttach: false },
      messages: [{ id: `message-${id}`, role: 'assistant', text: `正在调查工作 ${id}，尚未验证完成。`, turnId: `turn-${id}`, streaming: false }],
      historyTruncated: false, commands: [], decisions: [], cursor: 1, lastEventAt: now, error: null, runtimeVersion: 'fixture-only' });
    runtime.__controlSnapshots = { 'session-a': snapshot('a'), 'session-b': snapshot('b') };
    const callbacks = new Map<number, (value: unknown) => void>(); let callbackId = 0;
    const listeners = new Map<number, number>(); let listenerId = 0;
    runtime.__emitControlUpdate = (id: string) => { for (const [key, callback] of listeners) callbacks.get(callback)?.({ event: 'native-work-updated', id: key, payload: { accountScope: 'kanban-fixture', sessionId: `session-${id}` } }); };
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { configurable: true, value: { unregisterListener: (_event: string, id: number) => listeners.delete(id) } });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: (callback: (value: unknown) => void) => { const id = ++callbackId; callbacks.set(id, callback); return id; },
      invoke: async (command: string, args: any) => {
        runtime.__controlCalls.push({ command, args }); const input = args?.input;
        if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, args.handler); return id; }
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'butler_native_work_snapshot') return structuredClone(runtime.__controlSnapshots[input.sessionId]);
        if (command === 'butler_native_work_submit') {
          const record = { id: input.command.requestId, idempotencyKey: input.command.requestId, todoId: input.command.todoId,
            sessionId: input.command.sessionId, specJson: JSON.stringify(input.command), state: 'prepared', actionKind: 'session_prompt', createdAt: 1, updatedAt: 1 };
          runtime.__controlSnapshots[input.command.sessionId].commands.push(record); return record;
        }
        throw new Error(`未声明的模拟 IPC: ${command}`);
      },
    } });
    const card = (id: string) => ({ id: `work-${id}`, title: id === 'a' ? '修复登录状态丢失' : '排查下载速度异常', priority: 3, source: 'manual', createdAt: now, updatedAt: now,
      state: { todoId: `work-${id}`, stage: 'in_progress', goal: `只处理工作 ${id} 的问题`, waitState: 'none', requirementsVersion: 2, contentVersion: 3,
        acceptance: ['保留实际验证结果'], dependsOn: [], visibility: 'private', autonomyMode: 'confirm', maxAutoTurns: 5, autoTurnsUsed: 0, consecutiveFailures: 0 } });
    const session = (id: string) => ({ id: `session-${id}`, todoId: `work-${id}`, runtime: 'acp', origin: 'native_cli', nativeSessionId: `original-${id}`,
      sourceScope: 'codex:kanban-fixture', title: `工作 ${id}`, workspaceRoot: `D:/fixture/${id}`, accountScope: 'kanban-fixture', controlMode: 'readonly', runtimeStatus: 'unknown',
      configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: 'fixture-profile' }), createdAt: now, updatedAt: now });
    const prepared = { ...card('prepared'), title: '补齐下载链接过期提示', state: { ...card('prepared').state, stage: 'ready', goal: '链接过期时提供重试入口，并保留原文件名。' } };
    const attention = { ...card('attention'), title: '整理版本发布说明', state: { ...card('attention').state, stage: 'ready', waitState: 'waiting_input', waitReason: '需要确定报告接收范围，尚未发送。' } };
    const result = { ...card('result'), title: '检查断线恢复结果', state: { ...card('result').state, stage: 'verifying' } };
    useWorkLedger.setState({ cards: [card('a'), card('b'), prepared, attention, result], sessions: [session('a'), session('b')], links: [],
      evidences: [{ id: 'fixture-evidence', todoId: result.id, kind: 'test_run', title: '重连验证', summary: '三次重连没有重复投递。', passed: true,
        stale: false, requirementsVersion: 2, contentVersion: 3, verifiedAt: now, createdAt: now }], actions: [], events: [],
      hydrated: true, loading: false, lastError: null, hydrate: async () => {} });
    useAcpAgents.setState({ agents: [], sessions: {}, hydrate: async () => {} });
    bridge.setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [], inspectWorkspaceGit: async () => ({ dirtyFiles: [], isWorktree: false }) });
    document.documentElement.dataset.theme = 'dark';
    const host = document.getElementById('root')!; host.style.cssText = 'display:flex;height:100vh;overflow:hidden';
    (dom.default ?? dom).createRoot(host).render((react.default ?? react).createElement(component.default));
  });
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('2 项最近记录在推进');
}

test('窄窗简报在首屏显示具体阻碍，一次打开对应工作并保留筛选', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mountBoard(page);
  const brief = page.getByRole('region', { name: '管家简报' });
  await expect(brief.getByText('需要确定报告接收范围，尚未发送。', { exact: true })).toBeInViewport();
  const action = brief.getByRole('button', { name: '查看阻碍' });
  await action.click();
  await expect(page.getByRole('complementary', { name: '工作详情' }).getByRole('heading', { name: '整理版本发布说明', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(action).toBeFocused();
  await expect(page.getByRole('button', { name: '全部 5', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('卡片控制只作用对应工作，等待后台回执后才更新列，未知不能冒充执行', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await mountBoard(page);
  const cardA = page.getByRole('button', { name: '修复登录状态丢失', exact: true }).locator('..');
  await cardA.getByRole('button', { name: '停止本轮', exact: true }).click();
  const commands = await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_submit'));
  expect(commands).toHaveLength(1);
  expect(commands[0].args.input.command).toMatchObject({ todoId: 'work-a', sessionId: 'session-a', nativeTurnId: 'turn-a', intent: { kind: 'interrupt' } });
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('2 项最近记录在推进');
  await page.evaluate(() => { const runtime = window as any; Object.assign(runtime.__controlSnapshots['session-a'], { connectionStatus: 'unknown', runtimeStatus: 'unknown', cursor: 2 }); runtime.__emitControlUpdate('a'); });
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('1 项最近记录在推进');
  await expect(page.getByRole('region', { name: '待开始', exact: true })).toContainText('执行状态未核实');
  await expect(page.getByRole('region', { name: '正在推进', exact: true })).toContainText('排查下载速度异常');
  await expect(page.getByRole('region', { name: '正在推进', exact: true })).not.toContainText('修复登录状态丢失');
});

test('简报点回答直接聚焦原卡的问题，保留该卡草稿并等待明确提交', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mountBoard(page);
  await page.evaluate(() => {
    const runtime = window as any;
    Object.assign(runtime.__controlSnapshots['session-b'], { runtimeStatus: 'waiting_input', decisions: [{
      id: 'confirm-target', method: 'item/tool/requestUserInput', nativeThreadId: 'original-b', nativeTurnId: 'turn-b',
      requirementsVersion: 2, bindingVersion: 1, state: 'pending', params: { questions: [{ id: 'target', question: '先检查哪个下载源？' }] },
    }] });
    runtime.__emitControlUpdate('b');
  });
  const brief = page.getByRole('region', { name: '管家简报' });
  await expect(brief).toContainText('先检查哪个下载源？');
  await brief.getByRole('button', { name: '回答问题' }).click();
  const input = page.locator('[data-card-id="work-b"]').getByRole('textbox', { name: '先检查哪个下载源？' });
  await expect(input).toBeFocused();
  await input.fill('备用源');
  await brief.getByRole('button', { name: '回答问题' }).click();
  await expect(input).toHaveValue('备用源');
  expect(await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_answer'))).toEqual([]);
});

test('接续前的旧回复不算新结果，读完成的本轮回复不会再次派工', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await mountBoard(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState((state: any) => ({ cards: state.cards.map((c: any) => c.id === 'work-a' ? { ...c, state: { ...c.state, stage: 'ready' } } : c) }));
    const runtime = window as any;
    Object.assign(runtime.__controlSnapshots['session-a'], { runtimeStatus: 'idle', activeTurnId: null });
    runtime.__emitControlUpdate('a');
  });
  const card = page.locator('[data-card-id="work-a"]');
  await expect(card.getByRole('button', { name: '开始处理' })).toBeEnabled();
  await expect(page.getByRole('region', { name: '待开始', exact: true })).toContainText('修复登录状态丢失');
  await page.evaluate(() => {
    const runtime = window as any; const snap = runtime.__controlSnapshots['session-a'];
    snap.messages.push({ id: 'completed-item', role: 'assistant', turnId: 'finished-a', text: '已修复登录后的跳转。', streaming: false });
    snap.commands.push({ id: 'finished', todoId: 'work-a', sessionId: 'session-a', actionKind: 'session_prompt', state: 'completed',
      specJson: JSON.stringify({ binding: { nativeThreadId: snap.nativeThreadId, sourceScope: snap.sourceScope, executionProfileId: snap.executionProfileId },
        expected: { requirementsVersion: 2, contentVersion: 3 } }), receiptRef: JSON.stringify({ nativeThreadId: snap.nativeThreadId, nativeTurnId: 'finished-a', terminalStatus: 'completed' }) });
    runtime.__emitControlUpdate('a');
  });
  await expect(page.getByRole('region', { name: '结果待看', exact: true })).toContainText('已修复登录后的跳转。');
  await expect(card.getByRole('button', { name: '开始处理' })).toHaveCount(0);
  await card.getByRole('button', { name: '查看结果', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '工作详情' }).getByText('已修复登录后的跳转。', { exact: true }).last()).toBeInViewport();
  expect(await page.evaluate(() => (window as any).__controlCalls.filter((x: any) => x.command === 'butler_native_work_submit'))).toEqual([]);
});

test('停止的工作保留终态，有原连接才能继续同一线程', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await mountBoard(page);
  await page.evaluate(() => {
    const runtime = window as any; Object.assign(runtime.__controlSnapshots['session-a'], { runtimeStatus: 'interrupted', activeTurnId: null });
    runtime.__emitControlUpdate('a');
  });
  const stopped = page.getByRole('region', { name: '已停止', exact: true });
  await expect(stopped).toContainText('本轮已停止');
  await stopped.getByRole('button', { name: '继续工作', exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__controlCalls.filter((x: any) => x.command === 'butler_native_work_submit'));
  expect(calls).toHaveLength(1);
  expect(calls[0].args.input.command).toMatchObject({ todoId: 'work-a', sessionId: 'session-a', intent: { kind: 'prompt', text: '从本轮停止的位置继续完成这项工作。' } });
});

test('持久未决投递优先于旧回复，重开后解释原因且不会重发', async ({ page }) => {
  await mountBoard(page);
  await page.evaluate(() => {
    const runtime = window as any; const snap = runtime.__controlSnapshots['session-a'];
    Object.assign(snap, { activeTurnId: null, runtimeStatus: 'idle', commands: [{
      id: 'unconfirmed-a', actionKind: 'session_prompt', todoId: 'work-a', sessionId: 'session-a', state: 'verifying_delivery',
      specJson: JSON.stringify({ requestId: 'previous-send', intent: { kind: 'prompt', text: '核对重连后的跳转' } }),
      errorMessage: '原端答复超时',
    }] });
    runtime.__emitControlUpdate('a');
  });
  const card = page.getByRole('region', { name: '需要你', exact: true }).locator('[data-card-id="work-a"]');
  await card.getByRole('button', { name: '核对送达' }).click();
  const panel = page.getByRole('complementary', { name: '工作详情' });
  await expect(panel).toContainText('核对重连后的跳转');
  const draft = panel.getByRole('textbox', { name: '补充这项工作的要求' });
  await draft.fill('保留输入'); await draft.press('Enter');
  await expect(draft).toHaveValue('保留输入');
  expect(await page.evaluate(() => (window as any).__controlCalls.filter((x: any) => x.command === 'butler_native_work_submit'))).toEqual([]);
});

test('空项目首条要求已登记时显示等待并移除重复开始入口，原端收到后才计入执行', async ({ page }) => {
  await mountBoard(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState((s: any) => ({ cards: s.cards.map((c: any) => c.id === 'work-a' ? { ...c, state: { ...c.state, stage: 'ready' } } : c) }));
    const runtime = window as any, snap = runtime.__controlSnapshots['session-a'];
    Object.assign(snap, { activeTurnId: null, runtimeStatus: 'idle', messages: [], commands: [{
      id: 'first', todoId: 'work-a', sessionId: 'session-a', actionKind: 'session_prompt', state: 'prepared',
      idempotencyKey: 'native-codex:v1:native-start:work-a', specJson: JSON.stringify({ requestId: 'native-start:work-a' }),
    }] });
    runtime.__emitControlUpdate('a');
  });
  const card = page.locator('[data-card-id="work-a"]');
  await expect(card).toContainText('调查要求已保存，等待执行');
  await expect(card.getByRole('button', { name: '开始处理', exact: true })).toHaveCount(0);
  const brief = page.getByRole('region', { name: '管家简报' });
  await expect(brief).toContainText('1 项最近记录在推进');
  await page.evaluate(() => {
    const runtime = window as any; runtime.__controlSnapshots['session-a'].commands[0].state = 'dispatched';
    runtime.__emitControlUpdate('a');
  });
  await expect(card).toContainText('已提交调查要求，等待 Codex 回执');
  expect(await page.evaluate(() => (window as any).__controlCalls.filter((x: any) => x.command === 'butler_native_work_submit'))).toEqual([]);
});

test('原端等待执行名额留在待开始并显示实际原因，不当作执行失败或已产生成果', async ({ page }) => {
  await mountBoard(page);
  await page.evaluate(() => {
    const runtime = window as any;
    Object.assign(runtime.__controlSnapshots['session-a'], { runtimeStatus: 'idle', activeTurnId: null, cursor: 2,
      admissionWait: { reason: 'execution_slots', message: '两个本机执行名额正在使用，等待空闲后开始。' } });
    runtime.__emitControlUpdate('a');
  });
  await expect(page.getByRole('region', { name: '待开始', exact: true })).toContainText('两个本机执行名额正在使用');
  const queued = page.locator('[data-card-id="work-a"]');
  await expect(queued.getByText('两个本机执行名额正在使用，等待空闲后开始。', { exact: true })).toHaveCount(1);
  await expect(queued.getByRole('button', { name: '开始处理' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '管家简报' })).toContainText('1 项排队中');
  await expect(page.getByRole('region', { name: '结果待看', exact: true })).not.toContainText('修复登录状态丢失');
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('1 项最近记录在推进');
  expect(await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_submit'))).toEqual([]);
});

test('打开的工作被移除后自动返回可操作看板，不遗留不可见覆层或失效焦点锁', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 640 }); await mountBoard(page);
  await page.getByRole('button', { name: '修复登录状态丢失', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '工作详情', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState((state: any) => ({ cards: state.cards.filter((card: any) => card.id !== 'work-a') }));
  });
  await expect(page.getByRole('complementary', { name: '工作详情', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '工作看板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '排查下载速度异常', exact: true }).click();
  await expect(page.getByRole('heading', { name: '排查下载速度异常', exact: true })).toBeVisible();
});

test('宽窗只允许可见工作与现场参与键盘和读屏，覆盖控件在关闭或缩放后正确恢复', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await mountBoard(page);
  await page.getByRole('button', { name: '修复登录状态丢失', exact: true }).click();
  const hiddenFocus: string[] = [];
  for (let index = 0; index < 55; index += 1) {
    await page.keyboard.press('Tab');
    const covered = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      if (!active?.closest('.work-first-board-content')) return null;
      const rect = active.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top?.closest('aside[aria-label="工作详情"]') ? active.textContent?.trim() || active.getAttribute('aria-label') : null;
    });
    if (covered) hiddenFocus.push(covered);
  }
  expect(hiddenFocus).toEqual([]);
  await expect(page.getByRole('button', { name: '新建工作', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '需要你', exact: true })).toHaveCount(0);
  const workB = page.getByRole('button', { name: '排查下载速度异常', exact: true });
  await expect(workB).toBeVisible(); await workB.click();
  await expect(page.getByRole('heading', { name: '排查下载速度异常', exact: true })).toBeVisible();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/focus-safe-1280.png` });
  await writeFile(`${evidence}/focus-safe-1280.json`, JSON.stringify({ viewport: { width: 1280, height: 800 }, tabSteps: 55,
    coveredBackgroundFocused: hiddenFocus, coveredControlsExcludedFromAccessibility: true, visibleLeftWorkSwitchSucceeded: true }, null, 2));
  await page.setViewportSize({ width: 940, height: 640 });
  await expect(page.getByRole('region', { name: '工作看板', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(workB).toBeVisible();
  await page.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建工作', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '需要你', exact: true })).toBeVisible();
});

test('筛选隐藏的工作不继续使用旧原生快照覆盖新账本的未知、结果或待答复事实', async ({ page }) => {
  await mountBoard(page);
  await page.getByRole('button', { name: /需我处理/ }).click();
  const reads = await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_snapshot').length);
  await page.evaluate(async () => {
    const runtime = window as any;
    Object.assign(runtime.__controlSnapshots['session-a'], { runtimeStatus: 'unknown', connectionStatus: 'unknown', cursor: 2 });
    runtime.__emitControlUpdate('a');
  });
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('1 项最近记录在推进');
  expect(await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_snapshot').length)).toBe(reads);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState((state: any) => ({
      cards: state.cards.map((card: any) => card.id === 'work-b' ? { ...card, state: { ...card.state, stage: 'verifying', contentVersion: 4 } } : card),
      sessions: state.sessions.map((session: any) => session.id === 'session-b' ? { ...session, runtimeStatus: 'idle', updatedAt: session.updatedAt + 1 } : session),
      evidences: [...state.evidences, { id: 'new-b-result', todoId: 'work-b', kind: 'agent_report', title: 'B的新输出', summary: '尚待验证的调查结果', passed: false,
        stale: false, requirementsVersion: 2, contentVersion: 4, verifiedAt: Date.now(), createdAt: Date.now() }],
    }));
  });
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('暂无已知执行中的工作');
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('2 项结果可看');
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    Object.assign((window as any).__controlSnapshots['session-b'], { runtimeStatus: 'waiting_approval', cursor: 2 });
    useWorkLedger.setState((state: any) => ({ sessions: state.sessions.map((session: any) => session.id === 'session-b'
      ? { ...session, runtimeStatus: 'waiting_approval', updatedAt: session.updatedAt + 1 } : session) }));
  });
  await expect(page.getByRole('region', { name: '需要你', exact: true })).toContainText('排查下载速度异常');
  await expect(page.getByRole('region', { name: '管家简报', exact: true })).toContainText('暂无已知执行中的工作');
});

test('旧保存成功仍绑定冻结目录，但不能关闭或清空后来填写的新工作草稿', async ({ page }) => {
  await mountBoard(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const template = useWorkLedger.getState().cards[0]; const runtime = window as any; runtime.__firstWorkLinks = [];
    useWorkLedger.setState({ createCard: () => new Promise((resolve) => {
      runtime.__finishFirstWork = () => {
        const card = { ...template, id: 'first-created-work', title: '第一件工作', state: { ...template.state, todoId: 'first-created-work', stage: 'ready', goal: '第一件工作' } };
        useWorkLedger.setState((state: any) => ({ cards: [card, ...state.cards] })); resolve(card);
      };
    }), upsertLink: async (input: unknown) => { runtime.__firstWorkLinks.push(input); return input; } });
  });
  await page.getByRole('button', { name: '新建工作', exact: true }).click();
  const form = page.getByRole('form', { name: '交代新工作', exact: true });
  await form.getByLabel('要完成什么').fill('第一件工作');
  await form.getByLabel('工作目录', { exact: true }).fill('D:/first');
  await form.getByRole('button', { name: '加入待开始', exact: true }).click();
  await form.getByRole('button', { name: '收起，保留新工作草稿', exact: true }).click();
  await page.getByRole('button', { name: '新建工作', exact: true }).click();
  await form.getByLabel('要完成什么').fill('第二件未保存草稿');
  await form.getByLabel('工作目录', { exact: true }).fill('D:/second');
  await page.evaluate(() => (window as any).__finishFirstWork());
  await expect(form).toBeVisible();
  await expect(form.getByLabel('要完成什么')).toHaveValue('第二件未保存草稿');
  await expect(form.getByLabel('工作目录', { exact: true })).toHaveValue('D:/second');
  await expect(form.getByRole('button', { name: '加入待开始', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: '第一件工作', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__firstWorkLinks)).toEqual([expect.objectContaining({ todoId: 'first-created-work', repo: 'D:/first' })]);
});

const layoutEvidence = '.omx/logs/workspace-layout-20261119';

test('紧凑布局按实际容器宽度优先呈现需要你与结果，视觉和DOM顺序一致且不重挂执行控制', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await mountBoard(page);
  const board = page.getByRole('region', { name: '工作看板', exact: true });
  const nativeReads = () => page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_snapshot').length);
  const before = await nativeReads();
  await page.evaluate(() => { document.getElementById('root')!.style.width = '900px'; });
  await expect(board).toHaveAttribute('data-layout', 'list');
  expect(await board.locator(':scope > section').evaluateAll((sections) => sections.map((section) => section.getAttribute('aria-label'))))
    .toEqual(['需要你', '结果待看', '正在推进', '待开始']);
  const attention = (await board.getByRole('region', { name: '需要你', exact: true }).boundingBox())!;
  const results = (await board.getByRole('region', { name: '结果待看', exact: true }).boundingBox())!;
  const active = (await board.getByRole('region', { name: '正在推进', exact: true }).boundingBox())!;
  expect(results.x).toBe(attention.x); expect(results.y).toBeGreaterThan(attention.y + attention.height);
  expect(active.y).toBeGreaterThan(results.y + results.height);
  expect(active.y + 28).toBeLessThan(640);
  const row = board.getByRole('region', { name: '需要你', exact: true }).locator('article').first();
  const title = (await row.locator('.work-first-row-title').boundingBox())!;
  const fact = (await row.locator('.work-first-row-summary').boundingBox())!;
  expect(fact.x).toBeGreaterThan(title.x + title.width);
  expect(Math.abs(fact.y - title.y)).toBeLessThan(3);
  expect((await row.boundingBox())!.height).toBeLessThan(110);
  expect(await nativeReads()).toBe(before);
  await mkdir(layoutEvidence, { recursive: true });
  await page.screenshot({ path: `${layoutEvidence}/container-900-in-1440.png` });
  await page.evaluate(() => { document.getElementById('root')!.style.width = '1280px'; });
  await expect(board).toHaveAttribute('data-layout', 'kanban');
  expect(await board.locator(':scope > section').evaluateAll((sections) => sections.map((section) => section.getAttribute('aria-label'))))
    .toEqual(['待开始', '正在推进', '需要你', '结果待看']);
  expect(await nativeReads()).toBe(before);
});

test('窄窗隐藏空分组，已停止工作保持可达；宽窗已停止独立放在四列下面', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 640 }); await mountBoard(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState((state: any) => {
      const original = state.cards[0];
      return { cards: [...state.cards.filter((card: any) => ['work-a', 'work-b'].includes(card.id)),
        { ...original, id: 'paused-layout-work', title: '暂缓索引修复', state: { ...original.state, todoId: 'paused-layout-work', waitState: 'paused', waitReason: '用户暂缓本轮' } }],
        sessions: [...state.sessions, { ...state.sessions[0], id: 'stopped-layout-session', todoId: 'paused-layout-work', nativeSessionId: 'stopped-layout-native', runtimeStatus: 'interrupted',
          configSnapshotJson: JSON.stringify({ provider: 'claude' }) }],
        evidences: [], actions: [] };
    });
  });
  const board = page.getByRole('region', { name: '工作看板', exact: true });
  await expect(board).toHaveAttribute('data-layout', 'list');
  expect(await board.locator(':scope > section').evaluateAll((sections) => sections.map((section) => section.getAttribute('aria-label'))))
    .toEqual(['正在推进', '已停止']);
  await expect(board.getByRole('button', { name: '暂缓索引修复', exact: true })).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(board).toHaveAttribute('data-layout', 'kanban');
  const stopped = (await board.getByRole('region', { name: '已停止', exact: true }).boundingBox())!;
  const active = (await board.getByRole('region', { name: '正在推进', exact: true }).boundingBox())!;
  expect(stopped.y).toBeGreaterThan(active.y + active.height);
  expect(stopped.width).toBeGreaterThan(active.width * 3);
  await mkdir(layoutEvidence, { recursive: true });
  await board.getByRole('region', { name: '已停止', exact: true }).screenshot({ path: `${layoutEvidence}/stopped-1280.png` });
});

for (const viewport of [{ width: 940, height: 640 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}宽真实通知不遮挡发送，长问题仍可选择并提交回答`, async ({ page }) => {
    await page.setViewportSize(viewport); await mountBoard(page);
    await page.evaluate(async () => {
      const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
      const [react, dom, { default: Toaster }, { useToast }] = await Promise.all([
        load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
        load('/src/components/Toaster.tsx'), load('/src/stores/toast.ts'),
      ]);
      const host = document.createElement('div'); document.body.append(host);
      (dom.default ?? dom).createRoot(host).render((react.default ?? react).createElement(Toaster));
      useToast.getState().show({ kind: 'info', message: '隔离验证通知：正在等待本机执行名额。', duration: 0 });
      useToast.getState().show({ kind: 'loading', message: '保留当前要求并核对后台回执。'.repeat(8), duration: 0 });
    });
    await expect(page.getByText('隔离验证通知：正在等待本机执行名额。', { exact: true })).toBeVisible();
    const workA = page.getByRole('button', { name: '修复登录状态丢失', exact: true });
    await workA.evaluate((element) => element.scrollIntoView({ block: 'center' })); await workA.click();
    const panel = page.getByRole('complementary', { name: '工作详情', exact: true });
    const input = panel.getByRole('textbox', { name: '补充这项工作的要求', exact: true });
    await input.fill('等待答复后继续验证');
    const send = panel.getByRole('button', { name: '发送', exact: true });
    await expect(send).toBeEnabled();
    expect(await send.evaluate((element) => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
    await page.evaluate(() => {
      const runtime = window as any;
      const snapshot = runtime.__controlSnapshots['session-a'];
      snapshot.runtimeStatus = 'waiting_input'; snapshot.cursor += 1;
      snapshot.decisions = [{ id: 'layout-long-question', nativeRequestId: 17, method: 'item/tool/requestUserInput', nativeThreadId: 'original-a', nativeTurnId: 'turn-a',
        requirementsVersion: 2, bindingVersion: 1, state: 'pending', createdAt: Date.now(), params: { reason: '保持当前项目权限范围。'.repeat(100),
          questions: [{ id: 'audience', question: '请核对报告接收范围。'.repeat(100), header: '报告范围', options: [{ label: '仅项目成员' }, { label: '所有用户' }] }] } }];
      const invoke = runtime.__TAURI_INTERNALS__.invoke;
      runtime.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if (command !== 'butler_native_work_answer') return invoke(command, args);
        runtime.__controlCalls.push({ command, args }); snapshot.decisions[0].state = 'answered'; snapshot.runtimeStatus = 'running'; snapshot.cursor += 1;
        return structuredClone(snapshot);
      };
      runtime.__emitControlUpdate('a');
    });
    const choice = panel.getByRole('combobox');
    await choice.scrollIntoViewIfNeeded();
    await choice.selectOption('仅项目成员');
    const submit = panel.getByRole('button', { name: '提交回答', exact: true });
    await expect(submit).toBeEnabled();
    await mkdir(layoutEvidence, { recursive: true });
    await page.screenshot({ path: `${layoutEvidence}/notification-question-${viewport.width}.png` });
    await writeFile(`${layoutEvidence}/notification-question-${viewport.width}.json`, JSON.stringify(await choice.evaluate((element) => {
      const rect = element.getBoundingClientRect(); const body = element.closest('.native-work-decision-body'); const bodyRect = body?.getBoundingClientRect();
      const point = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { choice: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, body: bodyRect ? { x: bodyRect.x, y: bodyRect.y, width: bodyRect.width, height: bodyRect.height } : null,
        pointElement: point?.tagName, pointClass: point?.className, receivesEvents: element.contains(point) };
    }), null, 2));
    expect(await choice.evaluate((element) => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
    expect(await submit.evaluate((element) => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
    await submit.click();
    const answers = await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_answer'));
    expect(answers).toHaveLength(1);
    expect(answers[0].args.input).toMatchObject({ sessionId: 'session-a', decisionId: 'layout-long-question', nativeTurnId: 'turn-a', expectedBindingVersion: 1,
      expectedRequirementsVersion: 2, answer: { answers: { audience: { answers: ['仅项目成员'] } } } });
    await expect(input).toHaveValue('等待答复后继续验证');
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 940, height: 640 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}宽同页现场保留看板位置、工作草稿、输入和返回路径`, async ({ page }) => {
    await page.setViewportSize(viewport); await mountBoard(page); await mkdir(layoutEvidence, { recursive: true });
    const workA = page.getByRole('button', { name: '修复登录状态丢失', exact: true });
    await page.screenshot({ path: `${layoutEvidence}/board-${viewport.width}.png` });
    await workA.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const position = (await workA.boundingBox())!;
    await workA.click();
    const panel = page.getByRole('complementary', { name: '工作详情', exact: true });
    await panel.getByText('工作位置 · 本机', { exact: true }).click();
    await expect(panel.getByText('D:/fixture/a', { exact: true })).toBeVisible();
    const input = panel.getByRole('textbox', { name: '补充这项工作的要求', exact: true });
    await expect(input).toBeEditable(); await input.fill('A 的要求，保留登录前页面');
    const box = (await input.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: `${layoutEvidence}/detail-${viewport.width}.png` });
    await panel.getByRole('button', { name: '返回我的工作', exact: true }).click();
    await expect(workA).toBeFocused();
    expect((await workA.boundingBox())!.x).toBe(position.x); expect((await workA.boundingBox())!.y).toBe(position.y);
    await page.getByRole('button', { name: '排查下载速度异常', exact: true }).click();
    await expect(input).toHaveValue(''); await input.fill('B 的下载调查要求');
    await page.keyboard.press('Escape');
    await workA.click(); await expect(input).toHaveValue('A 的要求，保留登录前页面');
    expect(await page.evaluate(() => (window as any).__controlCalls.filter((call: any) => call.command === 'butler_native_work_submit'))).toEqual([]);
  });
}
