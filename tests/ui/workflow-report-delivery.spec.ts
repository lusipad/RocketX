import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountReport(page: Page, restore = false) {
  await page.evaluate(async (restoreExisting) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, component, { useWorkLedger }, { useAcpAgents }, { useChat }, { useAuth }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'), load('/src/components/WorkCardPortal.tsx'),
      load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'), load('/src/stores/chat.ts'), load('/src/stores/auth.ts'),
    ]);
    useAcpAgents.setState({ hydrate: async () => {}, agents: [], sessions: {} });
    await useWorkLedger.getState().hydrate();
    const work = restoreExisting ? useWorkLedger.getState().cards.find((item: any) => item.title === '持久汇报工作')
      : await useWorkLedger.getState().createCard({ requestId: 'report-delivery-test', title: '持久汇报工作', goal: '交付并同步', acceptance: ['CI 构建通过'], rid: 'room-general', stage: 'verifying', enroll: true });
    if (!work) throw new Error('未恢复到持久工作');
    useAuth.setState({ status: 'authed', localMode: false, user: { _id: 'user-me', username: 'tester' } });
    useChat.setState({ activeRid: restoreExisting ? 'another-active-room' : 'room-general', subscriptions: { 'room-general': { rid: 'room-general', name: 'general', fname: 'General', t: 'c' } } });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div'); host.id = 'report-under-test'; host.style.cssText = 'height:100vh;display:flex'; document.body.append(host);
    const React = react.default ?? react; const root = (dom.default ?? dom).createRoot(host);
    const render = () => root.render(React.createElement(component.default, { card: useWorkLedger.getState().cards.find((item: any) => item.id === work.id), onClose() {} }));
    useWorkLedger.subscribe(render);
    (window as any).__reportSnapshot = () => useWorkLedger.getState().actions.filter((action: any) => action.actionKind === 'rc_report');
    (window as any).__hydrateReportObjects = () => {
      const current = useWorkLedger.getState();
      useWorkLedger.setState({ cards: structuredClone(current.cards), actions: structuredClone(current.actions), evidences: structuredClone(current.evidences), sessions: structuredClone(current.sessions), links: structuredClone(current.links) });
    };
    render();
  }, restore);
  await page.locator('#report-under-test').getByText('更多', { exact: true }).click();
  await page.locator('#report-under-test').getByRole('button', { name: '汇报', exact: true }).click();
}

async function publish(page: Page) {
  const portal = page.locator('#report-under-test');
  await portal.getByRole('button', { name: '发送到讨论室', exact: true }).click();
  await portal.getByRole('button', { name: '确认发送汇报', exact: true }).click();
  await expect(portal.getByText('对外汇报：已确认送达', { exact: true })).toBeVisible();
}

test('投递触发对象hydrate后仍显示原回执，重复点击不重复发消息', async ({ page }) => {
  const mock = await bootAuthenticated(page); await mountReport(page);
  await publish(page);
  expect(mock.sentMessages).toHaveLength(1);
  const first = await page.evaluate(() => (window as any).__reportSnapshot()[0]);
  await page.evaluate(() => (window as any).__hydrateReportObjects());
  await expect(page.locator('#report-under-test').getByText('对外汇报：已确认送达', { exact: true })).toBeVisible();
  await publish(page);
  expect(mock.sentMessages).toHaveLength(1);
  const actions = await page.evaluate(() => (window as any).__reportSnapshot());
  expect(actions).toHaveLength(1); expect(actions[0].id).toBe(first.id);
});

test('页面重载恢复同内容报告和已选目标讨论室，保留送达状态且不重复发送', async ({ page }) => {
  const mock = await bootAuthenticated(page); await mountReport(page); await publish(page);
  const before = await page.evaluate(() => (window as any).__reportSnapshot()[0]);
  await page.reload(); await page.getByRole('navigation', { name: 'RocketX 主导航' }).waitFor(); await mountReport(page, true);
  await expect(page.locator('#report-under-test').getByText('对外汇报：已确认送达', { exact: true })).toBeVisible();
  await publish(page);
  expect(mock.sentMessages).toHaveLength(1);
  const after = await page.evaluate(() => (window as any).__reportSnapshot());
  expect(after).toHaveLength(1); expect(after[0].id).toBe(before.id);
});
