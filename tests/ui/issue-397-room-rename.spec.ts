import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

type RoomKind = 'discussion' | 'private' | 'channel';

async function openRenameFixture(page: Page, kind: RoomKind, rejectName = false) {
  const { pageErrors } = await bootAuthenticated(page);
  const rid = 'room-general';
  let room = {
    _id: rid, t: kind === 'channel' ? 'c' : 'p',
    name: kind === 'discussion' ? 'random-discussion-id' : 'original-room', fname: '原有群',
    ...(kind === 'discussion' ? { prid: 'parent-room' } : {}), usersCount: 1,
  };
  let sub = { ...room, _id: 'sub-general', rid, open: true, unread: 0, alert: false };
  const requests: Record<string, string>[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/api/v1/')[1];
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', json: body });
    if (endpoint === 'rooms.get') return json({ update: [room] });
    if (endpoint === 'subscriptions.get') return json({ update: [sub] });
    if (endpoint === 'subscriptions.getOne') return json({ subscription: sub });
    if (endpoint === 'rooms.info') return json({ room });
    if (endpoint === 'groups.members' || endpoint === 'channels.members') {
      return json({ members: [{ _id: 'user-me', username: 'tester' }], total: 1 });
    }
    if (endpoint === 'rooms.saveRoomSettings') {
      const body = route.request().postDataJSON() as Record<string, string>;
      requests.push(body);
      if (rejectName) return json({ success: false, error: 'Invalid name', errorType: 'error-invalid-room-name' }, 400);
      // 模拟 RC 的两种持久化语义，且不发实时事件：客户端必须自行回读。
      room = { ...room, fname: body.roomName, name: kind === 'discussion' ? room.name : 'server-generated-slug' };
      sub = { ...sub, fname: room.fname, name: room.name };
      return json({ success: true, rid });
    }
    return route.fallback();
  });
  await page.reload();
  await openInfo(page, '原有群');
  return { requests, pageErrors, room: () => room };
}

async function openInfo(page: Page, name: string) {
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: name }).click();
  await page.getByTitle('查看群信息').first().click();
  await page.getByTitle('编辑群名称').click();
  await expect(page.getByRole('textbox', { name: '群名称', exact: true })).toHaveValue(name);
}

for (const kind of ['discussion', 'private', 'channel'] as const) {
  test(`${kind} 已有房间中文改名后列表、群信息和刷新结果一致（issue #397）`, async ({ page }) => {
    const state = await openRenameFixture(page, kind);
    for (const name of ['需求评审', 'CNC 方案评审（修订）🎉']) {
      await page.getByRole('textbox', { name: '群名称', exact: true }).fill(name);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '群名称', exact: true })).toHaveCount(0);
      await expect(page.locator('button[title*="右键更多操作"]').filter({ hasText: name })).toBeVisible();
      expect(state.requests.at(-1)).toEqual({ rid: 'room-general', roomName: name });
      expect(state.room().name).toBe(kind === 'discussion' ? 'random-discussion-id' : 'server-generated-slug');
      await page.reload();
      await openInfo(page, name);
    }
    expect(state.requests).toHaveLength(2);
    expect(state.pageErrors).toEqual([]);
  });
}

test('中文组合输入的 Enter/Escape 不提交或关闭，结束后 Enter 只保存一次', async ({ page }) => {
  const state = await openRenameFixture(page, 'discussion');
  const input = page.getByRole('textbox', { name: '群名称', exact: true });
  await input.fill('研发讨论');
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await expect(input).toBeVisible();
  expect(state.requests).toEqual([]);
  await input.evaluate((element) => {
    // 同一事件循环内连续 Enter，React 尚未来得及渲染 busy 状态。
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await expect(input).toHaveCount(0);
  expect(state.requests).toEqual([{ rid: 'room-general', roomName: '研发讨论' }]);
  expect(state.pageErrors).toEqual([]);
});

test('服务端限制中文时保留旧名称并提示命名设置，不产生假成功', async ({ page }) => {
  const state = await openRenameFixture(page, 'private', true);
  const input = page.getByRole('textbox', { name: '群名称', exact: true });
  await input.fill('需求评审');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('服务器不接受此房间名称，请联系管理员检查房间命名设置')).toBeVisible();
  await expect(input).toHaveValue('原有群');
  expect(state.requests).toEqual([{ rid: 'room-general', roomName: '需求评审' }]);
  expect(state.room().fname).toBe('原有群');
  expect(state.pageErrors).toEqual([]);
});
