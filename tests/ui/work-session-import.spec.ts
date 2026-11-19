import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountImport(page: Page, count = 35) {
  await page.evaluate(async (size) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, domModule, { default: Import }, { useWorkLedger }, { useAuth }, { setSuperAgentRuntimeDriversForTests }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkSessionImport.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/auth.ts'), load('/src/agent/superAgentBridge.ts'),
    ]);
    const runtime = window as any;
    runtime.__importCreates = []; runtime.__importReads = []; runtime.__importSelected = []; runtime.__importClosed = 0; runtime.__importExecution = [];
    runtime.__importFailId = null; runtime.__importDeferred = false; runtime.__historyDeferred = false; runtime.__historyFailure = false;
    runtime.__historyResolvers = [];
    const now = Date.now();
    const sessions = Array.from({ length: size }, (_, index) => ({
      id: `session-${index}`, sourceScope: index % 2 ? 'claude-home' : 'codex-home', todoId: null,
      visibility: 'private', runtime: 'acp', origin: 'native_cli', nativeSessionId: `native-${index}`,
      title: `现有工作 ${String(index).padStart(2, '0')}`, workspaceRoot: index % 2 ? 'D:/Beta' : 'D:/Alpha',
      environmentId: null, accountScope: null, controlEndpoint: null, controlMode: 'readonly', controlReason: 'external_activity_unknown',
      hostDeviceId: null, writerLeaseOwner: null, writerLeaseExpiresAt: null, runtimeStatus: 'unknown',
      configSnapshotJson: JSON.stringify({ provider: index % 2 ? 'claude' : 'codex', preset: index % 2 ? 'claude-code' : 'codex-acp',
        sourcePath: `C:/fixture/${index}.jsonl`, preview: `原始会话摘要 ${index}` }), lastEventSeq: null, lastTurnId: null,
      lastVerifiedAt: now, createdAt: now - index * 60_000, updatedAt: now - index * 60_000,
    }));
    sessions.push({ ...sessions[0], id: 'old-session', nativeSessionId: 'old-native', title: '归档历史工作', updatedAt: now - 20 * 86_400_000 });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async (command: string, args: any) => {
      if (/^(acp_local_session_handoff|butler_native_work_(resume|submit))$/.test(command)) runtime.__importExecution.push(command);
      if (command !== 'acp_local_session_messages') return null;
      runtime.__importReads.push(args);
      if (runtime.__historyFailure) throw new Error('历史文件暂不可读');
      if (runtime.__historyDeferred) return new Promise((resolve) => runtime.__historyResolvers.push(resolve));
      return [{ id: 'message-one', role: 'user', text: `来自 ${args.sessionId} 的实际历史`, timestamp: Date.now() }];
    }, transformCallback: () => 0, unregisterCallback: () => {} } });
    setSuperAgentRuntimeDriversForTests({ discoverLocalSessions: async () => { throw new Error('本机目录扫描失败'); } });
    useWorkLedger.setState({ cards: [], sessions,
      createCard: async (input: any) => {
        runtime.__importCreates.push(input);
        if (input.title === runtime.__importFailId) throw new Error('模拟保存失败');
        const card = { id: `card-${input.requestId}`, title: input.title };
        if (runtime.__importDeferred) await new Promise((resolve) => { runtime.__importResolveCreate = resolve; });
        useWorkLedger.setState({ cards: [...useWorkLedger.getState().cards, card] }); return card;
      },
      upsertSession: async (input: any) => {
        const next = { ...useWorkLedger.getState().sessions.find((item: any) => item.nativeSessionId === input.nativeSessionId), ...input };
        useWorkLedger.setState({ sessions: useWorkLedger.getState().sessions.map((item: any) => item.id === next.id ? next : item) }); return next;
      },
    });
    runtime.__switchImportAccount = () => useAuth.setState({ user: { _id: 'second-import-account', username: 'second' } });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div'); host.id = 'import-under-test'; host.style.cssText = 'height:100vh;display:flex;flex-direction:column;padding:12px;max-width:1100px;margin:auto'; document.body.append(host);
    const React = reactModule.default ?? reactModule; const { createRoot } = domModule.default ?? domModule;
    const root = createRoot(host); runtime.__unmountImport = () => root.unmount();
    root.render(React.createElement(Import, { onSelectWork: (id: string) => runtime.__importSelected.push(id), onClose: () => { runtime.__importClosed += 1; root.unmount(); } }));
  }, count);
  await expect(page.getByRole('region', { name: '添加已有会话' })).toBeVisible();
}

