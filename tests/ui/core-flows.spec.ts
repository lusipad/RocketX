import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { sandboxDocument } from '../../apps/web/src/kernel/sandbox/iframe';

const ME = { _id: 'user-me', username: 'tester', name: 'Test User', status: 'online' };
const ALICE = { _id: 'user-alice', username: 'alice', name: 'Alice', status: 'online' };
const NOW = '2026-07-17T08:00:00.000Z';
const SERVER = 'http://127.0.0.1:4173';

function agentCardMessage() {
  const card = {
    version: 1,
    sessionId: 'session-agent-room',
    tmid: 'room:discussion-agent',
    hostUserId: ALICE._id,
    hostUsername: ALICE.username,
    hostDeviceId: 'device-alice',
    leaseExpiresAt: Date.now() + 3_600_000,
    environmentName: 'RocketChat X',
    workItem: { id: 128, project: 'RocketChatX', title: 'Login failure' },
    proposedBranch: 'ai/128-login-failure',
    status: 'active',
  };
  return `🤖 **AI 工作项会话：#128 Login failure**\n主持人：@alice · 状态：运行中\n<!--rocketx-agent:${encodeURIComponent(JSON.stringify(card))}-->`;
}

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
  {
    _id: 'sub-discussion-agent',
    rid: 'discussion-agent',
    t: 'p',
    prid: 'room-general',
    name: '128-login-failure',
    fname: '#128 Login failure',
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
  {
    _id: 'discussion-agent',
    t: 'p',
    prid: 'room-general',
    name: '128-login-failure',
    fname: '#128 Login failure',
    usersCount: 2,
    lm: NOW,
    lastMessage: {
      _id: 'agent-lease-card',
      rid: 'discussion-agent',
      msg: agentCardMessage(),
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
  'discussion-agent': [
    {
      _id: 'agent-lease-card',
      rid: 'discussion-agent',
      msg: agentCardMessage(),
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

  await page.route('**/avatar/**', (route) => route.fulfill({ status: 204 }));
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
    if (endpoint === 'channels.history' || endpoint === 'groups.history') {
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
    if (endpoint === 'rooms.createDiscussion') {
      return fulfillJson(route, {
        discussion: {
          _id: 'discussion-128',
          t: 'p',
          prid: 'room-general',
          name: '128-login-failure',
          fname: '#128 Login failure',
          usersCount: 1,
        },
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

async function bootAuthenticated(
  page: Page,
  options: { expectMessages?: boolean } = {},
) {
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
  }, {
    server: SERVER,
    userId: ME._id,
  });
  await page.goto('/');
  if (options.expectMessages !== false) {
    await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  }
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
  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('打开管家页后可返回消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await expect(page.getByRole('navigation').getByRole('button', { name: '今日', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button', { name: 'AI', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('heading', { name: '管家', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '再看一圈' })).toBeVisible();
  await expect(page.getByText('例行事务', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
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

test('收起分组栏后不产生水平滚动（issue #114）', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-folders', JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
      id: `folder-${index}`,
      name: `非常长的分组名称-${index}`,
      rids: [],
    }))));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '收起分组栏' }).click();
  const aside = page.getByRole('button', { name: '展开分组栏' }).locator('xpath=ancestor::aside');
  await expect(aside).toBeVisible();
  await expect.poll(() => aside.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
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

test('右键回复提交 Rocket.Chat 可展开的官方引用格式（issue #126）', async ({ page }) => {
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByText('Welcome to General', { exact: true }).click({ button: 'right' });
  await page.getByText('回复', { exact: true }).click();
  await page.getByPlaceholder(/输入消息/).fill('Reply from UI');
  await page.getByRole('button', { name: '发送', exact: true }).click();

  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]?.msg).toBe(
    '[ ](http://127.0.0.1:4173/channel/general?msg=general-welcome) Reply from UI',
  );
  expect(pageErrors).toEqual([]);
});

test('消息待办可记录承诺对象并显示在管家里', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByText('Welcome to General', { exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: '标记为待办' }).click();
  const committedTo = page.getByPlaceholder('例如：张三');
  const waitingFor = page.getByPlaceholder('例如：李四');
  await committedTo.fill('张三');
  await waitingFor.fill('李四');
  await expect(committedTo).toHaveValue('');
  await committedTo.fill('张三');
  await expect(waitingFor).toHaveValue('');
  await page.getByRole('button', { name: '加入待办' }).click();
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('heading', { name: '我答应的', exact: true })).toBeVisible();
  await expect(page.getByText('张三', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('编辑旧双值承诺待办时归一化为单一方向', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-todos', JSON.stringify([{
      id: 'legacy-commitment',
      source: 'manual',
      note: '旧双值承诺',
      done: false,
      createdAt: 1,
      committedTo: '张三',
      waitingFor: '李四',
    }]));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^待办/ }).click();
  await page.getByText('旧双值承诺', { exact: true }).hover();
  await page.getByTitle('编辑').click();
  await page.getByRole('button', { name: '保存' }).click();

  const [saved] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('rcx-todos') ?? '[]') as Array<Record<string, unknown>>,
  );
  expect(saved?.committedTo).toBe('张三');
  expect(saved).not.toHaveProperty('waitingFor');
  expect(pageErrors).toEqual([]);
});

