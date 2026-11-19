import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountWorkboard(page: Page, options: { delayedDiscovery?: boolean } = {}) {
  await bootAuthenticated(page);
  await page.evaluate(async (options) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [React, ReactDOM, { default: Board }, { useWorkLedger }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkKanbanBoard.tsx'), load('/src/stores/workLedger.ts'),
    ]);
    const card = await useWorkLedger.getState().createCard({
      title: '修复重复发送', priority: 3, projectKey: 'RocketX',
      goal: '网络恢复后保留原消息，避免重复汇报', stage: 'in_progress',
      acceptance: ['恢复后没有重复消息'],
    });
    const session = {
      id: 'native-source-b', todoId: card.id, runtime: 'acp', origin: 'native_cli',
      nativeSessionId: 'same-id', sourceScope: 'codex:source-b', title: '修复重复发送',
      workspaceRoot: 'D:/Repos/RocketX', visibility: 'private', runtimeStatus: 'unknown',
      accountScope: localStorage.getItem('rcx-owner'), hostDeviceId: null, controlEndpoint: null,
      controlMode: 'readonly', controlReason: 'unknown_external_writer',
      configSnapshotJson: JSON.stringify({ provider: 'codex', preset: 'codex-acp', preview: '正在排查重连时重复发出汇报的路径' }),
      updatedAt: Date.now(), createdAt: Date.now(), lastVerifiedAt: Date.now(),
    };
    useWorkLedger.setState({
      cards: [{ ...card, state: { ...card.state, waitState: 'blocked', waitReason: '缺少允许测试的工作项链接', nextStep: '验证重连后的投递记录' } }],
      sessions: [session], evidences: [], actions: [], events: [], hydrated: true, loading: false,
      hydrate: async () => {},
    });
    const runtime = window as any;
    runtime.__workboardIpc = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: () => 0, unregisterCallback: () => {},
      invoke: async (command: string, input: unknown) => {
        runtime.__workboardIpc.push({ command, input });
        if (command === 'acp_local_session_messages') return [{ id: 'm1', role: 'user', text: '请修复重复发送并保留原消息标识', timestamp: Date.now() }];
        if (command === 'acp_agent_list' || command === 'acp_agent_discover') return [];
        return null;
      },
    } });
    if (options.delayedDiscovery) {
      const bridge = await load('/src/agent/superAgentBridge.ts');
      let attempt = 0;
      let initialDiscovery = true;
      const initialRejects: Array<(reason: Error) => void> = [];
      runtime.__failInitialDiscovery = () => {
        initialDiscovery = false;
        for (const reject of initialRejects) reject(new Error('会话目录暂不可读'));
      };
      bridge.setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => {
        attempt += 1;
        runtime.__discoveryAttempts = attempt;
        if (initialDiscovery) return new Promise((_resolve, reject) => { initialRejects.push(reject); });
        return [];
      } });
    }
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'workboard-usability'; host.style.cssText = 'height:100vh;display:flex';
    document.body.append(host);
    const ReactApi = React.default ?? React;
    (ReactDOM.default ?? ReactDOM).createRoot(host).render(ReactApi.createElement(ReactApi.StrictMode, null, ReactApi.createElement(Board)));
  }, options);
}

test('工作卡说明项目、目标、摘要和具体阻碍，普通优先级不制造紧急与审批噪声', async ({ page }, testInfo) => {
  await mountWorkboard(page);
  const board = page.locator('#workboard-usability');
  const card = board.getByRole('button', { name: '修复重复发送', exact: true }).locator('..');
  await expect(card).toContainText('RocketX');
  // 列表优先展示当前阻碍，完整目标与来源摘要在详情中读取。
  await expect(card).toContainText('缺少允许测试的工作项链接');
  await expect(card).not.toContainText('紧急');
  await expect(card).not.toContainText('建议确认');
  await expect(card).not.toContainText('待验证证据');
  await page.screenshot({ path: testInfo.outputPath('workboard-readable-card.png') });
});