test('只读记录可直接预览或单独加入工作，返回已有工作不重复创建', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page, 3);
  await expect(page.getByRole('button', { name: '批量整理', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^选择 现有工作/ })).toHaveCount(0);
  const row = page.locator('[data-session-id="session-0"]');
  await row.getByRole('button', { name: '查看记录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '会话记录' })).toContainText('来自 native-0 的实际历史');
  expect(await page.evaluate(() => (window as any).__importCreates)).toEqual([]);
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: '加入我的工作', exact: true }).click();
  await expect(row.getByRole('button', { name: '打开工作', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__importCreates.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__importSelected)).toEqual([]);
  await row.getByRole('button', { name: '打开工作', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__importSelected.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__importCreates.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__importExecution)).toEqual([]);
});

test('可能接续的原 Codex 会话先进入交接，保留原端确认；损坏记录仍可直接预览', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page, 3);
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [{ useWorkLedger }, { resolveButlerAccountScope }, { agentDeviceId }] = await Promise.all([
      load('/src/stores/workLedger.ts'), load('/src/stores/butlerMemory.ts'), load('/src/agent/device.ts'),
    ]);
    useWorkLedger.setState((state: any) => ({ sessions: state.sessions.map((session: any) => {
      if (!['session-0', 'session-2'].includes(session.id)) return session;
      return { ...session, hostDeviceId: agentDeviceId(), accountScope: resolveButlerAccountScope(),
        controlReason: session.id === 'session-0' ? 'external_activity_unknown' : 'corrupt_or_partial_log',
        configSnapshotJson: JSON.stringify({ ...JSON.parse(session.configSnapshotJson), executionProfileId: 'original-profile' }) };
    }) }));
  });
  const candidate = page.locator('[data-session-id="session-0"]');
  await expect(candidate).toContainText('先停止原窗口中的执行');
  const damaged = page.locator('[data-session-id="session-2"]');
  await expect(damaged.getByRole('button', { name: '准备接续', exact: true })).toHaveCount(0);
  await expect(damaged.getByRole('button', { name: '查看记录', exact: true })).toBeVisible();
  await candidate.getByRole('button', { name: '准备接续', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__importSelected.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__importExecution)).toEqual([]);
});

test('默认最近7天，分页可找到第31条，筛选和搜索明确当前加入范围', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page);
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  await expect(page.getByText('当前范围 35 个 · 已发现 36 个')).toBeVisible();
  await expect(page.locator('[data-session-id]')).toHaveCount(30);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('[data-session-id="session-34"]')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索已有会话' }).fill('现有工作 34');
  await expect(page.locator('[data-session-id]')).toHaveCount(1);
  await page.getByRole('button', { name: '加入当前范围 1 个' }).click();
  await expect(page.getByRole('status')).toHaveText('本次结果：新增 1 个 · 已加入 0 个 · 失败 0 个');
  await expect(page.getByRole('button', { name: '打开工作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加入当前范围 1 个' }).click();
  await expect(page.getByRole('status')).toHaveText('本次结果：新增 0 个 · 已加入 1 个 · 失败 0 个');
  expect(await page.evaluate(() => (window as any).__importCreates.length)).toBe(1);
  await page.getByRole('textbox', { name: '搜索已有会话' }).fill('');
  await page.getByRole('combobox', { name: '会话来源' }).selectOption('claude');
  await expect(page.locator('[data-session-id]')).toHaveCount(17);
  await page.getByRole('combobox', { name: '会话来源' }).selectOption('all');
  await page.getByRole('combobox', { name: '项目目录' }).selectOption('D:/Beta');
  await expect(page.locator('[data-session-id]')).toHaveCount(17);
  await page.getByRole('combobox', { name: '项目目录' }).selectOption('all');
  await page.getByRole('combobox', { name: '会话时间范围' }).selectOption('all');
  await expect(page.getByText('当前范围 36 个 · 已发现 36 个')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索已有会话' }).fill('归档历史');
  await expect(page.locator('[data-session-id="old-session"]')).toBeVisible();
});

