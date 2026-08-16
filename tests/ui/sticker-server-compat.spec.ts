import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TEST_SERVER,
  bootAuthenticated,
  installRocketChatMock,
} from './support/rocket-chat-mock';

const ME = { _id: 'user-me', username: 'tester', name: 'Test User', status: 'online' };
const STICKER_NAME = 'rocketx_sticker_twemoji_1f914';
const STICKER_SHORTCODE = `:${STICKER_NAME}:`;
const STICKER_ALIAS = `${STICKER_NAME}_asset`;
const STICKER_PNG = readFileSync(resolve(__dirname, '../../apps/web/public/stickers/twemoji/thinking.png'));
const GIF_STICKER_NAME = 'rocketx_sticker_noto_animated_wave_animated_gif';
const GIF_STICKER_SHORTCODE = `:${GIF_STICKER_NAME}:`;
const GIF_STICKER_ALIAS = `${GIF_STICKER_NAME}_asset`;
const STICKER_GIF = readFileSync(resolve(__dirname, '../../apps/web/public/stickers/noto-animated/wave.gif'));

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', json });
}

async function openGeneral(page: Page) {
  await page.getByText('General', { exact: true }).first().click();
}

test('收到内置贴纸 shortcode 时按 72x72 图片渲染且无文本气泡', async ({ page }, testInfo) => {
  await installRocketChatMock(page);
  await page.route('**/api/v1/channels.history**', (route) =>
    fulfillJson(route, {
      messages: [{
        _id: 'general-sticker-shortcode',
        rid: 'room-general',
        msg: STICKER_SHORTCODE,
        ts: '2026-08-16T03:00:00.000Z',
        u: ME,
      }],
    }));
  await page.route(`**/emoji-custom/${STICKER_NAME}.png`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: STICKER_PNG }));

  await page.addInitScript(({ server, userId }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
  }, { server: TEST_SERVER, userId: ME._id });

  await page.goto('/');
  await openGeneral(page);

  const image = page.locator(`img[alt="${STICKER_NAME}"]`);
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty('naturalWidth', 72);
  await expect(image).toHaveJSProperty('naturalHeight', 72);
  await expect(image).toHaveClass(/h-\[72px\]/);
  await expect(page.getByText(STICKER_SHORTCODE, { exact: true })).toHaveCount(0);
  await expect(page.getByText('thinking.png', { exact: true })).toHaveCount(0);

  const bubble = image.locator('xpath=ancestor::div[contains(@class,"bg-bubble-mine") or contains(@class,"bg-bubble-other")]');
  await expect(bubble).toHaveCount(0);

  const shot = testInfo.outputPath('sticker-shortcode-render.png');
  await image.screenshot({ path: shot });
  testInfo.annotations.push({ type: 'screenshot', description: shot });
});

test('收到内置 GIF 贴纸 shortcode 时按动图资源渲染', async ({ page }) => {
  await installRocketChatMock(page);
  await page.route('**/api/v1/channels.history**', (route) =>
    fulfillJson(route, {
      messages: [{
        _id: 'general-gif-sticker-shortcode',
        rid: 'room-general',
        msg: GIF_STICKER_SHORTCODE,
        ts: '2026-08-16T03:00:00.000Z',
        u: ME,
      }],
    }));
  await page.route(`**/emoji-custom/${GIF_STICKER_NAME}.gif`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/jpeg', body: STICKER_GIF }));

  await page.addInitScript(({ server, userId }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
  }, { server: TEST_SERVER, userId: ME._id });

  await page.goto('/');
  await openGeneral(page);

  const image = page.locator(`img[alt="${GIF_STICKER_NAME}"]`);
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty('naturalWidth', 512);
  await expect(image).toHaveJSProperty('naturalHeight', 512);
  await expect(image).toHaveAttribute('src', /emoji-custom\/rocketx_sticker_noto_animated_wave_animated_gif\.gif/);
  await expect(page.getByText(GIF_STICKER_SHORTCODE, { exact: true })).toHaveCount(0);
});

test('空输入发送内置思考贴纸时复用服务器 emoji shortcode 而不走上传链路', async ({ page }) => {
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  const mediaRequests: string[] = [];
  const emojiLookupRequests: string[] = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    const endpoint = url.pathname.split('/api/v1/')[1] ?? '';
    if (endpoint.startsWith('rooms.media/')) mediaRequests.push(endpoint);
    if (endpoint === 'emoji-custom.all') emojiLookupRequests.push(request.url());
  });

  await page.route('**/api/v1/emoji-custom.all**', (route) =>
    fulfillJson(route, {
      emojis: [{ name: STICKER_NAME, aliases: [STICKER_ALIAS] }],
    }));

  await openGeneral(page);
  await page.getByRole('button', { name: '贴纸' }).click();
  await page.getByPlaceholder('搜索贴纸').fill('思考');
  await page.getByRole('button', { name: '发送贴纸 思考' }).click();

  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]).toMatchObject({ msg: STICKER_SHORTCODE, rid: 'room-general' });
  expect(mediaRequests).toEqual([]);
  expect(emojiLookupRequests).toHaveLength(1);
  await expect(page.getByRole('dialog', { name: '发送文件给 General' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('空输入发送内置 GIF 贴纸时复用服务器动图 shortcode', async ({ page }) => {
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  const mediaRequests: string[] = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    const endpoint = url.pathname.split('/api/v1/')[1] ?? '';
    if (endpoint.startsWith('rooms.media/')) mediaRequests.push(endpoint);
  });

  await page.route('**/api/v1/emoji-custom.all**', (route) =>
    fulfillJson(route, {
      emojis: [{ name: GIF_STICKER_NAME, aliases: [GIF_STICKER_ALIAS] }],
    }));

  await openGeneral(page);
  await page.getByRole('button', { name: '贴纸' }).click();
  await page.getByPlaceholder('搜索贴纸').fill('挥手（动图）');
  await page.getByRole('button', { name: '发送贴纸 挥手（动图）' }).click();

  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]).toMatchObject({ msg: GIF_STICKER_SHORTCODE, rid: 'room-general' });
  expect(mediaRequests).toEqual([]);
  await expect(page.getByRole('dialog', { name: '发送文件给 General' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
