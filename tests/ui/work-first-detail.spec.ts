import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountDetail(page: Page, readonly = false, withoutNextStep = false) {
  await page.evaluate(async ({ readonly, withoutNextStep }) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, component, { useWorkLedger }, { useAcpAgents }, { useUI }, { resolveButlerAccountScope }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkCardPortal.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'),
      load('/src/stores/ui.ts'), load('/src/stores/butlerMemory.ts'),
    ]);
    const activity = { opened: [] as string[], sends: 0, resumes: 0, starts: 0, closed: 0 };
    (window as any).__detailActivity = activity;
    const card = await useWorkLedger.getState().createCard({
      title: '核对电视端播放方案', goal: '确认官网扫码登录后能否继续播放，并给出实际验证结果。',
      nextStep: withoutNextStep ? undefined : '核对原对话里的验证记录，再决定是否修改。', acceptance: ['保留实际验证结果'], enroll: true,
    });
    const accountScope = resolveButlerAccountScope();
    const session = await useWorkLedger.getState().upsertSession({
      id: 'work-first-source', todoId: card.id, runtime: 'acp', origin: 'external_discovered',
      nativeSessionId: 'original-antigravity-session', workspaceRoot: 'D:\\Repos\\tv', sourceScope: 'native-local', accountScope,
      title: 'Git Code Commit', controlMode: readonly ? 'readonly' : 'controllable', runtimeStatus: readonly ? 'unknown' : 'idle',
      configSnapshotJson: JSON.stringify({ provider: 'antigravity', preset: 'antigravity', agentId: 'original-agent', preview: '原对话正在讨论官网扫码登录，尚未记录实测结论。' }),
    });
    useAcpAgents.setState({
      hydrate: async () => {}, agents: [], activeSessionKey: null,
      sessions: readonly ? {} : { 'original-session-key': {
        sessionKey: 'original-session-key', agentId: 'original-agent', nativeSessionId: session.nativeSessionId,
        acpSessionId: 'bridge-session-id', workspaceRoot: session.workspaceRoot, sourceScope: session.sourceScope,
        accountScope, status: 'ready', title: session.title, linkedTodoId: card.id, messages: [], toolCalls: [], plan: [],
        pendingPermissions: [], stderrLogs: [], turnCount: 0, updatedAt: Date.now(), createdAt: Date.now(),
      } },
      sendPrompt: async () => { activity.sends += 1; },
      resumeLocalSession: async () => { activity.resumes += 1; throw new Error('不应创建或恢复另一会话'); },
      startSession: async () => { activity.starts += 1; throw new Error('不应创建新会话'); },
    });
    useUI.setState({ openAcpHub: (id: string) => {
      activity.opened.push(id);
      const composer = document.createElement('textarea');
      composer.setAttribute('aria-label', '原对话输入'); composer.dataset.workComposer = 'acp';
      composer.dataset.workSessionId = session.nativeSessionId; document.body.append(composer);
    } });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div'); host.id = 'work-first-detail-test';
    host.style.cssText = 'height:100vh;display:flex;position:relative'; document.body.append(host);
    const React = react.default ?? react; const root = (dom.default ?? dom).createRoot(host);
    const render = () => root.render(React.createElement(React.StrictMode, null, React.createElement(component.default, {
      card: useWorkLedger.getState().cards.find((item: any) => item.id === card.id), layout: 'page',
      onClose: () => { activity.closed += 1; },
    })));
    useWorkLedger.subscribe(render); render();
  }, { readonly, withoutNextStep });
}

test('工作详情默认突出目标和下一步，管理信息按需打开，全宽页面没有窄侧栏', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await bootAuthenticated(page); await mountDetail(page);
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await expect(portal.getByRole('heading', { name: '核对电视端播放方案' })).toBeVisible();
  await expect(portal.getByText('确认官网扫码登录后能否继续播放，并给出实际验证结果。', { exact: true })).toBeVisible();
  await expect(portal.getByRole('button', { name: '继续这项工作' })).toBeVisible();
  await expect(portal.getByText('验收条件', { exact: true })).toHaveCount(0);
  await expect(portal.getByRole('button', { name: /^会话/ })).toBeHidden();
  await expect(portal.getByLabel('最多自动轮次')).toHaveCount(0);
  expect((await portal.boundingBox())!.width).toBeGreaterThan(1200);
  await page.screenshot({ path: '.omx/logs/work-first-redesign-20261116/detail-page.png', fullPage: true });
  await portal.getByRole('button', { name: '编辑工作要求' }).click();
  await expect(portal.getByText('编辑目标与下一步', { exact: true })).toBeVisible();
  await portal.getByRole('button', { name: '返回我的工作' }).click();
  expect(await page.evaluate(() => (window as any).__detailActivity.closed)).toBe(1);
});

