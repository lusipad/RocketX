import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function pinAiRuntime(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-runtime-mode-v1', 'standard');
    localStorage.setItem('rocketx.butler.task-provider', 'deepseek');
  });
}

async function seedSharedAiRoom(
  page: Page,
  options: { openThread?: boolean; ended?: boolean; includeAiMember?: boolean } = {},
) {
  // `bootAuthenticated` returns after navigation, while the app can still be restoring
  // persisted shared-agent sessions. Seed only after the authenticated shell is mounted
  // so that the startup restore cannot overwrite this test session under parallel load.
  await page.getByRole('navigation', { name: 'RocketX 主导航' }).waitFor();
  await page.evaluate(async ({ openThread, ended, includeAiMember }) => {
    const loadChat = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: { setState: (update: (state: Record<string, unknown>) => Record<string, unknown>) => void };
    }>;
    const loadAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<{
      useSharedAgent: { setState: (update: Record<string, unknown>) => void };
    }>;
    const [{ useChat }, { useSharedAgent }] = await Promise.all([loadChat(), loadAgent()]);
    const rid = 'room-ai-mention';
    const rootId = 'thread-ai-mention';
    const root = {
      _id: rootId,
      rid,
      msg: '讨论共享 AI 的使用方式',
      ts: '2026-08-16T08:00:00.000Z',
      u: { _id: 'user-alice', username: 'alice', name: 'Alice' },
    };
    useChat.setState((state) => ({
      ...state,
      activeRid: rid,
      rightPanel: openThread ? { kind: 'thread', mid: rootId } : null,
      subscriptions: {
        [rid]: {
          _id: `sub-${rid}`,
          rid,
          t: 'c',
          name: 'general-test',
          fname: 'general-test',
          open: true,
          unread: 0,
          alert: false,
          ls: '2026-08-16T08:00:00.000Z',
        },
      },
      rooms: {
        [rid]: {
          _id: rid,
          t: 'c',
          name: 'general-test',
          fname: 'general-test',
          usersCount: 2,
          uids: ['user-me', 'user-alice'],
          lm: '2026-08-16T08:00:00.000Z',
        },
      },
      messages: { [rid]: [root] },
      historyLoaded: { [rid]: true },
      hasMore: { [rid]: false },
      members: {
        [rid]: includeAiMember
          ? [{ _id: 'user-ai', username: 'ai', name: 'AI service user' }]
          : [],
      },
      memberErrors: {},
      drafts: {},
    }));
    const key = openThread ? rootId : `room:${rid}`;
    useSharedAgent.setState({
      sessions: {
        [key]: {
          sessionId: 'session-ai-mention',
          rid,
          tmid: key,
          status: ended ? 'ended' : 'ready',
          host: { expiresAt: Date.now() + 60_000 },
        },
      },
      remoteCards: {},
    });
  }, {
    openThread: options.openThread ?? false,
    ended: options.ended ?? false,
    includeAiMember: options.includeAiMember ?? false,
  });
}

test('房间输入 @ai 时优先显示共享 AI 托管候选并可用键盘插入', async ({ page }, testInfo) => {
  await pinAiRuntime(page);
  const { pageErrors } = await bootAuthenticated(page);
  await seedSharedAiRoom(page, { includeAiMember: true });

  const input = page.locator('[data-composer-input]');
  await input.fill('@ai');

  const option = page.getByRole('option', { name: /AI 托管.*@ai/ });
  await expect(option).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: '@ai' })).toHaveCount(1);
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await expect(option).toContainText('房间共享');
  await page.screenshot({ path: testInfo.outputPath('ai-mention.png'), fullPage: true });
  // Use the empty mention query for navigation: the built-in all/here rows are
  // deterministic while pinyin matching finishes loading in the background.
  await input.fill('@');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown');
  await expect(page.locator('#composer-mention-list').getByRole('option').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('ArrowUp');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveValue('@ai ');

  await input.fill('请 @a');
  await input.press('Tab');
  await expect(input).toHaveValue('请 @ai ');

  await input.fill('@ai');
  await input.press('Escape');
  await expect(option).toHaveCount(0);
  await expect(input).toHaveValue('@ai');
  expect(pageErrors).toEqual([]);
});

test('话题回复复用同一条共享会话的 @ai 候选，结束后不再显示', async ({ page }) => {
  await pinAiRuntime(page);
  const { pageErrors } = await bootAuthenticated(page);
  await seedSharedAiRoom(page, { openThread: true });

  const panel = page.locator('aside').filter({ has: page.getByText('话题', { exact: true }) });
  const input = panel.locator('textarea');
  await input.fill('@a');
  const option = panel.getByRole('option', { name: /AI 托管.*@ai/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(input).toHaveValue('@ai ');

  await seedSharedAiRoom(page, { openThread: true, ended: true });
  await input.fill('@ai');
  await expect(panel.getByRole('option', { name: /AI 托管.*@ai/ })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
