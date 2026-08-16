import { expect, test } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

test('贴纸选择器缩小卡片与图片，并包含新增静态和动态贴纸', async ({ page }, testInfo) => {
  const { pageErrors } = await bootAuthenticated(page);

  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await page.getByRole('button', { name: '贴纸' }).click();
  await expect(page.locator('[data-sticker-group="常用回应"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '发送贴纸 OK' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送贴纸 招手' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送贴纸 鼓掌' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送贴纸 火速' })).toBeVisible();

  const picker = page.getByPlaceholder('搜索贴纸').locator('..').locator('..');
  const cards = page.locator('[data-sticker-group="常用回应"] button[aria-label^="发送贴纸 "]');
  await expect(cards).toHaveCount(7);
  const pickerBox = await picker.boundingBox();
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  const third = await cards.nth(2).boundingBox();
  const fourth = await cards.nth(3).boundingBox();
  const firstImage = await cards.nth(0).locator('img').boundingBox();

  expect(pickerBox).not.toBeNull();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(third).not.toBeNull();
  expect(fourth).not.toBeNull();
  expect(firstImage).not.toBeNull();
  expect(pickerBox!.width).toBeCloseTo(320, 0);
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
  expect(Math.abs(second!.y - third!.y)).toBeLessThan(2);
  expect(fourth!.y).toBeGreaterThan(first!.y + 40);
  expect(first!.width).toBeCloseTo(96, 0);
  expect(first!.height).toBeCloseTo(64, 0);
  expect(firstImage!.width).toBeCloseTo(40, 0);
  expect(firstImage!.height).toBeCloseTo(40, 0);

  await picker.screenshot({
    path: testInfo.outputPath('sticker-picker-layout.png'),
  });

  await page.getByPlaceholder('搜索贴纸').fill('动图');
  const animatedCards = picker.getByRole('button', { name: /\u53d1\u9001\u8d34\u7eb8 .*（\u52a8\u56fe）/ });
  await expect(animatedCards).toHaveCount(3);
  const animatedImages = picker.locator('img[src$=".gif"]');
  await expect(animatedImages).toHaveCount(3);
  await expect(animatedImages.first()).toHaveJSProperty('naturalWidth', 512);
  await expect(animatedImages.first()).toHaveJSProperty('naturalHeight', 512);
  await picker.screenshot({
    path: testInfo.outputPath('sticker-picker-animated.png'),
  });
  expect(pageErrors).toEqual([]);
});