test('继续工作定位并聚焦同一个原会话，不额外发送或新建会话', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page);
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await expect(portal.getByText(/将打开 .* 原对话，在那里继续补充要求/)).toBeVisible();
  await portal.getByRole('button', { name: '继续这项工作' }).click();
  await expect(page.getByRole('textbox', { name: '原对话输入' })).toBeFocused();
  expect(await page.evaluate(() => (window as any).__detailActivity)).toEqual({ opened: ['original-agent'], sends: 0, resumes: 0, starts: 0, closed: 0 });
  expect(await page.evaluate(async () => {
    const { useAcpAgents } = await new Function('return import("/src/stores/acpAgents.ts")')();
    return useAcpAgents.getState().activeSessionKey;
  })).toBe('original-session-key');
});

test('只读历史明确能力限制，查看记录不会启动、发送或聚焦执行输入', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page, true);
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await expect(portal.getByText('当前连接仅支持查看记录，不能从这里发送要求。')).toBeVisible();
  await expect(portal.getByText('进展待确认', { exact: true })).toBeVisible();
  await expect(portal.getByText('可执行', { exact: true })).toHaveCount(0);
  await expect(portal.getByRole('button', { name: '继续这项工作' })).toHaveCount(0);
  await portal.getByRole('button', { name: '查看对话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '会话记录' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__detailActivity)).toEqual({ opened: [], sends: 0, resumes: 0, starts: 0, closed: 0 });
  await expect(page.getByRole('textbox', { name: '原对话输入' })).toHaveCount(0);
});

test('导入 Codex 可从工作详情交接原会话，确认前不接管且不发送要求', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page, true);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const account = await new Function('return import("/src/platform/butlerAccountReady.ts")')();
    const card = useWorkLedger.getState().cards[0];
    const session = useWorkLedger.getState().sessions[0];
    account.beginButlerAccountSelection(session.accountScope).activate({ accountScope: session.accountScope, generation: 1 });
    const snapshot = { protocolVersion: 1, todoId: card.id, sessionId: session.id, nativeThreadId: session.nativeSessionId,
      sourceScope: session.sourceScope, executionProfileId: 'original-agent', bindingVersion: 0, connectionId: null,
      connectionStatus: 'disconnected', runtimeStatus: 'idle', activeTurnId: null, capabilities: { resume: true, prompt: false, steer: false, interrupt: false, answer: false, externalLiveAttach: false },
      messages: [], historyTruncated: false, commands: [], decisions: [], cursor: 0, lastEventAt: null, error: null, runtimeVersion: null };
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async (command: string, args: any) => {
      if (command === 'butler_native_work_snapshot') return structuredClone(snapshot);
      if (command === 'acp_local_session_handoff') { (window as any).__handoffAuthorization = args; return 'fixture-only-token'; }
      if (command === 'butler_native_work_resume') { (window as any).__handoffInput = args.input; Object.assign(snapshot, { connectionStatus: 'connected', capabilities: { resume: false, prompt: true, steer: true, interrupt: true, answer: true, externalLiveAttach: false } }); return structuredClone(snapshot); }
      return null;
    } } });
    useWorkLedger.setState((state: any) => ({ sessions: state.sessions.map((session: any) => ({ ...session,
      origin: 'native_cli', configSnapshotJson: JSON.stringify({ provider: 'codex', preset: 'codex-acp', executionProfileId: 'original-agent' }),
    })) }));
  });
  const portal = page.getByRole('complementary', { name: '工作详情' });
  const button = portal.getByRole('button', { name: '在这里继续原会话' });
  await expect(button).toBeDisabled();
  await expect(portal.getByRole('button', { name: '原对话记录', exact: true })).toBeVisible();
  await portal.getByLabel('原 Codex 会话已停止执行').check();
  await page.screenshot({ path: '.omx/logs/codex-import-control-20261117/codex-handoff.png', fullPage: true });
  await button.click();
  await expect(portal.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  const input = await page.evaluate(() => (window as any).__handoffInput);
  const authorization = await page.evaluate(() => (window as any).__handoffAuthorization);
  expect(authorization.profileId).toBe('original-agent');
  expect(input.authorization.sourceScope).toBeTruthy();
  expect(input.authorization.sessionId).toBeTruthy();
  expect(input.sessionId).toBe('work-first-source');
  expect(await page.evaluate(() => (window as any).__detailActivity.sends)).toBe(0);
  expect(await page.evaluate(() => (window as any).__detailActivity.starts)).toBe(0);
});

