import type { Page, Route } from '@playwright/test';

export const TEST_SERVER = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';

const ME = { _id: 'user-me', username: 'tester', name: 'Test User', status: 'online' };
const ALICE = { _id: 'user-alice', username: 'alice', name: 'Alice', status: 'online' };
const NOW = '2026-07-21T08:00:00.000Z';

const subscriptions = [{
  _id: 'sub-general',
  rid: 'room-general',
  t: 'c',
  name: 'general',
  fname: 'General',
  open: true,
  unread: 1,
  alert: true,
  ls: NOW,
}];

const rooms = [{
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
}];

const messages = [{
  _id: 'general-release',
  rid: 'room-general',
  msg: 'Release checklist ready',
  ts: NOW,
  u: ALICE,
}];

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', json });
}

export interface RocketChatMockState {
  sentMessages: Record<string, unknown>[];
  pageErrors: string[];
}

export async function installRocketChatMock(page: Page): Promise<RocketChatMockState> {
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
        settings: [{ _id: id, value: id === 'Site_Url' ? TEST_SERVER : false }],
      });
    }
    if (endpoint === 'subscriptions.get') return fulfillJson(route, { update: subscriptions });
    if (endpoint === 'rooms.get') return fulfillJson(route, { update: rooms });
    if (endpoint === 'commands.list') return fulfillJson(route, { commands: [] });
    if (endpoint === 'users.info') {
      return fulfillJson(route, { user: { ...ME, settings: { preferences: {} } } });
    }
    if (endpoint === 'users.presence') return fulfillJson(route, { users: [ME, ALICE] });
    if (endpoint === 'channels.members') return fulfillJson(route, { members: [ME, ALICE], total: 2 });
    if (endpoint === 'channels.history' || endpoint === 'groups.history') {
      return fulfillJson(route, { messages });
    }
    if (endpoint === 'chat.sendMessage') {
      const body = request.postDataJSON() as { message: Record<string, unknown> };
      sentMessages.push(body.message);
      return fulfillJson(route, { message: { ...body.message, ts: NOW, u: ME } });
    }
    if (endpoint === 'chat.getMessage') {
      const message = messages.find((item) => item._id === url.searchParams.get('msgId'));
      return message ? fulfillJson(route, { message }) : fulfillJson(route, { message: null }, 404);
    }
    if (endpoint.endsWith('.roles')) return fulfillJson(route, { roles: [] });
    return fulfillJson(route, { success: true });
  });

  await page.routeWebSocket('**/websocket', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { msg?: string; id?: string };
      if (message.msg === 'connect') socket.send(JSON.stringify({ msg: 'connected', session: 'butler-ui' }));
      if (message.msg === 'method' && message.id) {
        socket.send(JSON.stringify({ msg: 'result', id: message.id, result: {} }));
      }
    });
  });

  return { sentMessages, pageErrors };
}

export async function bootAuthenticated(page: Page): Promise<RocketChatMockState> {
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
  }, { server: TEST_SERVER, userId: ME._id });
  await page.goto('/');
  return state;
}
