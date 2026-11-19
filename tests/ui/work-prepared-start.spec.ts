import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountPreparedWork(page: Page, count: number, longPath = false) {
  await bootAuthenticated(page);
  await page.evaluate(async ({ count, longPath }) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, { default: Detail }, { useWorkLedger }, { useAcpAgents }, memory, device, bridge] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkCardPortal.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'),
      load('/src/stores/butlerMemory.ts'), load('/src/agent/device.ts'), load('/src/agent/superAgentBridge.ts'),
    ]);
    const ledger = useWorkLedger.getState();
    const card = await ledger.createCard({ title: '调查同步中断', goal: longPath ? '定位同步中断并核对提交记录。'.repeat(40) : '定位同步中断', stage: 'ready' });
    const workspaceRoot = longPath ? `D:/Repos/${'long-directory/'.repeat(24)}Sync` : 'D:/Repos/Sync';
    await ledger.upsertLink({ todoId: card.id, kind: 'kanban_card', externalId: card.id, project: 'Sync', repo: workspaceRoot, stateSnapshot: 'workspace' });
    const profileId = 'sync-profile', sourceScope = 'codex:sync-profile';
    useAcpAgents.setState({ hydrate: async () => {}, agents: [{ id: profileId, enabled: true, sourceScope, args: ['--rocketx-acp-bridge=codex'] }], sessions: {} });
    const session = { runtime: 'acp', origin: 'native_cli', workspaceRoot, accountScope: memory.resolveButlerAccountScope(),
      hostDeviceId: device.agentDeviceId(), visibility: 'private', sourceScope, controlMode: 'readonly', controlReason: 'external_activity_unknown', runtimeStatus: 'unknown',
      configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: profileId }) };
    for (const [name, patch] of Object.entries({
      '其他目录': { workspaceRoot: 'D:/Repos/Sync2' }, '其他账号': { accountScope: 'elsewhere' },
      '其他设备': { hostDeviceId: 'other' }, '缺少原配置': { configSnapshotJson: '{"provider":"codex"}' },
      '日志损坏': { controlReason: 'corrupt_or_partial_log' }, '目录失效': { controlReason: 'workspace_missing' },
      '其他工具的发现记录': { origin: 'external_discovered', configSnapshotJson: JSON.stringify({ provider: 'claude', executionProfileId: profileId }) },
      '共享会话': { origin: 'external_discovered', visibility: 'room_shared' },
      '只读原因未知': { controlReason: null },
    })) await ledger.upsertSession({ ...session, ...patch, nativeSessionId: name, title: name });
    for (let index = 1; index <= count; index++) {
      await ledger.upsertSession({ ...session, ...(index === 1 ? { controlMode: 'resumable', controlReason: 'stopped_local_matching_cwd' } : { origin: 'external_discovered' }),
        workspaceRoot: workspaceRoot.toLowerCase().replaceAll('/', '\\'), nativeSessionId: `thread-${index}`, title: `原调查 ${index}` });
    }
    const runtime = window as any;
    runtime.__deliveries = 0;
    bridge.setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, startAcpWorkerTask: () => { runtime.__deliveries++; throw new Error('Unexpected dispatch'); },
      discoverLocalSessions: async () => [{ provider: 'codex', nativeSessionId: 'thread-new', sourceScope, workspaceRoot,
        executionProfileId: profileId, title: '刚打开的原会话', runtimeStatus: 'idle' }] });
    runtime.__preparedBinding = () => ({
      threads: useWorkLedger.getState().sessions.filter((s: any) => s.todoId === card.id).map((s: any) => s.nativeSessionId),
      actions: useWorkLedger.getState().actions.filter((a: any) => a.todoId === card.id).length, deliveries: runtime.__deliveries,
    });
    const root = document.getElementById('root')!; root.style.display = 'none';
    const host = document.createElement('div'); host.style.cssText = 'display:flex;position:fixed;inset:52px 0 0'; document.body.append(host);
    const rootView = (dom.default ?? dom).createRoot(host);
    runtime.__showResult = (resultTarget?: string, resultTurnId?: string, resultSessionId?: string) => rootView.render((react.default ?? react).createElement(Detail, {
      card, layout: 'workspace', resultTarget, resultTurnId, resultSessionId, resultRequest: resultTarget ? {} : undefined, onClose() {},
    }));
    runtime.__showResult();
  }, { count, longPath });
}

