import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

// 历史：issue #251 曾在一对一私聊里隐藏提及入口（当时认为参与者已确定）；
// issue #353 重新放开 —— DM 出候选（仅限房间内成员），不提供 all/here 广播项；
// 之后应需求再放开 DM 目录搜索：私聊也能 @ 不在会话里的人（只插入文本、不邀请，
// 徽标显示「不在会话中」以区别于群聊的「非群成员」）。
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
    const roomMembers = [
      { _id: 'user-me', username: 'tester', name: 'Test User' },
      { _id: 'user-alice', username: 'alice', name: 'Alice' },
    ];
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
        ...state.subscriptions as Record<string, unknown>,
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
        ...state.rooms as Record<string, unknown>,
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
      messages: { ...state.messages, [roomId]: [rootMessage] },
      historyLoaded: { ...state.historyLoaded as Record<string, boolean>, [roomId]: true },
      hasMore: { ...state.hasMore as Record<string, boolean>, [roomId]: false },
      members: { ...state.members as Record<string, unknown>, [roomId]: roomMembers },
      memberErrors: {},
      drafts: {},
    }));
  }, { roomType, roomId, openThread: options.openThread ?? false });
}

test('群聊与一对一私聊都保留提及入口；DM 出候选、无广播项，也能 @ 会话外的人', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  // 等 init 拉完会话列表（ready）再 seed，否则 init 的 set 会覆盖刚写入的 activeRid/订阅
  await expect(page.getByText('加载会话中…')).toHaveCount(0);
  const searchPaths: string[] = [];
  // 目录搜索固定返回一个会话外用户，验证私聊也能 @ 不在会话里的人
  await page.route('**/api/v1/directory**', async (route) => {
    searchPaths.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: [{ _id: 'user-outsider', username: 'outsider', name: 'Outsider' }],
        total: 1,
        success: true,
      }),
    });
  });

  await seedComposerRoom(page, 'c');
  const textbox = page.locator('[data-composer-input]');
  const mentionButton = page.getByTitle('提及成员');

  await expect(textbox).toBeVisible();
  await expect(mentionButton).toBeVisible();

  await seedComposerRoom(page, 'c', 'room-channel', { openThread: true });
  const threadPanel = page.locator('aside').filter({ has: page.getByText('话题', { exact: true }) });
  await expect(threadPanel).toBeVisible();
  await expect(threadPanel.getByTitle('提及成员')).toBeVisible();

  // 一对一私聊：@ 按钮恢复可见
  await seedComposerRoom(page, 'd');
  await expect(mentionButton).toBeVisible();

  // 键入 @ 出候选：房间成员 + 目录搜到的会话外用户，没有 all/here 广播项
  await textbox.click();
  await textbox.fill('@ali');
  await expect(textbox).toHaveValue('@ali');
  const mentionList = page.locator('#composer-mention-list');
  await expect(mentionList.getByText('Alice', { exact: true })).toBeVisible();
  await expect(mentionList.getByText('@alice', { exact: true })).toBeVisible();
  await expect(mentionList.getByText('通知所有人', { exact: true })).toHaveCount(0);
  await expect(mentionList.getByText('通知在线成员', { exact: true })).toHaveCount(0);

  // 目录搜索 250ms 防抖后发出请求；会话外用户带「不在会话中」标识，不用群聊的「非群成员」
  await expect(mentionList.getByText('@outsider', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(mentionList.getByText('不在会话中', { exact: true })).toBeVisible();
  await expect(page.getByText('非群成员', { exact: true })).toHaveCount(0);
  expect(searchPaths).toContain('/api/v1/directory');

  // DM 话题面板的提及入口也随之恢复
  await seedComposerRoom(page, 'd', 'room-direct', { openThread: true });
  await expect(threadPanel).toBeVisible();
  await expect(threadPanel.getByTitle('提及成员')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
