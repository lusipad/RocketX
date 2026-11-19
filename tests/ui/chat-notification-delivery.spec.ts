import { expect, test } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

const room = 'room-general';
const sender = { _id: 'user-alice', username: 'alice', name: 'Alice' };
function message(id: string) {
  return { _id: id, rid: room, msg: id, ts: new Date().toISOString(), u: sender };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission = 'granted';
        constructor(_title: string, options: NotificationOptions) {
          const tags: string[] = JSON.parse(sessionStorage.getItem('test-notifications') || '[]');
          sessionStorage.setItem('test-notifications', JSON.stringify([...tags, options.tag]));
        }
      },
    });
  });
});

test('在其他模块收到上一个会话的消息会提醒，回到消息页才标已读', async ({ page }) => {
  const mock = await bootAuthenticated(page);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/subscriptions.read')) reads.push(request.url());
  });
  await page.getByText('General', { exact: true }).first().click();
  await expect.poll(() => reads.length).toBe(1);
  expect(mock.publish('stream-room-messages', room, [message('actively-reading')])).toBe(true);
  await expect.poll(() => reads.length).toBe(2);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(mock.publish('stream-room-messages', room, [message('while-in-settings')])).toBe(true);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-notifications')))
    .toBe(JSON.stringify(['while-in-settings']));
  expect(reads).toHaveLength(2);
  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: /^消息(?: \d+)?$/ }).click();
  await expect.poll(() => reads.length).toBe(3);
  expect(mock.pageErrors).toEqual([]);
});

test('离开会话后立即到达的新消息不会被待发送的已读确认覆盖', async ({ page }) => {
  const mock = await bootAuthenticated(page);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/subscriptions.read')) reads.push(request.url());
  });
  await page.clock.install();
  await page.evaluate(async () => {
    const { useChat } = await import('/src/stores/chat.ts');
    const { useUI } = await import('/src/stores/ui.ts');
    await useChat.getState().openRoom('room-general');
    useUI.getState().setModule('settings');
  });
  expect(mock.publish('stream-room-messages', room, [message('just-left')])).toBe(true);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-notifications')))
    .toBe(JSON.stringify(['just-left']));
  await page.clock.fastForward(1000);
  expect(reads).toHaveLength(0);
});

test('未打开的房间通过个人通知流提醒，同一消息跨流只提醒一次', async ({ page }) => {
  const mock = await bootAuthenticated(page);
  const first = message('personal-event');
  await page.route('**/api/v1/chat.getMessage?*', (route) => route.fulfill({ json: { message: first } }));
  const event = { title: 'Alice', text: first.msg, payload: {
    _id: first._id, rid: room, sender, message: { msg: first.msg }, type: 'c',
  } };
  expect(mock.publish('stream-notify-user', 'user-me/notification', [event])).toBe(true);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-notifications')))
    .toBe(JSON.stringify([first._id]));
  expect(mock.publish('stream-room-messages', '__my_messages__', [first])).toBe(true);
  expect(mock.publish('stream-room-messages', '__my_messages__', [message('next-message')])).toBe(true);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-notifications')))
    .toBe(JSON.stringify([first._id, 'next-message']));
  expect(mock.pageErrors).toEqual([]);
});
