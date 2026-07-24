import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { sandboxDocument } from '../../apps/web/src/kernel/sandbox/iframe';

const ME = { _id: 'user-me', username: 'tester', name: 'Test User', status: 'online' };
const ALICE = { _id: 'user-alice', username: 'alice', name: 'Alice', status: 'online' };
const NOW = '2026-07-17T08:00:00.000Z';
const SERVER = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';

async function installTauriMock(page: Page, workspaceConfig?: Record<string, unknown>) {
  await page.addInitScript(({ config }) => {
    let responseUrl = '';
    let responseBodySent = false;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string, args?: Record<string, any>) => {
          if (command === 'allow_http_origin') return new URL(String(args?.origin)).origin;
          if (command === 'plugin:http|fetch') {
            responseUrl = String(args?.clientConfig?.url ?? '');
            return 1;
          }
          if (command === 'plugin:http|fetch_send') {
            responseBodySent = false;
            return { status: 200, statusText: 'OK', url: responseUrl, headers: [], rid: 2 };
          }
          if (command === 'plugin:http|fetch_read_body') {
            if (responseBodySent) return [1];
            responseBodySent = true;
            const body = responseUrl.endsWith('/api/info')
              ? { version: '8.6.1', success: true }
              : (config ?? { version: 1, rocketChat: { url: 'https://chat.example.com' } });
            return [...new TextEncoder().encode(JSON.stringify(body)), 0];
          }
          if (command === 'plugin:updater|check') return null;
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  }, { config: workspaceConfig });
}

async function installFullTauriMock(page: Page) {
  await page.addInitScript(() => {
    let nextRid = 1;
    const requests = new Map<number, { method: string; url: string; headers: string[][]; data?: number[] }>();
    const responses = new Map<number, { bytes: number[]; read: boolean }>();
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __tauriCalls: typeof calls }).__tauriCalls = calls;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string, args?: Record<string, any>) => {
          calls.push({ command, args });
          if (command === 'allow_http_origin') return new URL(String(args?.origin)).origin;
          if (command === 'plugin:path|resolve_directory') return 'C:\\Users\\tester\\AppData\\Roaming\\com.lusipad.rocketx';
          if (command === 'plugin:path|join') return (args?.paths ?? []).join('\\');
          if (command === 'plugin:fs|mkdir') return null;
          if (command === 'plugin:fs|remove') {
            if ((window as unknown as { __failArchiveRemove?: boolean }).__failArchiveRemove) {
              throw new Error('mock remove failed');
            }
            return null;
          }
          if (command === 'plugin:fs|open') return 91;
          if (command === 'plugin:fs|write') return args?.data?.byteLength ?? args?.data?.length ?? 0;
          if (command === 'plugin:resources|close') return null;
          if (command === 'plugin:fs|stat') {
            return {
              isFile: true, isDirectory: false, isSymlink: false, size: 256,
              mtime: null, atime: null, birthtime: null, readonly: false,
              fileAttributes: null, dev: null, ino: null, mode: null, nlink: null,
              uid: null, gid: null, rdev: null, blksize: null, blocks: null,
            };
          }
          if (command === 'plugin:http|fetch') {
            const rid = nextRid++;
            requests.set(rid, args?.clientConfig);
            return rid;
          }
          if (command === 'plugin:http|fetch_send') {
            const request = requests.get(Number(args?.rid))!;
            const response = await fetch(request.url, {
              method: request.method,
              headers: request.headers,
              body: request.data ? new Uint8Array(request.data) : undefined,
            });
            const rid = nextRid++;
            responses.set(rid, { bytes: [...new Uint8Array(await response.arrayBuffer())], read: false });
            return {
              status: response.status,
              statusText: response.statusText,
              url: response.url,
              headers: [...response.headers.entries()],
              rid,
            };
          }
          if (command === 'plugin:http|fetch_read_body') {
            const response = responses.get(Number(args?.rid))!;
            if (response.read) return [1];
            response.read = true;
            return [...response.bytes, 0];
          }
          if (command === 'image_ocr_recognize') {
            return {
              text: 'RocketX 本地 OCR',
              language: 'zh-Hans',
              backend: 'pp-ocrv5',
              words: [
                { text: 'RocketX', x: 0.08, y: 0.2, width: 0.35, height: 0.18, spaceAfter: false },
                { text: '本地', x: 0.08, y: 0.55, width: 0.2, height: 0.18, spaceAfter: true },
                { text: 'OCR', x: 0.3, y: 0.55, width: 0.2, height: 0.18, spaceAfter: false },
              ],
            };
          }
          if (command === 'plugin:updater|check') return null;
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  });
}

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
      _id: 'general-ocr-image',
      rid: 'room-general',
      msg: '',
      ts: '2026-07-17T08:01:00.000Z',
      u: ALICE,
      file: { _id: 'file-ocr', name: 'OCR 示例.svg', type: 'image/svg+xml', size: 256 },
      attachments: [{
        title: 'OCR 示例.svg',
        image_url: '/file-upload/ocr/demo.svg',
        title_link: '/file-upload/ocr/demo.svg',
      }],
    },
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