test('初次扫描完整结束前不批量加入，导入页刷新成功同时清除工作台旧错误', async ({ page }) => {
  await mountWorkboard(page, { delayedDiscovery: true });
  const board = page.locator('#workboard-usability');
  await board.getByRole('button', { name: /添加已有会话/ }).click();
  const importer = board.getByRole('region', { name: '添加已有会话' });
  await importer.getByRole('button', { name: '批量整理', exact: true }).click();
  await test.info().attach('initial-discovery-attempts', { body: JSON.stringify(await page.evaluate(() => ({ attempts: (window as any).__discoveryAttempts }))), contentType: 'application/json' });
  await expect(importer.getByRole('button', { name: /^加入当前范围/ })).toBeDisabled();
  await expect(importer.getByRole('status')).toContainText('正在发现本机会话');
  await page.evaluate(() => (window as any).__failInitialDiscovery());
  await expect(board.getByRole('alert').first()).toContainText('会话目录暂不可读');
  await importer.getByRole('button', { name: '刷新列表' }).click();
  await expect(board.getByRole('alert')).toHaveCount(0);
  await expect(importer.getByRole('button', { name: /^加入当前范围/ })).toBeEnabled();
  await expect(importer).toContainText('修复重复发送');
});

test('工作卡只读会话可直接查看对话，不启动或接续执行器', async ({ page }) => {
  await mountWorkboard(page);
  const board = page.locator('#workboard-usability');
  const card = board.getByRole('button', { name: '修复重复发送', exact: true }).locator('..');
  await card.getByRole('button', { name: /查看.*Codex|Codex.*查看|查看对话/ }).click();
  const preview = page.getByRole('dialog', { name: '会话记录' });
  await expect(preview).toContainText('请修复重复发送并保留原消息标识');
  const calls = await page.evaluate(() => (window as any).__workboardIpc);
  const historyReads = calls.filter((call: any) => call.command === 'acp_local_session_messages');
  expect(historyReads.length).toBeGreaterThan(0);
  for (const read of historyReads) expect(read.input).toMatchObject({ provider: 'codex', sessionId: 'same-id', sourceScope: 'codex:source-b', limit: 24 });
  expect(calls.some((call: any) => /process_start|process_write|handoff|start_turn/.test(call.command))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
});

test('窄窗卡片正文可换行且页面不产生横向溢出', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await mountWorkboard(page);
  const board = page.locator('#workboard-usability');
  const card = board.getByRole('button', { name: '修复重复发送', exact: true }).locator('..');
  expect((await card.boundingBox())!.width).toBeGreaterThanOrEqual(240);
  await expect(card).toContainText('缺少允许测试的工作项链接');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workboard-readable-half-screen.png') });
  await card.getByRole('button', { name: '修复重复发送', exact: true }).click();
  const portal = board.locator('aside');
  await expect.poll(async () => (await portal.boundingBox())!.y).toBeLessThanOrEqual(80);
  const bounds = (await portal.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(760);
  await portal.getByText('工作要求', { exact: true }).click();
  await expect(portal.locator('p').filter({ hasText: '网络恢复后保留原消息，避免重复汇报' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workboard-detail-half-screen.png') });
});

test('多项工作按四列呈现，需处理与未核实工作分别归组', async ({ page }, testInfo) => {
  await mountWorkboard(page);
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    const first = useWorkLedger.getState().cards[0];
    useWorkLedger.setState({ cards: [first, ...['补齐回归测试', '整理发布说明'].map((title, index) => ({
      ...first, id: `other-work-${index}`, title,
      state: { ...first.state, todoId: `other-work-${index}`, waitState: 'none', waitReason: null,
        goal: index === 0 ? '覆盖断线恢复和重复投递的行为' : '说明本次修复和已验证的结果',
        nextStep: index === 0 ? '检查测试结果' : '汇总验证记录' },
    }))] });
  });
  const board = page.locator('#workboard-usability');
  const kanban = board.getByRole('region', { name: '工作看板', exact: true });
  await expect(kanban.getByRole('region')).toHaveCount(4);
  await expect(kanban.getByRole('region', { name: '需要你', exact: true }).getByRole('button', { name: '修复重复发送', exact: true })).toBeVisible();
  const saved = kanban.getByRole('region', { name: '待开始', exact: true });
  await expect(saved.getByRole('button', { name: '补齐回归测试', exact: true })).toBeVisible();
  await expect(saved.getByRole('button', { name: '整理发布说明', exact: true })).toBeVisible();
  await expect(saved).toContainText('执行状态未核实');
  await expect(kanban.getByRole('region', { name: '正在推进', exact: true }).getByRole('button')).toHaveCount(0);
  const firstColumn = await saved.boundingBox();
  const secondColumn = await kanban.getByRole('region', { name: '正在推进', exact: true }).boundingBox();
  expect(secondColumn!.x).toBeGreaterThanOrEqual(firstColumn!.x + firstColumn!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workboard-four-columns.png') });
});
