import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountPortal(page: Page, options: { ordinary?: boolean; bound?: boolean; unboundCount?: number } = {}) {
  await page.evaluate(async (options) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [react, dom, component, { useWorkLedger }, { useAcpAgents }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/WorkCardPortal.tsx'), load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'),
    ]);
    useAcpAgents.setState({ hydrate: async () => {}, agents: [], sessions: {} });
    const card = await useWorkLedger.getState().createCard({
      title: '修复 RocketX 工作台中的已有会话整理体验',
      goal: options.ordinary ? undefined : '让用户一眼看清已有会话的工作内容，不必先配置执行流程。',
      nextStep: '检查导入候选列表，保留会话来源与原始上下文。',
      acceptance: options.ordinary ? [] : ['只读会话可查看原始对话', '窄窗口可以完整阅读工作详情'],
      enroll: !options.ordinary,
    });
    const count = (options.unboundCount ?? 0) + (options.bound ? 1 : 0);
    for (let index = 0; index < count; index += 1) {
      await useWorkLedger.getState().upsertSession({
        id: `portal-session-${index}`, todoId: options.bound && index === 0 ? card.id : null,
        runtime: 'acp', origin: 'external_discovered', nativeSessionId: `native-session-${index}`,
        title: `Claude 历史会话 ${index + 1}`, workspaceRoot: 'D:\\Repos\\RocketX',
        controlMode: 'readonly', controlReason: null, runtimeStatus: 'unknown',
        configSnapshotJson: JSON.stringify({ provider: 'claude', preset: 'claude', sourcePath: `D:\\Claude\\session-${index}.jsonl`, preview: '用户讨论了如何整理本机已有会话，尚未核对这段记录之后的执行状态。' }),
      });
    }
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'portal-usability-under-test';
    host.style.cssText = 'height:100vh;display:flex;position:relative;overflow:hidden';
    document.body.append(host);
    const React = react.default ?? react;
    const root = (dom.default ?? dom).createRoot(host);
    let selectedWorkId = card.id;
    const originalUpdate = useWorkLedger.getState().updateCard;
    const render = () => root.render(React.createElement(React.StrictMode, null, React.createElement(component.default, {
      card: useWorkLedger.getState().cards.find((item: any) => item.id === selectedWorkId), onClose() {},
    })));
    useWorkLedger.subscribe(render);
    (window as any).__portalSnapshot = () => useWorkLedger.getState().cards.find((item: any) => item.id === selectedWorkId);
    (window as any).__deferPortalSave = () => {
      let deferred = false;
      useWorkLedger.setState({ updateCard: (id: string, patch: any) => {
        if (deferred) return originalUpdate(id, patch);
        deferred = true;
        return new Promise((resolve, reject) => {
          (window as any).__resolvePortalSave = async () => resolve(await originalUpdate(id, patch));
          (window as any).__rejectPortalSave = () => reject(new Error('A 的迟到保存失败'));
        });
      } });
    };
    (window as any).__switchPortalWork = async () => {
      const other = await useWorkLedger.getState().createCard({ title: '另一件工作 B', goal: 'B 的目标', acceptance: ['B 条件'], enroll: true });
      await originalUpdate(other.id, { goal: 'B 的目标第二版' });
      await originalUpdate(other.id, { goal: 'B 的目标第三版' });
      selectedWorkId = other.id;
      render();
    };
    (window as any).__backgroundPortalUpdate = () => originalUpdate(selectedWorkId, { goal: '后台更新了当前工作目标' });
    (window as any).__seedPortalEvidence = (kind: string, passed: boolean, verifiedAt: number, title: string) => {
      const current = useWorkLedger.getState();
      const work = current.cards.find((item: any) => item.id === selectedWorkId);
      useWorkLedger.setState({ evidences: [...current.evidences, {
        id: `evidence-${verifiedAt}`, todoId: selectedWorkId, sessionId: null, kind, title, summary: `来源：${title}`,
        headSha: null, workspaceRoot: null, webUrl: null, passed, stale: false, staleReason: null,
        verifiedAt, createdAt: verifiedAt, requirementsVersion: work.state.requirementsVersion,
        contentVersion: work.state.contentVersion, criterionIds: work.state.acceptance,
      }] });
    };
    render();
  }, options);
}