test('成果入口先提供已有结果，未产生成果时不诱导填验收表，汇报仍可达', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page);
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await portal.getByRole('button', { name: /^成果与验证/ }).click();
  await expect(portal.getByText(/还没有成果或验证记录/)).toBeVisible();
  await expect(portal.getByLabel('证据摘要')).toBeHidden();
  await portal.getByText('更多', { exact: true }).click();
  await portal.getByRole('button', { name: '汇报', exact: true }).click();
  await expect(portal.getByRole('button', { name: '发送到讨论室', exact: true })).toBeVisible();
});

test('只读历史没有明确下一步时只给一个查看指引，不暗示工作可执行', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page, true, true);
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await expect(portal.getByText('仅查看记录', { exact: true })).toBeVisible();
  await expect(portal.getByText('查看原对话，确认当前进展；当前仅支持查看记录。')).toBeVisible();
  await expect(portal.getByRole('heading', { name: '下一步', exact: true })).toHaveCount(0);
  await expect(portal.getByText('可执行', { exact: true })).toHaveCount(0);
});

test('默认详情直接打开当前待决定事项的批准或取消，旧审批不冒充新请求且查看不派发', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const card = useWorkLedger.getState().cards.find((item: any) => item.title === '核对电视端播放方案');
    const createAction = (id: string, patch: any = {}) => ({
      id, idempotencyKey: id, todoId: card.id, eventId: null, sessionId: 'work-first-source', actionKind: 'session_prompt',
      specJson: JSON.stringify({ requirementsVersion: card.state.requirementsVersion, contentVersion: card.state.contentVersion, specText: '仅验证扫码登录结果，暂不修改播放代码。' }),
      state: 'awaiting_approval', receiptRef: null, errorMessage: null, baselineMarker: null, createdAt: 100, updatedAt: 100, ...patch,
    });
    useWorkLedger.setState({ actions: [
      createAction('current-decision'),
      createAction('old-decision', { specJson: JSON.stringify({ requirementsVersion: card.state.requirementsVersion - 1, contentVersion: card.state.contentVersion, specText: '旧版本要求' }) }),
      createAction('completed-decision', { state: 'completed' }),
      createAction('another-work', { todoId: 'other-work-id' }),
    ] });
  });
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await expect(portal.getByRole('region', { name: '待你决定' })).toContainText('有 1 件事需要你决定');
  await expect(portal.getByText('仅验证扫码登录结果，暂不修改播放代码。', { exact: true })).toBeVisible();
  await expect(portal.getByText('旧版本要求', { exact: true })).toHaveCount(0);
  await portal.getByRole('button', { name: '查看待决定事项', exact: true }).click();
  const decision = portal.locator('[data-work-action-id="current-decision"]');
  await expect(decision.getByRole('button', { name: '批准并执行', exact: true })).toBeVisible();
  await expect(decision.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await expect(decision).toContainText('仅验证扫码登录结果，暂不修改播放代码。');
  expect(await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    return useWorkLedger.getState().actions.find((item: any) => item.id === 'current-decision').state;
  })).toBe('awaiting_approval');
  expect(await page.evaluate(() => (window as any).__detailActivity)).toEqual({ opened: [], sends: 0, resumes: 0, starts: 0, closed: 0 });
});

test('旧版本待决定事项保留核对入口，可取消但不能批准执行', async ({ page }) => {
  await bootAuthenticated(page); await mountDetail(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const card = useWorkLedger.getState().cards.find((item: any) => item.title === '核对电视端播放方案');
    useWorkLedger.setState({ actions: [{
      id: 'stale-decision', idempotencyKey: 'stale-decision', todoId: card.id, eventId: null, sessionId: 'work-first-source', actionKind: 'session_prompt',
      specJson: JSON.stringify({ requirementsVersion: card.state.requirementsVersion - 1, contentVersion: card.state.contentVersion, specText: '旧版本要求' }),
      state: 'awaiting_approval', receiptRef: null, errorMessage: null, baselineMarker: null, createdAt: 100, updatedAt: 100,
    }] });
  });
  const portal = page.getByRole('complementary', { name: '工作详情' });
  await expect(portal.getByRole('region', { name: '旧请求待核对' })).toContainText('有 1 条旧请求需要核对');
  await expect(portal.getByRole('button', { name: '查看待决定事项', exact: true })).toHaveCount(0);
  await portal.getByRole('button', { name: '核对旧请求', exact: true }).click();
  const decision = portal.locator('[data-work-action-id="stale-decision"]');
  await expect(decision.getByRole('button', { name: '批准并执行', exact: true })).toBeDisabled();
  await expect(decision).toContainText('请求版本已过期或信息不完整，不能直接批准。');
  await decision.getByRole('button', { name: '取消', exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    return useWorkLedger.getState().actions.find((item: any) => item.id === 'stale-decision').state;
  })).toBe('canceled');
  expect(await page.evaluate(() => (window as any).__detailActivity)).toEqual({ opened: [], sends: 0, resumes: 0, starts: 0, closed: 0 });
});
