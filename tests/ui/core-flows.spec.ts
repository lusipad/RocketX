import { expect, test, type Page, type Route } from '@playwright/test';

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
  options: { coffeeTime?: { enabled: boolean; times: string[] }; expectMessages?: boolean } = {},
) {
  const state = await installRocketChatMock(page);
  await page.addInitScript(({ server, userId, coffeeTime }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
    localStorage.setItem('rcx-coffee-time', JSON.stringify(coffeeTime));
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
    coffeeTime: options.coffeeTime ?? { enabled: false, times: ['09:00', '19:00'] },
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

test('错过咖啡时间后自动进入管家，并可返回消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    coffeeTime: { enabled: true, times: ['00:00'] },
    expectMessages: false,
  });
  await expect(page.getByRole('heading', { name: '管家', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '咖啡时间汇总' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: /^我答应 \/ 在等什么/ })).toBeVisible();
  await expect(page.getByText('答应 张三', { exact: true })).toBeVisible();
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

test('AI 提供执行间入口，Codex 不显示为侧栏一级入口', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByText('直接告诉我你想了解什么，我会先查证据再回答。')).toBeVisible();
  await page.getByRole('button', { name: '执行间', exact: true }).click();
  await expect(page.getByText('执行间', { exact: true })).toBeVisible();
  await expect(page.getByText('AI 的本地执行区：在指定本地目录中运行 Codex 会话；由 Codex 原生沙箱和审批控制命令与文件修改。')).toBeVisible();
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
    localStorage.setItem('rcx-coffee-time', JSON.stringify({ enabled: false, times: ['09:00', '19:00'] }));
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
