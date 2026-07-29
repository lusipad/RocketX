import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function seedComposerRoom(
  page: Page,
  roomType: 'c' | 'd',
  roomId = roomType === 'd' ? 'room-direct' : 'room-channel',
  options: { openThread?: boolean } = {},
) {
  await page.evaluate(async ({ roomType, roomId, openThread }) => {
    const load = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        setState: (
          update: (state: Record<string, unknown>) => Record<string, unknown>,
        ) => void;
      };
    }>;
    const { useChat } = await load();
    const rootMessage = {
      _id: `thread-root-${roomId}`,
      rid: roomId,
      msg: roomType === 'd' ? 'DM 线程根消息' : '群聊线程根消息',
      ts: '2026-07-29T08:00:00.000Z',
      u: { _id: 'user-alice', username: 'alice', name: 'Alice' },
    };
    useChat.setState((state) => ({
      ...state,
      activeRid: roomId,
      rightPanel: openThread ? { kind: 'thread', mid: rootMessage._id } : null,
      subscriptions: {
        [roomId]: {
          _id: `sub-${roomId}`,
          rid: roomId,
          t: roomType,
          name: roomType === 'd' ? 'alice' : 'general',
          fname: roomType === 'd' ? 'Alice' : 'General',
          open: true,
          unread: 0,
          alert: false,
          ls: '2026-07-29T08:00:00.000Z',
        },
      },
      rooms: {
        [roomId]: {
          _id: roomId,
          t: roomType,
          name: roomType === 'd' ? 'alice' : 'general',
          fname: roomType === 'd' ? 'Alice' : 'General',
          usersCount: roomType === 'd' ? 2 : 3,
          uids: roomType === 'd' ? ['user-me', 'user-alice'] : ['user-me', 'user-alice', 'user-bob'],
          lm: '2026-07-29T08:00:00.000Z',
        },
      },
      messages: { [roomId]: [rootMessage] },
      historyLoaded: { [roomId]: true },
      hasMore: { [roomId]: false },
      members: {},
      memberErrors: {},
      drafts: {},
    }));
  }, { roomType, roomId, openThread: options.openThread ?? false });
}

test('群聊保留提及入口，而一对一私聊隐藏入口并禁止候选/搜索', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  const searchPaths: string[] = [];
  for (const endpoint of ['directory', 'users.list', 'spotlight']) {
    await page.route(`**/api/v1/${endpoint}**`, async (route) => {
      searchPaths.push(new URL(route.request().url()).pathname);
      await route.fallback();
    });
  }

  await seedComposerRoom(page, 'c');
  const textbox = page.locator('[data-composer-input]');
  const mentionButton = page.getByTitle('提及成员');

  await expect(textbox).toBeVisible();
  await expect(mentionButton).toBeVisible();

  await seedComposerRoom(page, 'c', 'room-channel', { openThread: true });
  const threadPanel = page.locator('aside').filter({ has: page.getByText('话题', { exact: true }) });
  await expect(threadPanel).toBeVisible();
  await expect(threadPanel.getByTitle('提及成员')).toBeVisible();

  await seedComposerRoom(page, 'd');
  await expect(mentionButton).toHaveCount(0);

  await textbox.click();
  await textbox.fill('@');
  await expect(textbox).toHaveValue('@');
  await page.waitForTimeout(450);
  await expect(page.getByText('通知所有人', { exact: true })).toHaveCount(0);
  await expect(page.getByText('通知在线成员', { exact: true })).toHaveCount(0);
  await expect(page.getByText('非群成员', { exact: true })).toHaveCount(0);

  await seedComposerRoom(page, 'd', 'room-direct', { openThread: true });
  await expect(threadPanel).toBeVisible();
  await expect(threadPanel.getByTitle('提及成员')).toHaveCount(0);
  expect(searchPaths).toEqual([]);
  expect(pageErrors).toEqual([]);
});