test('桌面图片灯箱优先显示 PP-OCRv5 本地离线后端并叠加可选择文字（issue #163）', async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page);
  expect(await page.evaluate(() => ({
    tauri: '__TAURI_INTERNALS__' in window,
    userAgent: navigator.userAgent,
  }))).toMatchObject({ tauri: true, userAgent: expect.stringMatching(/Windows/i) });
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: /OCR 示例\.svg/ }).last().click();
  await page.getByRole('button', { name: '识别图片文字' }).click();
  const layer = page.getByLabel('图片识别文字');
  await expect(layer).toBeVisible();
  const selectableWord = layer.getByText('RocketX', { exact: true });
  await expect(selectableWord).toBeVisible();
  await selectableWord.selectText();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('RocketX');
  await expect(page.getByText(/已用 PP-OCRv5 本地离线引擎\s+识别 3 处文字/)).toBeVisible();
  await expect(page.getByRole('button', { name: '复制全部识别文字' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('桌面附件留存默认关闭，可配置并按房间删除本地副本（issue #152）', async ({ page }) => {
  await installFullTauriMock(page);
  await page.addInitScript(({ server, userId, cachedAt }) => {
    const key = `rcx-attachment-archive-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      records: [
        {
          fileId: 'file-general',
          rid: 'room-general',
          roomName: 'General',
          name: '项目资料.pdf',
          sourcePath: '/file-upload/file-general/project.pdf',
          size: 1024,
          cachedAt,
        },
        {
          fileId: 'file-expired',
          rid: 'room-expired',
          roomName: '过期房间',
          name: '过期资料.pdf',
          sourcePath: '/file-upload/file-expired/expired.pdf',
          size: 2048,
          cachedAt: cachedAt - 40 * 86_400_000,
        },
      ],
    }));
  }, { server: SERVER, userId: ME._id, cachedAt: Date.parse(NOW) });
  const { pageErrors } = await bootAuthenticated(page);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '消息', exact: true }).last().click();
  const archiveRow = page.getByText('自动留存附件到本机', { exact: true }).locator('..').locator('..');
  const toggle = archiveRow.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('附件留存单文件上限')).toHaveValue(String(25 * 1024 * 1024));
  await expect(page.getByLabel('附件留存账号总配额')).toHaveValue(String(2 * 1024 * 1024 * 1024));
  await expect(page.getByLabel('附件留存时间')).toHaveValue('30');

  await expect(page.getByText('本地附件（1 个，1.0 KB）')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __failArchiveRemove: boolean }).__failArchiveRemove = true;
  });
  await page.getByRole('button', { name: '删除本地副本', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '删除这个房间的本地附件' });
  await expect(dialog).toContainText('Rocket.Chat 服务器上的消息和原文件不会被删除');
  await dialog.getByRole('button', { name: '删除本地副本', exact: true }).click();
  await expect(page.getByText('mock remove failed')).toBeVisible();
  await expect(page.getByText('本地附件（1 个，1.0 KB）')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __failArchiveRemove: boolean }).__failArchiveRemove = false;
  });
  await page.getByRole('button', { name: '删除本地副本', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '删除这个房间的本地附件' });
  await dialog.getByRole('button', { name: '删除本地副本', exact: true }).click();
  await expect(page.getByText('本地附件（1 个，1.0 KB）')).toHaveCount(0);

  const result = await page.evaluate(({ server, userId }) => {
    const key = `rcx-attachment-archive-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    return {
      archive: JSON.parse(localStorage.getItem(key) ?? '{}'),
      removeCalls: (window as unknown as { __tauriCalls: Array<{ command: string; args?: Record<string, unknown> }> })
        .__tauriCalls.filter((item) => item.command === 'plugin:fs|remove'),
    };
  }, { server: SERVER, userId: ME._id });
  expect(result.archive.records).toEqual([]);
  const recursiveRemoveCalls = result.removeCalls.filter((call) => (
    (call.args?.options as { recursive?: boolean } | undefined)?.recursive === true
  ));
  expect(recursiveRemoveCalls).toHaveLength(2);

  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
  await conversation(page, 'General').click();
  await expect.poll(() => page.evaluate(({ server, userId }) => {
    const key = `rcx-attachment-archive-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    const archive = JSON.parse(localStorage.getItem(key) ?? '{"records":[]}');
    return archive.records.map((item: { fileId: string }) => item.fileId);
  }, { server: SERVER, userId: ME._id })).toContain('file-ocr');
  const writeCalls = await page.evaluate(() =>
    (window as unknown as { __tauriCalls: Array<{ command: string }> }).__tauriCalls
      .filter((item) => item.command === 'plugin:fs|write'),
  );
  expect(writeCalls.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('禅模式默认关闭并可显式开启通知聚合（issue #208）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '通知', exact: true }).click();

  const row = page.getByText('禅模式', { exact: true }).locator('..').locator('..');
  const toggle = row.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(pageErrors).toEqual([]);
});

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', json });
}

async function installAdoDirectMock(
  page: Page,
  workItem: {
    id: number;
    title: string;
    type: string;
    state: string;
    priority: number;
    project: string;
    assignedTo: string;
  },
) {
  const rawWorkItem = {
    id: workItem.id,
    fields: {
      'System.Title': workItem.title,
      'System.WorkItemType': workItem.type,
      'System.State': workItem.state,
      'System.TeamProject': workItem.project,
      'System.AssignedTo': { displayName: workItem.assignedTo },
      'Microsoft.VSTS.Common.Priority': workItem.priority,
    },
  };
  await page.route('**/ado/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/_apis/connectionData')) {
      return fulfillJson(route, {
        authenticatedUser: {
          id: 'ado-user',
          customDisplayName: 'Test User',
          properties: { Account: { $value: 'tester' } },
        },
      });
    }
    if (url.pathname.endsWith('/_apis/wit/wiql')) {
      return fulfillJson(route, { workItems: [{ id: workItem.id }] });
    }
    if (url.pathname.endsWith('/_apis/wit/workitems')) {
      return fulfillJson(route, { value: [rawWorkItem] });
    }
    if (url.pathname.endsWith(`/_apis/wit/workitems/${workItem.id}`)) {
      return fulfillJson(route, rawWorkItem);
    }
    if (url.pathname.endsWith('/_apis/projects')) {
      return fulfillJson(route, { value: [] });
    }
    return fulfillJson(route, { value: [] });
  });
}

async function installRocketChatMock(page: Page) {
  const sentMessages: Record<string, unknown>[] = [];
  const uploadedMessages: Record<string, unknown>[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/avatar/**', (route) => route.fulfill({ status: 204 }));
  await page.route('**/file-upload/ocr/demo.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="100%" height="100%" fill="white"/><text x="40" y="100" font-size="52">RocketX 123</text><text x="40" y="180" font-size="44">本地 OCR</text></svg>',
  }));
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
        settings: [{ _id: id, value: id === 'Site_Url' ? SERVER : false }],
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
    if (endpoint.startsWith('rooms.media/')) {
      return fulfillJson(route, { file: { _id: `file-${uploadedMessages.length + 1}` } });
    }
    if (endpoint.startsWith('rooms.mediaConfirm/')) {
      uploadedMessages.push(request.postDataJSON() as Record<string, unknown>);
      return fulfillJson(route, { success: true });
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

  return { sentMessages, uploadedMessages, pageErrors };
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
  await expect(page.getByRole('heading', { name: '连接 Azure DevOps' })).toHaveCount(0);
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('桌面新安装优先展示团队引导和设计理念', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installTauriMock(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /让团队消息进入系统，\s*而不是留在每个人的大脑里。/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '加入团队工作区' })).toBeVisible();
  await expect(page.getByText('捕获', { exact: true })).toBeVisible();
  await expect(page.getByText('执行', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('team-first-onboarding.png'), fullPage: true });

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'rcx.workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      name: '验证团队',
      rocketChat: { url: 'https://chat.example.com' },
      ado: { url: 'https://ado.example.com/tfs/DefaultCollection', mode: 'direct', auth: 'pat' },
      workItemTemplates: {
        defaultProject: 'Alpha',
        templates: [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }],
      },
    })),
  });
  await expect(page.getByRole('heading', { name: '加入「验证团队」' })).toBeVisible();
  await expect(page.getByText('1 个内联模板', { exact: true })).toBeVisible();
  await expect(page.getByText('用户名、密码、PAT 和 AI 密钥不会从团队配置读取')).toBeVisible();
  await page.getByRole('button', { name: '确认并继续' }).click();
  await expect(page.getByText('验证团队', { exact: true })).toBeVisible();
  await expect(page.getByText('https://chat.example.com', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('https://chat.example.com')).toHaveCount(0);
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toBeVisible();
  await expect(page.getByPlaceholder('请输入密码')).toBeVisible();
  expect(await page.evaluate(() => ({
    url: localStorage.getItem('rcx-wi-template-url'),
    config: JSON.parse(localStorage.getItem('rcx-wi-template-cache') ?? '{}'),
  }))).toEqual({
    url: null,
    config: {
      defaultProject: 'Alpha',
      templates: [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }],
    },
  });
  expect(pageErrors).toEqual([]);
});

test('桌面重启后会重新授权并检查团队配置 URL', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installTauriMock(page, {
    version: 1,
    name: '同步团队',
    rocketChat: { url: 'https://chat.example.com' },
    update: { source: 'dir', location: '\\\\fileserver\\software\\rocketx' },
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-server', 'https://chat.example.com');
    localStorage.setItem('rcx-update-source', JSON.stringify({ kind: 'github', location: '' }));
    localStorage.setItem('rcx-first-run-v1', 'complete');
    localStorage.setItem('rcx-workspace-source', JSON.stringify({
      url: 'https://git.example.com/team/raw/rcx.workspace.json',
      name: '同步团队',
      importedAt: 1,
      lastCheckedAt: 0,
      follow: true,
      applied: {
        'server.url': 'https://chat.example.com',
        'update.source': 'github|',
      },
    }));
  });

  await page.goto('/');
  await expect(page.getByText(/团队配置有更新：1 项变化/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('团队端点变化会解绑 ADO PAT 和 AI 密钥状态', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      mode: 'direct',
      adoBase: 'https://ado-old.example.com/tfs/DefaultCollection',
      auth: 'pat',
      pat: 'old-pat',
      account: 'tester',
    }));
    localStorage.setItem('rcx-ai-settings-v1', JSON.stringify({
      providers: [{
        id: 'team-ai',
        kind: 'openai-compatible',
        name: 'Team AI',
        baseUrl: 'https://ai-old.example.com/v1',
        model: 'old-model',
        locality: 'local',
        hasSecret: true,
      }],
      routes: Object.fromEntries(
        ['summary', 'extraction', 'daily-review', 'butler-rounds', 'text-tool', 'agent']
          .map((id) => [id, { providerId: 'team-ai', localOnly: false }]),
      ),
    }));
    localStorage.setItem('rcx-workspace-source', JSON.stringify({
      url: 'https://git.example.com/team/raw/rcx.workspace.json',
      name: '旧团队',
      importedAt: 1,
      follow: true,
      applied: {
        'ado.base': 'https://ado-old.example.com/tfs/DefaultCollection',
        'ado.mode': 'direct',
        'ado.auth': 'pat',
        'ai.provider.team-ai': 'openai-compatible|https://ai-old.example.com/v1|old-model',
      },
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name: 'rcx.workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      name: '新团队',
      ado: { url: 'https://ado-new.example.com/tfs/DefaultCollection', mode: 'direct', auth: 'pat' },
      ai: {
        providers: [{
          id: 'team-ai',
          kind: 'openai-compatible',
          name: 'Team AI',
          baseUrl: 'https://ai-new.example.com/v1',
          model: 'new-model',
        }],
      },
    })),
  });
  await page.getByRole('button', { name: /应用 \d+ 项/ }).click();

  const stored = await page.evaluate(() => ({
    workbench: JSON.parse(localStorage.getItem('rcx-workbench') ?? '{}'),
    ai: JSON.parse(localStorage.getItem('rcx-ai-settings-v1') ?? '{}'),
    source: JSON.parse(localStorage.getItem('rcx-workspace-source') ?? '{}'),
  }));
  expect(stored.workbench).not.toHaveProperty('pat');
  expect(stored.workbench.adoBase).toBe('https://ado-new.example.com/tfs/DefaultCollection');
  expect(stored.ai.providers[0]).toMatchObject({
    id: 'team-ai',
    baseUrl: 'https://ai-new.example.com/v1',
    locality: 'external',
    hasSecret: false,
  });
  expect(stored.source).not.toHaveProperty('url');
  expect(stored.source).not.toHaveProperty('follow');
  expect(pageErrors).toEqual([]);
});

test('团队 Rocket.Chat 地址变化会清理旧会话并要求重新登录', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.addInitScript(({ server, userId }) => {
    if (sessionStorage.getItem('rcx-server-change-seeded')) return;
    sessionStorage.setItem('rcx-server-change-seeded', '1');
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
    localStorage.setItem('rcx-workspace-source', JSON.stringify({
      name: '旧团队',
      importedAt: 1,
      applied: { 'server.url': server },
    }));
  }, { server: SERVER, userId: ME._id });

  await page.goto('/');
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name: 'rcx.workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      name: '新团队',
      rocketChat: { url: 'https://chat-new.example.com' },
    })),
  });
  await page.getByRole('button', { name: '应用 1 项' }).click();

  await expect(page.getByText('新团队', { exact: true })).toBeVisible();
  await expect(page.getByText('https://chat-new.example.com', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('rcx-auth'))).toBeNull();
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

test('底部消息的表情面板加载完整分类后仍留在视口内（issue #207）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        getState: () => { messages: Record<string, unknown[]> };
        setState: (state: { messages: Record<string, unknown[]> }) => void;
      };
    }>;
    const { useChat } = await load();
    const state = useChat.getState();
    useChat.setState({
      messages: {
        ...state.messages,
        'room-general': Array.from({ length: 40 }, (_, index) => ({
          _id: `reaction-${index}`,
          rid: 'room-general',
          msg: index === 39 ? 'Bottom reaction message' : `Reaction filler ${index}`,
          ts: new Date(Date.parse('2026-07-17T08:00:00.000Z') + index * 1000).toISOString(),
          u: { _id: 'user-alice', username: 'alice', name: 'Alice' },
        })),
      },
    });
  });
  const message = page.getByText('Bottom reaction message', { exact: true });
  await expect(message).toBeVisible();
  await message.scrollIntoViewIfNeeded();
  await message.hover();
  await page.getByRole('button', { name: '更多表情' }).click();

  const search = page.getByPlaceholder('搜索表情');
  const picker = search.locator('xpath=../..');
  await expect(search).toBeVisible();
  await expect(picker.locator('[data-emoji-section]').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => {
    const box = await picker.boundingBox();
    const viewport = page.viewportSize();
    return !!box && !!viewport && box.y >= 8 && box.y + box.height <= viewport.height - 8;
  }).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('文件拖拽离开聊天区或窗口后会取消发送遮罩（issue #194）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  const chatArea = page.locator('main');
  const overlay = page.getByText('松开即可发送文件', { exact: true });

  const dragFileOverChat = () => chatArea.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['test'], 'test.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
  });

  await dragFileOverChat();
  await expect(overlay).toBeVisible();
  await chatArea.locator('header').evaluate((element) => {
    element.dispatchEvent(new DragEvent('dragleave', {
      bubbles: true,
      relatedTarget: document.body,
    }));
  });
  await expect(overlay).toHaveCount(0);

  await dragFileOverChat();
  await expect(overlay).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(overlay).toHaveCount(0);
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

test('文字和图片确认后作为同一条上传消息发送（issue #155）', async ({ page }) => {
  const { uploadedMessages, pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  const composer = page.getByPlaceholder(/输入消息/);
  await composer.fill('图文说明');
  await page.locator('input[accept="image/*"]').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image-bytes'),
  });

  const dialog = page.getByRole('dialog', { name: '发送文件给 General' });
  await expect(dialog.getByText('图文说明', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '发送（1）' }).click();

  await expect.poll(() => uploadedMessages.length).toBe(1);
  expect(uploadedMessages[0]?.msg).toBe('图文说明');
  await expect(composer).toHaveValue('');
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
    `[ ](${SERVER}/channel/general?msg=general-welcome) Reply from UI`,
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
  await installAdoDirectMock(page, workItem);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
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
  await installAdoDirectMock(page, workItem);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
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

test('飞鸽 / IPMSG 插件可保存本机名称和 IP 范围并重新广播', async ({ page }) => {
  const pluginHtml = readFileSync('plugins/intranet-link/index.html', 'utf8');
  const bridgeBootstrap = `<script>
    window.__bridgeCalls = [];
    const bridge = new EventTarget();
    bridge.postMessage = (message) => {
      window.__bridgeCalls.push(message);
      const method = message.params?.method;
      const params = message.params?.params || {};
      let result = null;
      if (method === 'storage.get') {
        result = params.key === 'settings'
          ? { displayName: '', discoveryRanges: '192.168.20.0/30' }
          : [];
      } else if (method === 'storage.set') {
        result = { ok: true };
      } else if (method === 'native.call') {
        if (params.method === 'start') {
          result = {
            enabled: true,
            port: 2425,
            discoveryTargetCount: params.params.discoveryRanges ? 3 : 0,
          };
        } else if (params.method === 'validateDiscoveryRanges') {
          result = { count: 3 };
        } else if (params.method === 'peers') {
          result = [];
        }
      }
      queueMicrotask(() => bridge.dispatchEvent(new MessageEvent('message', {
        data: { jsonrpc: '2.0', id: message.id, result },
      })));
    };
    window.__RCX_BRIDGE__ = bridge;
  </script>`;
  await page.setContent(pluginHtml.replace('<script>', `${bridgeBootstrap}<script>`));

  await expect(page.getByLabel('本机显示名称')).toHaveValue('');
  await expect(page.getByLabel('目标 IPv4 范围')).toHaveValue('192.168.20.0/30');
  await expect(page.getByText('后台服务已启动，正在监听 UDP/TCP 2425；目标 IP 3 个。')).toBeVisible();
  await page.getByLabel('本机显示名称').fill('开发机');
  await page.getByLabel('目标 IPv4 范围').fill('10.20.30.10-10.20.30.12');
  await page.getByRole('button', { name: '保存并重新广播' }).click();
  await expect(page.getByText('后台服务已启动，正在监听 UDP/TCP 2425；目标 IP 3 个。')).toBeVisible();
  const configured = await page.evaluate(() => {
    const calls = (window as unknown as {
      __bridgeCalls: Array<{
        params?: {
          method?: string;
          params?: { key?: string; value?: unknown; method?: string; params?: unknown };
        };
      }>;
    }).__bridgeCalls;
    return {
      settings: calls.find((call) => (
        call.params?.method === 'storage.set' && call.params.params?.key === 'settings'
      ))?.params?.params?.value,
      start: calls.filter((call) => (
        call.params?.method === 'native.call' && call.params.params?.method === 'start'
      )).at(-1)?.params?.params?.params,
    };
  });
  expect(configured).toEqual({
    settings: { displayName: '开发机', discoveryRanges: '10.20.30.10-10.20.30.12' },
    start: {
      userName: '开发机',
      nickname: '开发机',
      group: 'RocketX',
      discoveryRanges: '10.20.30.10-10.20.30.12',
    },
  });
});

test('飞鸽 / IPMSG 插件在桌面发布版 CSP 下通过真实 iframe Bridge 保存范围并刷新设备', async ({ page }) => {
  const pluginHtml = readFileSync('plugins/intranet-link/index.html', 'utf8');
  const desktopSecurity = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'))
    .app.security as { csp: string; dangerousDisableAssetCspModification: string[] };
  expect(desktopSecurity.dangerousDisableAssetCspModification).toContain('script-src');
  const srcDoc = sandboxDocument({
    id: 'dev.rocketx.intranet-link',
    name: '飞鸽 / IPMSG',
    version: '1.3.0',
    publisher: 'RocketX',
    runtime: 'iframe',
    entry: 'index.html',
    permissions: ['native:service', 'storage:local', 'files:read', 'ui:notify'],
    service: {
      runtime: 'native',
      command: 'rcx-plugin-intranet-link',
      platforms: ['windows'],
      protocol: 'jsonrpc-stdio',
    },
  }, pluginHtml);

  await page.setContent(`
    <meta http-equiv="Content-Security-Policy"
      content="${desktopSecurity.csp}">
    <main></main>
  `);
  await page.evaluate((html) => {
    const iframe = document.createElement('iframe');
    iframe.title = '飞鸽 / IPMSG';
    iframe.sandbox.add('allow-scripts');
    let activePort: MessagePort | undefined;
    const connect = () => {
      activePort?.close();
      const channel = new MessageChannel();
      activePort = channel.port1;
      channel.port1.addEventListener('message', (event) => {
        const request = event.data;
        const method = request.params?.method;
        const params = request.params?.params || {};
        let result = null;
        if (method === 'storage.get') {
          result = params.key === 'settings'
            ? { displayName: 'WSL 节点', discoveryRanges: '192.168.20.0/30' }
            : [];
        } else if (method === 'storage.set') {
          result = { ok: true };
        } else if (method === 'native.call') {
          if (params.method === 'start') {
            result = {
              enabled: true,
              port: 2425,
              discoveryTargetCount: params.params.discoveryRanges === '10.20.30.10-10.20.30.12' ? 3 : 2,
            };
          } else if (params.method === 'validateDiscoveryRanges') {
            result = { count: 3 };
          } else if (params.method === 'peers') {
            result = [{
              id: 'peer-1',
              user: 'tester',
              host: 'wsl-peer',
              nickname: 'WSL 测试节点',
              dialect: 'ipmsg',
              ip: '192.168.20.2',
              lastSeenMs: Date.now(),
            }];
          }
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

  const app = page.frameLocator('iframe[title="飞鸽 / IPMSG"]');
  await expect(app.getByLabel('本机显示名称')).toHaveValue('WSL 节点');
  await expect(app.getByLabel('目标 IPv4 范围')).toHaveValue('192.168.20.0/30');
  await expect(app.getByText('发现 1 个联系人。')).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __reconnectBridge?: () => void }).__reconnectBridge?.();
  });
  await app.getByLabel('目标 IPv4 范围').fill('10.20.30.10-10.20.30.12');
  await app.getByRole('button', { name: '保存并重新广播' }).click();
  await expect(app.getByText('后台服务已启动，正在监听 UDP/TCP 2425；目标 IP 3 个。')).toBeVisible();
});