test('新工作原位选择同项目原会话，关联不会启动执行或改用上一个项目', async ({ page }) => {
  await mountPreparedWork(page, 2);
  const region = page.getByRole('region', { name: '连接项目会话' });
  const picker = region.getByRole('combobox');
  await expect(picker.getByRole('option')).toHaveCount(3);
  await expect(region.getByRole('button', { name: '继续这个 Codex 会话' })).toBeDisabled();
  await picker.selectOption({ label: '原调查 2' });
  await region.getByRole('button', { name: '继续这个 Codex 会话' }).click();
  await expect(region).toHaveCount(0);
  await expect(page.getByRole('button', { name: '原对话记录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__preparedBinding())).toEqual({ threads: ['thread-2'], actions: 0, deliveries: 0 });
});

for (const width of [940, 390]) {
  test(`唯一候选与继续按钮在 ${width}×640 的首屏可读可点，长目标和长目录按需展开`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 640 });
    await mountPreparedWork(page, 1, true);
    const region = page.getByRole('region', { name: '连接项目会话' });
    await expect(region.getByText('项目 · Sync', { exact: true })).toBeVisible();
    await expect(region.getByText('原调查 1', { exact: true })).toBeVisible();
    const action = region.getByRole('button', { name: '继续这个 Codex 会话' });
    await expect(action).toBeInViewport({ ratio: 1 });
    expect(await action.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await expect(page.getByText(/D:\/Repos\/long-directory\//)).toBeHidden();
    await expect(region.getByText(/定位同步中断并核对提交记录/)).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`prepared-${width}.png`) });
    await page.getByText('工作位置 · 本机').click();
    await expect(page.getByText(/D:\/Repos\/long-directory\//)).toBeVisible();
  });
}

test('新工作没有同目录原会话时明确保留待开始，可刷新并选择发现的记录', async ({ page }) => {
  await mountPreparedWork(page, 0);
  const region = page.getByRole('region', { name: '连接项目会话' });
  await expect(region).toContainText('项目 · Sync');
  await expect(region.getByRole('button', { name: '继续这个 Codex 会话' })).toHaveCount(0);
  await region.getByRole('button', { name: '刷新项目会话' }).click();
  await expect(region).toContainText('刚打开的原会话');
  await expect(region.getByRole('button', { name: '继续这个 Codex 会话' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__preparedBinding())).toEqual({ threads: [], actions: 0, deliveries: 0 });
});

test('新工作缺少已启用的 Codex 配置时可以直接去接入，避免无效刷新', async ({ page }) => {
  await mountPreparedWork(page, 0);
  await page.evaluate(async () => {
    const { useAcpAgents } = await new Function('return import("/src/stores/acpAgents.ts")')();
    useAcpAgents.setState({ agents: [] });
  });
  const region = page.getByRole('region', { name: '连接项目会话' });
  await expect(region.getByRole('button', { name: '刷新项目会话' })).toHaveCount(0);
  await region.getByRole('button', { name: '打开执行器设置' }).click();
  expect(await page.evaluate(async () => {
    const { useUI } = await new Function('return import("/src/stores/ui.ts")')();
    return useUI.getState().butlerView;
  })).toBe('acp-hub');
});

test('同一工作直达验证或指定轮次，等待读取后定位，失效的回复不会跳到其他轮次', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 640 });
  await mountPreparedWork(page, 1);
  await page.evaluate(() => (window as any).__showResult('evidence'));
  await expect(page.getByText(/还没有成果或验证记录。已有对话/)).toBeVisible();
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const { useWorkLedger } = await load('/src/stores/workLedger.ts');
    const account = await load('/src/platform/butlerAccountReady.ts');
    const ledger = useWorkLedger.getState();
    const card = ledger.cards.find((c: any) => c.title === '调查同步中断');
    const session = ledger.sessions.find((s: any) => s.nativeSessionId === 'thread-1');
    account.beginButlerAccountSelection(session.accountScope).activate({ accountScope: session.accountScope, generation: 1 });
    useWorkLedger.setState({ hydrate: async () => {}, sessions: [{ ...session, todoId: card.id, id: 'old-source' },
      { ...session, todoId: card.id, id: 'newer-source', nativeSessionId: 'different-thread', updatedAt: Date.now() + 1000 }],
      evidences: [{ id: 'proof', todoId: card.id, kind: 'test_run', title: '同步链路验证通过', passed: true, criterionIds: [],
        requirementsVersion: card.state.requirementsVersion, contentVersion: card.state.contentVersion, verifiedAt: Date.now() }] });
    const turns = ['first', 'second', 'expired'];
    const binding = { nativeThreadId: session.nativeSessionId, sourceScope: session.sourceScope, executionProfileId: 'sync-profile' };
    const messages = turns.flatMap(turn => [{ id: turn, turnId: turn, role: 'assistant', text: `实际回复 ${turn}` },
      ...Array.from({ length: 16 }, (_, i) => ({ id: `${turn}-${i}`, turnId: turn, role: 'user', text: `待处理要求 ${i}` }))]);
    const snapshot = { protocolVersion: 1, todoId: card.id, sessionId: 'old-source', ...binding,
      bindingVersion: 1, connectionId: 'fixture', connectionStatus: 'connected', runtimeStatus: 'idle', capabilities: {},
      decisions: [], messages, commands: turns.map(turn => ({ actionKind: 'session_prompt', todoId: card.id, sessionId: 'old-source',
        id: `prompt-${turn}`, state: 'completed', receiptRef: JSON.stringify({ nativeThreadId: session.nativeSessionId, nativeTurnId: turn, terminalStatus: 'completed' }),
        specJson: JSON.stringify({ intent: { kind: 'prompt' }, binding, expected: { requirementsVersion: turn === 'expired' ? -1 : card.state.requirementsVersion, contentVersion: card.state.contentVersion } }) })) };
    const runtime = window as any;
    const readGate = new Promise<void>(resolve => { runtime.__finishSnapshot = resolve; });
    runtime.__resultReads = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async (command: string, args: any) => {
      if (command === 'butler_native_work_snapshot') { runtime.__resultReads.push(args.input.sessionId); await readGate; return structuredClone(snapshot); }
      throw new Error(`Unexpected native write: ${command}`);
    } } });
    runtime.__showResult('evidence');
  });
  const detail = page.getByRole('complementary', { name: '工作详情' });
  await expect(detail.getByText('同步链路验证通过', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__showResult('reply', 'first', 'old-source'));
  await expect(detail.getByText('Codex · 正在读取原会话')).toBeVisible();
  await page.evaluate(() => (window as any).__finishSnapshot());
  await expect(detail.locator('[data-native-message-id="first"]')).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => (window as any).__showResult('reply', 'second', 'old-source'));
  await expect(detail.locator('[data-native-message-id="second"]')).toBeInViewport({ ratio: 1 });
  await detail.getByRole('button', { name: /^验证记录/ }).click();
  await expect(detail.getByText('同步链路验证通过', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__showResult('reply', 'second', 'old-source'));
  await expect(detail.locator('[data-native-message-id="second"]')).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => (window as any).__showResult('reply', 'expired', 'old-source'));
  await expect(detail.getByText('这轮回复暂不可核对，可查看原对话记录。')).toBeVisible();
  await expect(detail.locator('[data-native-message-id="expired"]')).not.toBeInViewport();
  await page.evaluate(() => (window as any).__showResult('reply', 'first', 'missing-source'));
  await expect(detail.getByText(/原会话已不在这项工作中/)).toBeVisible();
  await expect(detail.getByRole('region', { name: 'Codex 工作现场' })).toHaveCount(0);
  expect(await page.evaluate(() => [...new Set((window as any).__resultReads)])).toEqual(['old-source']);
});