test('批量加入保留部分失败，可重试，打开工作直达结果；不生成验收或执行请求', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page, 3);
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  await page.evaluate(() => { (window as any).__importFailId = '现有工作 01'; });
  await page.getByRole('checkbox', { name: '选择 现有工作 00', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 现有工作 01', exact: true }).check();
  await page.getByRole('button', { name: '加入所选 2 个' }).click();
  await expect(page.getByRole('status')).toContainText('新增 1 个 · 已加入 0 个 · 失败 1 个');
  await expect(page.getByRole('alert')).toContainText('加入失败：模拟保存失败');
  await page.evaluate(() => { (window as any).__importFailId = null; });
  await page.getByRole('button', { name: '加入所选 2 个' }).click();
  await expect(page.getByRole('status')).toContainText('新增 1 个 · 已加入 1 个 · 失败 0 个');
  await page.locator('[data-session-id="session-01"], [data-session-id="session-1"]').getByRole('button', { name: '打开工作' }).click();
  expect(await page.evaluate(() => (window as any).__importSelected.length)).toBe(1);
  const requests = await page.evaluate(() => (window as any).__importCreates);
  expect(requests.every((input: any) => input.requestId && input.acceptance === undefined && input.boundaries === undefined)).toBe(true);
});

test('仅一个主加入按钮，筛选改变清空旧选择，翻页保留同范围选择', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page);
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  const primaryActions = page.getByRole('button', { name: /^加入(?:所选|当前范围) \d+ 个$/ });
  await expect(primaryActions).toHaveCount(1);
  await expect(primaryActions).toHaveText('加入当前范围 35 个');
  await page.getByRole('checkbox', { name: '选择 现有工作 00', exact: true }).check();
  await expect(primaryActions).toHaveText('加入所选 1 个');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 现有工作 34', exact: true }).check();
  await expect(primaryActions).toHaveText('加入所选 2 个');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择 现有工作 00', exact: true })).toBeChecked();
  await page.getByRole('combobox', { name: '会话来源' }).selectOption('claude');
  await expect(primaryActions).toHaveText('加入当前范围 17 个');
  await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '选择 现有工作 01', exact: true }).check();
  await page.getByRole('combobox', { name: '项目目录' }).selectOption('D:/Beta');
  await expect(primaryActions).toHaveText('加入当前范围 17 个');
  await expect(page.getByRole('checkbox', { name: '选择 现有工作 01', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '选择 现有工作 01', exact: true }).check();
  await page.getByRole('textbox', { name: '搜索已有会话' }).fill('现有工作 03');
  await expect(primaryActions).toHaveText('加入当前范围 1 个');
  await primaryActions.click();
  expect(await page.evaluate(() => (window as any).__importCreates.map((input: any) => input.title))).toEqual(['现有工作 03']);
  await page.getByRole('checkbox', { name: '选择 现有工作 03', exact: true }).check();
  await page.getByRole('combobox', { name: '会话时间范围' }).selectOption('all');
  await expect(primaryActions).toHaveText('加入当前范围 1 个');
  await expect(page.getByRole('checkbox', { name: '选择 现有工作 03', exact: true })).not.toBeChecked();
});