test('详情先展示目标、来源摘要和下一步，管理配置默认折叠且适配 800px', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await bootAuthenticated(page);
  await mountPortal(page, { bound: true });
  const portal = page.locator('#portal-usability-under-test');
  await expect(portal.getByRole('heading', { name: '修复 RocketX 工作台中的已有会话整理体验' })).toBeVisible();
  await expect(portal.locator('p').filter({ hasText: '让用户一眼看清已有会话的工作内容，不必先配置执行流程。' })).toBeVisible();
  await expect(portal.getByText('会话摘要', { exact: true })).toBeVisible();
  await expect(portal.getByText('用户讨论了如何整理本机已有会话，尚未核对这段记录之后的执行状态。', { exact: true })).toBeVisible();
  await expect(portal.getByText('检查导入候选列表，保留会话来源与原始上下文。', { exact: true })).toBeVisible();
  await expect(portal.getByRole('button', { name: '查看对话', exact: true }).first()).toBeVisible();
  await expect(portal.getByPlaceholder('明确这张卡片最终要收敛的交付目标…')).toBeHidden();
  await expect(portal.getByLabel('最多自动轮次', { exact: true })).toBeHidden();
  await expect(portal.getByLabel('执行目录', { exact: true })).toBeHidden();
  const box = await portal.locator('aside').boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(790);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
  await page.screenshot({ path: '.omx/logs/workbench-usability-20261116/portal-800-current.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(portal.locator('aside')).toHaveCSS('width', '480px');
  await page.screenshot({ path: '.omx/logs/workbench-usability-20261116/portal-1440-current.png', fullPage: true });
});

test('普通未跟进工作不显示暂停或接管停止，执行配置需显式展开', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page, { ordinary: true });
  const portal = page.locator('#portal-usability-under-test');
  await expect(portal.getByRole('button', { name: /暂停自动跟进|恢复自动跟进|接管并停止本轮/ })).toHaveCount(0);
  await expect(portal.getByLabel('执行目录', { exact: true })).toBeHidden();
  await portal.getByRole('button', { name: '设置执行方式', exact: true }).click();
  await portal.getByText('开始执行', { exact: true }).click();
  await expect(portal.getByLabel('执行目录', { exact: true })).toBeVisible();
});

test('只读会话查看对话不进入恢复控制路径，未知状态不显示正常', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page, { bound: true });
  const portal = page.locator('#portal-usability-under-test');
  await portal.getByText('更多', { exact: true }).click();
  await portal.getByRole('button', { name: /^会话/ }).click();
  await expect(portal.getByText(/状态：活动状态未知/)).toBeVisible();
  await expect(portal.getByText(/控制说明：正常/)).toHaveCount(0);
  await portal.getByRole('button', { name: '查看对话', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('只读会话不能直接恢复', { exact: false })).toHaveCount(0);
});

test('绑定已有会话支持搜索，列表第 35 条仍可到达', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page, { unboundCount: 35 });
  const portal = page.locator('#portal-usability-under-test');
  await portal.getByText('更多', { exact: true }).click();
  await portal.getByRole('button', { name: /^会话/ }).click();
  await expect(portal.getByLabel('搜索可关联的会话', { exact: true })).toBeVisible();
  await portal.getByLabel('搜索可关联的会话', { exact: true }).fill('Claude 历史会话 35');
  await expect(portal.getByText('Claude 历史会话 35', { exact: true })).toBeVisible();
  await portal.getByRole('button', { name: '绑定到此卡', exact: true }).click();
  await portal.getByText('更多', { exact: true }).click();
  await expect(portal.getByRole('button', { name: '会话 (1)', exact: true })).toBeVisible();
});