test('Azure DevOps 卡片会随聊天栏收窄（issue #116）', async ({ page }) => {
  const workItem = {
    id: 128,
    title: 'A very long work item title that must wrap inside a narrow chat column',
    type: 'Bug',
    state: 'Active',
    priority: 1,
    project: 'RocketChatX-Project-With-A-Very-Long-Name',
    assignedTo: 'Test User',
    webUrl: 'http://ado.example/RocketChatX/_workitems/edit/128',
  };
  await page.route('http://bridge.test/api/ado/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) return fulfillJson(route, { webBase: 'http://ado.example', account: 'tester' });
    if (path.endsWith('/workitems')) return fulfillJson(route, { items: [workItem] });
    if (path.endsWith('/pullrequests')) return fulfillJson(route, { items: [] });
    if (path.endsWith('/builds')) return fulfillJson(route, { items: [] });
    if (path.endsWith('/workitem/128')) return fulfillJson(route, { item: workItem });
    return fulfillJson(route, { success: true });
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({ mode: 'bridge', bridge: 'http://bridge.test', account: 'tester' }));
    localStorage.setItem('rcx-ado-web', 'http://ado.example');
  });
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByPlaceholder(/输入消息/).fill('#128');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const title = page.getByText(workItem.title, { exact: true });
  await expect(title).toBeVisible();
  await page.getByTitle('查看群信息').first().click();
  const card = title.locator('xpath=ancestor::span[contains(@class,"inline-block")]');
  await expect.poll(() => card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('待办里的网址可以直接点击打开（issue #117）', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-todos', JSON.stringify([{
      id: 'todo-with-link',
      source: 'manual',
      note: '查看 https://example.com/work-item',
      done: false,
      createdAt: 1,
    }]));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^待办/ }).click();
  const link = page.getByRole('link', { name: 'https://example.com/work-item' });
  await expect(link).toHaveAttribute('href', 'https://example.com/work-item');
  await expect(link).toHaveAttribute('target', '_blank');
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