test('查看对话走真实只读API参数，加载失败重试、Escape返回原按钮焦点', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page, 2);
  await page.evaluate(() => { (window as any).__historyFailure = true; });
  const trigger = page.locator('[data-session-id="session-0"]').getByRole('button', { name: '查看记录' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '会话记录' });
  await expect(dialog.getByRole('alert')).toContainText('历史文件暂不可读');
  await page.evaluate(() => { (window as any).__historyFailure = false; });
  await dialog.getByRole('button', { name: '重试读取' }).click();
  await expect(dialog.getByText('来自 native-0 的实际历史')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__importReads[0])).toEqual({ provider: 'codex', sessionId: 'native-0', sourcePath: 'C:/fixture/0.jsonl', sourceScope: 'codex-home', limit: 24 });
  expect(await page.evaluate(() => (window as any).__importCreates.length)).toBe(0);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
});

test('账号切换关闭旧预览并丢弃迟到历史，停止旧批次后续加入', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page, 3);
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  await page.evaluate(() => { (window as any).__historyDeferred = true; });
  await page.locator('[data-session-id="session-0"]').getByRole('button', { name: '查看记录' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__historyResolvers.length)).toBe(1);
  await page.getByRole('button', { name: '关闭会话记录' }).click();
  await page.evaluate(() => { (window as any).__importDeferred = true; });
  await page.getByRole('button', { name: '加入当前范围 3 个' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__importCreates.length)).toBe(1);
  await page.evaluate(() => { const runtime = window as any; runtime.__switchImportAccount(); runtime.__historyResolvers[0]([{ id: 'late', role: 'assistant', text: '旧账号隐私内容', timestamp: 1 }]); runtime.__importResolveCreate(); });
  await expect(page.getByRole('region', { name: '添加已有会话' })).toHaveCount(0);
  await expect(page.getByText('旧账号隐私内容')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__importCreates.length)).toBe(1);
});

test('关闭并切换来源后迟到历史不会显示在另一会话下', async ({ page }) => {
  await bootAuthenticated(page); await mountImport(page, 2);
  await page.evaluate(() => { (window as any).__historyDeferred = true; });
  await page.locator('[data-session-id="session-0"]').getByRole('button', { name: '查看记录' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__historyResolvers.length)).toBe(1);
  await page.getByRole('button', { name: '关闭会话记录' }).click();
  await page.locator('[data-session-id="session-1"]').getByRole('button', { name: '查看记录' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__historyResolvers.length)).toBe(2);
  await page.evaluate(() => { const runtime = window as any; runtime.__historyResolvers[0]([{ id: 'old', role: 'assistant', text: '原来源迟到内容', timestamp: 1 }]); });
  await expect(page.getByRole('dialog').getByText('原来源迟到内容')).toHaveCount(0);
  await page.evaluate(() => { const runtime = window as any; runtime.__historyResolvers[1]([{ id: 'new', role: 'assistant', text: 'Claude的本次记录', timestamp: 1 }]); });
  await expect(page.getByRole('dialog').getByText('Claude的本次记录')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__importReads[1])).toMatchObject({ provider: 'claude', sessionId: 'native-1', sourceScope: 'claude-home' });
});

test('刷新失败明确保留已有记录，800px布局与长目录不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 }); await bootAuthenticated(page); await mountImport(page, 3);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState({ sessions: useWorkLedger.getState().sessions.map((session: any, index: number) => index === 0
      ? { ...session, workspaceRoot: `D:/Projects/${'较长的项目目录/'.repeat(18)}` } : session) });
  });
  await page.getByRole('button', { name: '刷新列表' }).click();
  await expect(page.getByRole('alert')).toContainText('本机目录扫描失败');
  await expect(page.locator('[data-session-id]')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('800x700和宽屏的添加按钮、列表、分页可达', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 }); await bootAuthenticated(page); await mountImport(page);
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  const next = page.getByRole('button', { name: '下一页', exact: true });
  await expect(next).toBeInViewport();
  await expect(page.getByRole('button', { name: '加入当前范围 35 个' })).toBeInViewport();
  await page.screenshot({ path: '.omx/logs/workbench-usability-20261116/import-800x700.png' });
  await next.click(); await expect(page.locator('[data-session-id="session-34"]')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.screenshot({ path: '.omx/logs/workbench-usability-20261116/import-1440x1000.png' });
});