test('保存中的新输入不被迟到回执清为已保存草稿', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#portal-usability-under-test');
  await portal.getByRole('button', { name: '编辑工作要求', exact: true }).click();
  await portal.getByText('编辑目标与下一步', { exact: true }).click();
  const goal = portal.getByPlaceholder('明确这张卡片最终要收敛的交付目标…');
  await goal.fill('正在保存的第一稿');
  await page.evaluate(() => (window as any).__deferPortalSave());
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await goal.fill('保存期间继续输入的第二稿');
  await page.evaluate(() => (window as any).__resolvePortalSave());
  await page.evaluate(() => (window as any).__backgroundPortalUpdate());
  await expect(goal).toHaveValue('保存期间继续输入的第二稿');
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await expect(portal.getByRole('alert')).toContainText(/版本|要求/);
});

test('A 保存迟到成功后不会改写 B 的草稿身份与 CAS 版本', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#portal-usability-under-test');
  await portal.getByRole('button', { name: '编辑工作要求', exact: true }).click();
  await portal.getByText('编辑目标与下一步', { exact: true }).click();
  const goal = portal.getByPlaceholder('明确这张卡片最终要收敛的交付目标…');
  await goal.fill('保存 A 的目标');
  await page.evaluate(() => (window as any).__deferPortalSave());
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await page.evaluate(() => (window as any).__switchPortalWork());
  await expect(portal.getByRole('heading', { name: '另一件工作 B' })).toBeVisible();
  await portal.getByRole('button', { name: '编辑工作要求', exact: true }).click();
  await portal.getByText('编辑目标与下一步', { exact: true }).click();
  await expect(goal).toHaveValue('B 的目标第三版');
  await goal.fill('继续编辑 B 的目标');
  await page.evaluate(() => (window as any).__resolvePortalSave());
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__portalSnapshot().state.goal)).toBe('继续编辑 B 的目标');
  await expect(portal.getByRole('alert')).toHaveCount(0);
});

test('A 保存迟到错误不显示在 B 的工作详情', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#portal-usability-under-test');
  await portal.getByRole('button', { name: '编辑工作要求', exact: true }).click();
  await portal.getByText('编辑目标与下一步', { exact: true }).click();
  await portal.getByPlaceholder('明确这张卡片最终要收敛的交付目标…').fill('保存 A 的目标');
  await page.evaluate(() => (window as any).__deferPortalSave());
  await portal.getByRole('button', { name: '保存简报', exact: true }).click();
  await page.evaluate(() => (window as any).__switchPortalWork());
  await page.evaluate(() => (window as any).__rejectPortalSave());
  await expect(portal.getByRole('heading', { name: '另一件工作 B' })).toBeVisible();
  await expect(portal.getByRole('alert')).toHaveCount(0);
});

test('同版本先通过后失败时详情显示最新失败，不把执行者声明当验证', async ({ page }) => {
  await bootAuthenticated(page);
  await mountPortal(page);
  const portal = page.locator('#portal-usability-under-test');
  await page.evaluate(() => (window as any).__seedPortalEvidence('test_run', true, 100, '旧测试通过'));
  await page.evaluate(() => (window as any).__seedPortalEvidence('test_run', false, 200, '新测试发现回归失败'));
  await expect(portal.getByText('新测试发现回归失败', { exact: true })).toBeVisible();
  await expect(portal.getByText('未通过', { exact: true })).toBeVisible();
  await expect(portal.getByText('旧测试通过', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__seedPortalEvidence('agent_report', true, 300, '执行者声称已修复'));
  await expect(portal.getByText('执行者声称已修复', { exact: true })).toBeVisible();
  await expect(portal.getByText('执行者说明 · 未核验', { exact: true })).toBeVisible();
  await expect(portal.getByText('通过', { exact: true })).toHaveCount(0);
});
