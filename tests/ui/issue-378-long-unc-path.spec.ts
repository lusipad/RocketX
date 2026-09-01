import { expect, test, type Route } from '@playwright/test';
import { TEST_SERVER, installRocketChatMock } from './support/rocket-chat-mock';

const ME = { _id: 'user-me', username: 'tester', name: 'Test User', status: 'online' };
// 别人发来的消息靠左：溢出方向朝右，正是聊天区出现横向滚动条的那一侧
const SENDER = { _id: 'user-other', username: 'colleague', name: '同事' };

// 真实场景里的深层共享目录：单个不可断行的 token 远宽于聊天区
const LONG_UNC_PATH =
  '\\\\fileserver-shanghai-01\\研发共享\\2026\\产品线A\\季度评审\\第三方审计\\附件归档\\'
  + 'RocketX-desktop-release-verification-report-20260901-final-v12.pdf';

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', json });
}

test('超长共享路径卡片不把聊天区顶出横向滚动条（issue #378）', async ({ page }) => {
  await installRocketChatMock(page);
  await page.route('**/api/v1/channels.history**', (route) =>
    fulfillJson(route, {
      messages: [{
        _id: 'general-long-unc',
        rid: 'room-general',
        msg: `报告放在这里：${LONG_UNC_PATH}`,
        ts: '2026-09-01T03:00:00.000Z',
        u: SENDER,
      }],
    }));

  await page.addInitScript(({ server, userId }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
  }, { server: TEST_SERVER, userId: ME._id });

  await page.goto('/');
  await page.getByText('General', { exact: true }).first().click();

  // 卡片的可访问名就是路径本身，用 title 定位更稳
  const card = page.locator('button[title="局域网共享路径仅桌面端可打开"]');
  await expect(card).toBeVisible();

  const scroll = page.getByTestId('message-scroll');
  const overflow = await scroll.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  // 卡片本身也不能超出滚动区（否则只是被裁掉，路径完全看不见）
  const fits = await card.evaluate((element, containerScrollWidth) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.width <= containerScrollWidth;
  }, overflow.clientWidth);
  expect(fits).toBe(true);

  // 页面整体也不允许出现横向滚动
  const body = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
});