test('管家对话提供执行间入口，Codex 不显示为侧栏一级入口', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '展开对话', exact: true }).click();
  await expect(page.getByText('直接告诉我你想了解什么，我会先查证据再回答。')).toBeVisible();
  await page.getByRole('button', { name: '执行间', exact: true }).click();
  await expect(page.getByText('执行间', { exact: true })).toBeVisible();
  await expect(page.getByText('AI 的本地执行区：在指定本地目录中运行 Codex 会话；由 Codex 原生沙箱和审批控制命令与文件修改。')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('管家停靠输入展开对话，收起再打开仍保留上下文', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('textbox', { name: '问管家' }).fill('记住这段桌面对话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('记住这段桌面对话', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '收起对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '再看一圈' })).toBeVisible();
  await page.getByRole('button', { name: '展开对话', exact: true }).click();
  await expect(page.getByText('记住这段桌面对话', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('工作项可创建绑定本地环境的原生讨论', async ({ page }, testInfo) => {
  const workItem = {
    id: 128,
    title: 'Login failure',
    type: 'Bug',
    state: 'Active',
    priority: 1,
    project: 'RocketChatX',
    assignedTo: 'Test User',
    webUrl: 'http://ado.example/RocketChatX/_workitems/edit/128',
  };
  await page.route('http://bridge.test/api/ado/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) return fulfillJson(route, { webBase: 'http://ado.example', account: 'tester' });
    if (path.endsWith('/workitems')) return fulfillJson(route, { items: [workItem] });
    if (path.endsWith('/pullrequests')) return fulfillJson(route, { items: [] });
    if (path.endsWith('/builds')) return fulfillJson(route, { items: [] });
    if (path.endsWith('/workitem/128')) return fulfillJson(route, { item: workItem });
    if (path.endsWith('/workitem/128/comment')) return fulfillJson(route, { success: true });
    return fulfillJson(route, { success: true });
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({ mode: 'bridge', bridge: 'http://bridge.test', account: 'tester' }));
    localStorage.setItem('rcx-ado-web', 'http://ado.example');
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: ['RocketChatX'],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /我的工作项/ }).click();
  await expect(page.getByText('Login failure', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '为工作项 #128 创建讨论' }).click();
  const dialog = page.getByRole('dialog', { name: '为 #128 创建讨论' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('本地环境')).toHaveValue('environment-main');
  await dialog.screenshot({ path: testInfo.outputPath('workitem-discussion-dialog.png') });
  await dialog.getByRole('checkbox').first().uncheck();
  await dialog.getByRole('button', { name: '创建讨论', exact: true }).click();
  await expect.poll(() => sentMessages.some((message) => message.rid === 'discussion-128')).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('工作项 Discussion 在会话头部显著标明由谁的 AI 托管', async ({ page }, testInfo) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, '#128 Login failure').click();
  const badge = page.getByLabel('@alice 的 AI 正在提供服务');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('@alice 的 AI');
  await expect(page.getByText(/rocketx-agent/)).toHaveCount(0);
  await page.locator('main').screenshot({ path: testInfo.outputPath('agent-presence-message.png') });
  await page.locator('main > header').screenshot({ path: testInfo.outputPath('agent-presence-header.png') });
  expect(pageErrors).toEqual([]);
});

test('普通会话进行到一半仍显示唯一的 AI 托管入口', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await expect(page.getByRole('button', { name: '开启 AI 托管' })).toHaveCount(1);
  await page.locator('main > header').screenshot({ path: testInfo.outputPath('conversation-ai-hosting-entry.png') });
  expect(pageErrors).toEqual([]);
});

