import { expect, test, type Page, type Route } from '@playwright/test';

const ME = { _id: 'user-me', username: 'tester', name: 'Test User', status: 'online' };
const ALICE = { _id: 'user-alice', username: 'alice', name: 'Alice', status: 'online' };
const NOW = '2026-07-17T08:00:00.000Z';
const SERVER = 'http://127.0.0.1:4173';

const subscriptions = [
  {
    _id: 'sub-general',
    rid: 'room-general',
    t: 'c',
    name: 'general',
    fname: 'General',
    open: true,
    unread: 1,
    alert: true,
    ls: '2026-07-17T07:00:00.000Z',
  },
  {
    _id: 'sub-project',
    rid: 'room-project',
    t: 'c',
    name: 'project-alpha',
    fname: 'Project Alpha',
    open: true,
    unread: 0,
    alert: false,
    ls: NOW,
  },
];

const rooms = [
  {
    _id: 'room-general',
    t: 'c',
    name: 'general',
    fname: 'General',
    usersCount: 2,
    lm: NOW,
    lastMessage: {
      _id: 'general-release',
      rid: 'room-general',
      msg: 'Release checklist ready',
      ts: NOW,
      u: ALICE,
    },
  },
  {
    _id: 'room-project',
    t: 'c',
    name: 'project-alpha',
    fname: 'Project Alpha',
    usersCount: 2,
    lm: NOW,
    lastMessage: {
      _id: 'project-latest',
      rid: 'room-project',
      msg: 'Project plan updated',
      ts: NOW,
      u: ALICE,
    },
  },
];

const histories: Record<string, unknown[]> = {
  'room-general': [
    {
      _id: 'general-release',
      rid: 'room-general',
      msg: 'Release checklist ready',
      ts: NOW,
      u: ALICE,
    },
    {
      _id: 'general-welcome',
      rid: 'room-general',
      msg: 'Welcome to General',
      ts: '2026-07-17T07:30:00.000Z',
      u: ALICE,
    },
  ],
  'room-project': [
    {
      _id: 'project-latest',
      rid: 'room-project',
      msg: 'Project plan updated',
      ts: NOW,
      u: ALICE,
    },
  ],
};

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', json });
}

async function installRocketChatMock(page: Page) {
  const sentMessages: Record<string, unknown>[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/info', (route) => fulfillJson(route, { version: '8.6.1' }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.split('/api/v1/')[1] ?? '';

    if (endpoint === 'login') {
      return fulfillJson(route, {
        status: 'success',
        data: { authToken: 'test-token', userId: ME._id, me: ME },
      });
    }
    if (endpoint === 'settings.public') {
      const id = url.searchParams.get('_id');
      return fulfillJson(route, {
        settings: [{ _id: id, value: id === 'Site_Url' ? 'http://127.0.0.1:4173' : false }],
      });
    }
    if (endpoint === 'subscriptions.get') return fulfillJson(route, { update: subscriptions });
    if (endpoint === 'rooms.get') return fulfillJson(route, { update: rooms });
    if (endpoint === 'commands.list') return fulfillJson(route, { commands: [] });
    if (endpoint === 'users.info') {
      return fulfillJson(route, { user: { ...ME, settings: { preferences: {} } } });
    }
    if (endpoint === 'users.presence') return fulfillJson(route, { users: [ME, ALICE] });
    if (endpoint === 'channels.members') {
      return fulfillJson(route, { members: [ME, ALICE], total: 2 });
    }
    if (endpoint === 'channels.history') {
      const rid = url.searchParams.get('roomId') ?? '';
      return fulfillJson(route, { messages: histories[rid] ?? [] });
    }
    if (endpoint === 'chat.sendMessage') {
      const body = request.postDataJSON() as { message: Record<string, unknown> };
      sentMessages.push(body.message);
      return fulfillJson(route, {
        message: { ...body.message, ts: new Date().toISOString(), u: ME },
      });
    }
    if (endpoint === 'chat.getMessage') return fulfillJson(route, { message: null }, 404);
    if (endpoint.endsWith('.roles')) return fulfillJson(route, { roles: [] });
    return fulfillJson(route, { success: true });
  });

  await page.routeWebSocket('**/websocket', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { msg?: string; id?: string };
      if (message.msg === 'connect') socket.send(JSON.stringify({ msg: 'connected', session: 'ui-smoke' }));
      if (message.msg === 'method' && message.id) {
        socket.send(JSON.stringify({ msg: 'result', id: message.id, result: {} }));
      }
    });
  });

  return { sentMessages, pageErrors };
}

async function bootAuthenticated(page: Page) {
  const state = await installRocketChatMock(page);
  await page.addInitScript(({ server, userId }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
    localStorage.setItem(
      `rcx-onboarding-v1:${encodeURIComponent(server)}:${userId}`,
      JSON.stringify({
        version: 1,
        ado: 'skipped',
        checklist: {
          startedConversation: true,
          sentMessage: true,
          notificationsEnabled: true,
          dismissed: true,
        },
      }),
    );
  }, { server: SERVER, userId: ME._id });
  await page.goto('/');
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  return state;
}

function conversation(page: Page, name: string) {
  return page.locator('button[title*="右键更多操作"]').filter({ hasText: name });
}

test('登录后进入主界面', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.goto('/');
  await expect(page.getByText('RocketChat X', { exact: true })).toBeVisible();
  await page.getByPlaceholder('留空使用当前站点').fill(SERVER);
  await page.getByPlaceholder('请输入用户名或邮箱').fill('tester');
  await page.getByPlaceholder('请输入密码').fill('password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接 Azure DevOps' })).toBeVisible();
  await page.getByRole('button', { name: '暂时跳过' }).click();
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('切换会话会渲染对应历史消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await expect(page.getByText('Welcome to General', { exact: true })).toBeVisible();
  await conversation(page, 'Project Alpha').click();
  await expect(page.getByText('Project plan updated', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('发送消息会乐观上屏并提交一次', async ({ page }) => {
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByPlaceholder(/输入消息/).fill('UI smoke message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('UI smoke message', { exact: true })).toBeVisible();
  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]?.msg).toBe('UI smoke message');
  expect(pageErrors).toEqual([]);
});

test('全局搜索能命中已加载消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '全局搜索' });
  await expect(search).toBeVisible();
  await search.getByPlaceholder(/搜索会话、消息/).fill('release');
  await expect(search.getByText('Release checklist ready', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('会话右键菜单提供常用管理操作', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click({ button: 'right' });
  await expect(page.getByRole('button', { name: '设置备注名' })).toBeVisible();
  await expect(page.getByRole('button', { name: '消息免打扰' })).toBeVisible();
  await expect(page.getByRole('button', { name: '隐藏会话' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('管家提供执行间入口，Codex 不显示为侧栏一级入口', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /管家/ }).click();
  await expect(page.getByText('本地规则处理明确查询，模糊表达由 Codex 解析；写操作始终需要你确认。')).toBeVisible();
  await page.getByRole('button', { name: '执行间', exact: true }).click();
  await expect(page.getByText('执行间', { exact: true })).toBeVisible();
  await expect(page.getByText('管家的本地执行工房：在指定本地目录中运行 Codex 会话；由 Codex 原生沙箱和审批控制命令与文件修改。')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
