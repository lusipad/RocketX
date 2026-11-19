import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountWork(page: Page) {
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, component, { useWorkLedger }, { useAcpAgents }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkCardPortal.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'),
    ]);
    useAcpAgents.setState({ hydrate: async () => {}, agents: [], sessions: {} });
    const card = await useWorkLedger.getState().createCard({ title: '验收工作', goal: '交付修复', acceptance: ['测试通过', '交互符合预期'], enroll: true });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'acceptance-under-test';
    host.style.cssText = 'height:100vh;display:flex';
    document.body.append(host);
    const React = react.default ?? react;
    const root = (dom.default ?? dom).createRoot(host);
    const render = () => root.render(React.createElement(component.default, { card: useWorkLedger.getState().cards.find((item: any) => item.id === card.id), onClose() {} }));
    useWorkLedger.subscribe(render);
    (window as any).__acceptanceSnapshot = () => ({ card: useWorkLedger.getState().cards.find((item: any) => item.id === card.id), evidence: useWorkLedger.getState().evidences.filter((item: any) => item.todoId === card.id) });
    (window as any).__changeRequirements = () => useWorkLedger.getState().updateCard(card.id, { goal: '另一执行端已修改要求' });
    render();
  });
}

test('人工接受明确选择条件、记录操作者，返工保留工作并使原证据失效', async ({ page }) => {
  await bootAuthenticated(page);
  await mountWork(page);
  const portal = page.locator('#acceptance-under-test');
  await portal.getByRole('button', { name: /^成果与验证/ }).click();
  await portal.getByText('验收与验证管理', { exact: true }).click();
  const accept = portal.getByRole('button', { name: '接受所选条件并完成' });
  await expect(accept).toBeDisabled();
  await portal.getByLabel('接受条件：测试通过', { exact: true }).check();
  await expect(accept).toBeDisabled();
  await portal.getByLabel('接受条件：交互符合预期', { exact: true }).check();
  await accept.click();
  await expect.poll(async () => page.evaluate(() => (window as any).__acceptanceSnapshot().card.state.stage)).toBe('done');
  const before = await page.evaluate(() => (window as any).__acceptanceSnapshot());
  expect(before.evidence.at(-1).acceptedBy).toBeTruthy();
  expect(before.evidence.at(-1).acceptanceScope).toEqual(['测试通过', '交互符合预期']);
  await portal.getByRole('button', { name: '在本工作上返工' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__acceptanceSnapshot().card.state.contentVersion)).toBe(before.card.state.contentVersion + 1);
  const after = await page.evaluate(() => (window as any).__acceptanceSnapshot());
  expect(after.card.id).toBe(before.card.id);
  expect(after.card.state.stage).toBe('in_progress');
  expect(after.evidence.every((item: any) => item.stale)).toBe(true);
});

test('后台修改要求不会覆盖正在编辑的简报，旧版本保存会明确冲突', async ({ page }) => {
  await bootAuthenticated(page);
  await mountWork(page);
  const portal = page.locator('#acceptance-under-test');
  await portal.getByRole('button', { name: '编辑工作要求', exact: true }).click();
  await portal.getByText('编辑目标与下一步', { exact: true }).click();
  const goal = portal.getByPlaceholder('明确这张卡片最终要收敛的交付目标…');
  await goal.fill('我正在补充的要求');
  await page.evaluate(() => (window as any).__changeRequirements());
  await expect(goal).toHaveValue('我正在补充的要求');
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await expect(portal.getByRole('alert')).toContainText(/版本|要求/);
  const saved = await page.evaluate(() => (window as any).__acceptanceSnapshot().card.state.goal);
  expect(saved).toBe('另一执行端已修改要求');
  await portal.getByRole('button', { name: '基于当前版本继续编辑' }).click();
  await expect(goal).toHaveValue('我正在补充的要求');
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__acceptanceSnapshot().card.state.goal)).toBe('我正在补充的要求');
});

test('手工证据需明确结果、来源和所覆盖条件', async ({ page }) => {
  await bootAuthenticated(page);
  await mountWork(page);
  const portal = page.locator('#acceptance-under-test');
  await portal.getByRole('button', { name: /^成果与验证/ }).click();
  await portal.getByText('验收与验证管理', { exact: true }).click();
  const record = portal.getByRole('button', { name: '登记验证记录', exact: true });
  await expect(record).toBeDisabled();
  await portal.getByLabel('证据摘要').fill('UI 实测失败');
  await portal.getByLabel('证据来源或日志').fill('手工复现：点击保存后内容消失');
  await portal.getByLabel('证据覆盖：交互符合预期', { exact: true }).check();
  await record.click();
  await expect.poll(async () => page.evaluate(() => (window as any).__acceptanceSnapshot().evidence.length)).toBe(1);
  const snapshot = await page.evaluate(() => (window as any).__acceptanceSnapshot());
  expect(snapshot.evidence[0].passed).toBe(false);
  expect(snapshot.evidence[0].criterionIds).toEqual(['交互符合预期']);
  expect(snapshot.card.state.stage).not.toBe('done');
});