test('本机托管时再次点击同一按钮会退出且不会打开错误面板', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.goto('/');
  await page.evaluate(async ({ server, me }) => {
    const now = Date.now();
    const deviceId = 'device-ui-local';
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId: me._id }));
    localStorage.setItem('rcx-owner', `${me._id}@${server}`);
    localStorage.setItem('rcx-agent-device-id', deviceId);
    localStorage.setItem(
      `rcx-onboarding-v1:${encodeURIComponent(server)}:${me._id}`,
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
    const session = {
      sessionId: 'session-local-room',
      serverId: server,
      ownerUserId: me._id,
      rid: 'room-general',
      tmid: 'room:room-general',
      host: {
        userId: me._id,
        deviceId,
        heartbeatAt: now,
        expiresAt: now + 90_000,
      },
      access: 'room-members',
      approvedMemberIds: [],
      status: 'ready',
      workspaceRoots: ['D:\\Repos\\rocketchatx'],
      sandboxMode: 'read-only',
      updatedAt: now,
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rocketchatx', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = `${encodeURIComponent(server)}:${encodeURIComponent(me._id)}:${encodeURIComponent('room:room-general')}`;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('app-data', 'readwrite');
      transaction.objectStore('app-data').put(session, ['builtin:shared-agent', key]);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { server: SERVER, me: ME });
  await page.reload();
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  await conversation(page, 'General').click();

  const stopButton = page.getByRole('button', { name: '关闭 AI 托管' });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(page.getByRole('button', { name: '开启 AI 托管' })).toBeVisible();
  await expect(page.getByText('共享 Agent')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('AI 配置默认只突出工作目录，复杂选项按需展开', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: ['RocketChatX'],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('complementary').getByRole('button', { name: 'AI', exact: true }).click();

  // 基础设置直接可见：运行方式在最上面（报错提示会引导用户来这里切换大脑）
  await expect(page.getByRole('heading', { name: 'AI 运行方式' })).toBeVisible();
  await expect(page.getByLabel('AI 托管 Codex 模型')).toBeVisible();
  await expect(page.getByLabel('AI 托管 Codex 推理强度')).toHaveValue('high');
  await expect(page.getByRole('heading', { name: 'AI 工作目录' })).toBeVisible();
  await expect(page.getByText('D:\\Repos\\rocketchatx', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '模型 Provider' })).not.toBeVisible();
  await page.locator('main').screenshot({ path: testInfo.outputPath('simplified-ai-settings-default.png') });
  await page.getByText('高级 AI 设置', { exact: true }).click();
  // 高级设置按保存方式分组：Provider/路由归「保存 AI 配置」，外部集成即时生效
  await expect(page.getByRole('heading', { name: '模型 Provider' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '按能力路由' })).toBeVisible();
  await expect(page.getByText('保存上方 Provider 与能力路由', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '外部集成' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('内网通插件可保存本机名称和 IP 范围并立即应用', async ({ page }) => {
  const pluginHtml = readFileSync('plugins/intranet-link/index.html', 'utf8');
  const bridgeBootstrap = `<script>
    window.__bridgeCalls = [];
    const bridge = new EventTarget();
    bridge.postMessage = (message) => {
      window.__bridgeCalls.push(message);
      const method = message.params?.method;
      let result = null;
      if (method === 'ipmsg.identity.get') {
        result = { displayName: '', effectiveDisplayName: 'Admin' };
      } else if (method === 'ipmsg.identity.set') {
        result = {
          ok: true,
          displayName: message.params.params.displayName.trim(),
          effectiveDisplayName: message.params.params.displayName.trim() || 'Admin',
        };
      } else if (method === 'ipmsg.discovery.get') {
        result = { discoveryRanges: '192.168.20.0/30', discoveryTargetCount: 2 };
      } else if (method === 'ipmsg.discovery.set') {
        result = {
          ok: true,
          discoveryRanges: message.params.params.discoveryRanges.trim(),
          discoveryTargetCount: 3,
        };
      } else if (method === 'ipmsg.peers') {
        result = [];
      }
      queueMicrotask(() => bridge.dispatchEvent(new MessageEvent('message', {
        data: { jsonrpc: '2.0', id: message.id, result },
      })));
    };
    window.__RCX_BRIDGE__ = bridge;
  </script>`;
  await page.setContent(pluginHtml.replace('<script>', `${bridgeBootstrap}<script>`));

  await expect(page.getByLabel('本机显示名称')).toHaveValue('');
  await expect(page.getByText('当前跟随 RocketX 账号昵称：“Admin”。')).toBeVisible();
  await page.getByLabel('本机显示名称').fill('开发机');
  await page.getByRole('button', { name: '保存并立即生效' }).click();
  await expect(page.getByText('已保存并以“开发机”重新广播。')).toBeVisible();
  await expect(page.getByLabel('目标 IPv4 范围')).toHaveValue('192.168.20.0/30');
  await page.getByLabel('目标 IPv4 范围').fill('10.20.30.10-10.20.30.12');
  await page.getByRole('button', { name: '保存并应用' }).click();
  await expect(page.getByText('已应用 3 个目标，同时覆盖 9011 与 2425。')).toBeVisible();
  const configured = await page.evaluate(() => {
    const calls = (window as unknown as {
      __bridgeCalls: Array<{ params?: { method?: string; params?: unknown } }>;
    }).__bridgeCalls;
    return {
      identity: calls.find((call) => call.params?.method === 'ipmsg.identity.set')?.params?.params,
      discovery: calls.find((call) => call.params?.method === 'ipmsg.discovery.set')?.params?.params,
    };
  });
  expect(configured).toEqual({
    identity: { displayName: '开发机' },
    discovery: { discoveryRanges: '10.20.30.10-10.20.30.12' },
  });
});

test('内网通插件在桌面发布版 CSP 下通过真实 iframe Bridge 保存范围并刷新设备', async ({ page }) => {
  const pluginHtml = readFileSync('plugins/intranet-link/index.html', 'utf8');
  const desktopSecurity = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'))
    .app.security as { csp: string; dangerousDisableAssetCspModification: string[] };
  expect(desktopSecurity.dangerousDisableAssetCspModification).toContain('script-src');
  const srcDoc = sandboxDocument({
    id: 'dev.rocketx.intranet-link',
    name: '内网通',
    version: '1.2.0',
    publisher: 'RocketX',
    runtime: 'iframe',
    entry: 'index.html',
    permissions: ['lan:discover'],
  }, pluginHtml);

  await page.setContent(`
    <meta http-equiv="Content-Security-Policy"
      content="${desktopSecurity.csp}">
    <main></main>
  `);
  await page.evaluate((html) => {
    const iframe = document.createElement('iframe');
    iframe.title = '内网通';
    iframe.sandbox.add('allow-scripts');
    let activePort: MessagePort | undefined;
    const connect = () => {
      activePort?.close();
      const channel = new MessageChannel();
      activePort = channel.port1;
      channel.port1.addEventListener('message', (event) => {
        const request = event.data;
        const method = request.params?.method;
        let result = null;
        if (method === 'ipmsg.identity.get') {
          result = { displayName: 'WSL 节点', effectiveDisplayName: 'WSL 节点' };
        } else if (method === 'ipmsg.discovery.get') {
          result = { discoveryRanges: '192.168.20.0/30', discoveryTargetCount: 2 };
        } else if (method === 'ipmsg.discovery.set') {
          result = {
            discoveryRanges: request.params.params.discoveryRanges.trim(),
            discoveryTargetCount: 3,
          };
        } else if (method === 'ipmsg.peers') {
          result = [{
            id: 'peer-1',
            user: 'tester',
            host: 'wsl-peer',
            nickname: 'WSL 测试节点',
            dialect: 'ipmsg',
            lastSeenMs: Date.now(),
          }];
        }
        channel.port1.postMessage({ jsonrpc: '2.0', id: request.id, result });
      });
      channel.port1.start();
      iframe.contentWindow?.postMessage(
        { jsonrpc: '2.0', method: 'rcx/connect' },
        '*',
        [channel.port2],
      );
    };
    (window as typeof window & { __reconnectBridge?: () => void }).__reconnectBridge = connect;
    iframe.addEventListener('load', connect);
    document.querySelector('main')!.append(iframe);
    iframe.srcdoc = html;
  }, srcDoc);

  const app = page.frameLocator('iframe[title="内网通"]');
  await expect(app.getByLabel('本机显示名称')).toHaveValue('WSL 节点');
  await expect(app.getByLabel('目标 IPv4 范围')).toHaveValue('192.168.20.0/30');
  await expect(app.getByText('发现 1 个内网通兼容联系人。')).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __reconnectBridge?: () => void }).__reconnectBridge?.();
  });
  await app.getByLabel('目标 IPv4 范围').fill('10.20.30.10-10.20.30.12');
  await app.getByRole('button', { name: '保存并应用' }).click();
  await expect(app.getByText('已应用 3 个目标，同时覆盖 9011 与 2425。')).toBeVisible();
});
