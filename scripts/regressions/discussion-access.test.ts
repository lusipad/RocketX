import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RcApiError,
  RcRestClient,
  type RcMessage,
  type RcRoom,
  type RcSubscription,
} from '../../packages/rc-client/src/index';
import { realtime, rest } from '../../apps/web/src/lib/client';
import { roomMembershipPolicy, useChat } from '../../apps/web/src/stores/chat';

const discussion: RcRoom = {
  _id: 'discussion-room',
  t: 'p',
  prid: 'parent-room',
  name: 'discussion-room',
};

const originalGetHistory = rest.getHistory;
const originalGetMembers = rest.getMembers;
const originalMarkRead = rest.markRead;
const originalGetSubscriptions = rest.getSubscriptions;
const originalGetRooms = rest.getRooms;
const originalJoinRoom = rest.joinRoom;
const originalRealtimeCall = realtime.call;
const originalOpenRoom = useChat.getState().openRoom;

function subscription(rid = discussion._id): RcSubscription {
  return {
    _id: `sub-${rid}`,
    rid,
    name: 'discussion-room',
    t: 'p',
    unread: 1,
    alert: true,
    open: true,
    ls: '2026-07-15T00:00:00.000Z',
    _updatedAt: '2026-07-15T00:01:00.000Z',
    u: { _id: 'me', username: 'me' },
  };
}

test.afterEach(() => {
  rest.getHistory = originalGetHistory;
  rest.getMembers = originalGetMembers;
  rest.markRead = originalMarkRead;
  rest.getSubscriptions = originalGetSubscriptions;
  rest.getRooms = originalGetRooms;
  rest.joinRoom = originalJoinRoom;
  realtime.call = originalRealtimeCall;
  useChat.setState({
    subscriptions: {},
    rooms: {},
    messages: {},
    historyLoaded: {},
    hasMore: {},
    members: {},
    memberErrors: {},
    activeRid: null,
    openRoom: originalOpenRoom,
  });
});

test('未加入讨论仍能输入，加入只影响订阅和通知', () => {
  assert.deepEqual(roomMembershipPolicy(false, discussion), {
    requiresJoin: true,
    canCompose: true,
  });
  assert.deepEqual(roomMembershipPolicy(false, { _id: 'public-room', t: 'c' }), {
    requiresJoin: true,
    canCompose: false,
  });
  assert.deepEqual(roomMembershipPolicy(true, discussion), {
    requiresJoin: false,
    canCompose: true,
  });
});

test('加入讨论使用通用 rooms.join 端点', async () => {
  let requestUrl = '';
  let requestBody = '';
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ success: true, room: discussion }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await client.joinRoom(discussion._id);

  assert.equal(requestUrl, 'https://chat.example/api/v1/rooms.join');
  assert.deepEqual(JSON.parse(requestBody), { roomId: discussion._id });
});

test('REST 客户端把 rooms.join 的 404 原样交给调用方', async () => {
  const requestUrls: string[] = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = String(input);
      requestUrls.push(url);
      if (url.endsWith('/rooms.join')) {
        return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`不应请求旧端点：${url}`);
    }) as typeof fetch,
  });

  await assert.rejects(client.joinRoom('public-room'), (err) => {
    assert.ok(err instanceof RcApiError);
    assert.equal(err.status, 404);
    return true;
  });

  assert.deepEqual(requestUrls, ['https://chat.example/api/v1/rooms.join']);
});

test('旧版服务端的讨论加入在 store 层回退 DDP joinRoom', async () => {
  const realtimeCalls: Array<{ method: string; params: unknown[] }> = [];
  const opened: string[] = [];
  rest.joinRoom = async () => {
    throw new RcApiError('Endpoint not found', 404);
  };
  realtime.call = (async (method: string, ...params: unknown[]) => {
    realtimeCalls.push({ method, params });
    return true;
  }) as typeof realtime.call;
  rest.getSubscriptions = async () => [subscription()];
  rest.getRooms = async () => [discussion];
  useChat.setState({
    subscriptions: {},
    rooms: { [discussion._id]: discussion },
    openRoom: async (rid) => {
      opened.push(rid);
    },
  });

  await useChat.getState().joinRoom(discussion._id);

  assert.deepEqual(realtimeCalls, [{ method: 'joinRoom', params: [discussion._id] }]);
  assert.equal(useChat.getState().subscriptions[discussion._id]?.rid, discussion._id);
  assert.deepEqual(opened, [discussion._id]);
});

test('服务端已有讨论订阅时刷新本地快照并在打开后清理未读', async () => {
  const historyCalls: Array<{ rid: string; type: string }> = [];
  const readCalls: string[] = [];
  let subscriptionRefreshes = 0;
  rest.getSubscriptions = async () => {
    subscriptionRefreshes++;
    return [subscription()];
  };
  rest.getRooms = async () => [discussion];
  rest.getHistory = (async (rid, type) => {
    historyCalls.push({ rid, type });
    return [
      {
        _id: 'discussion-message',
        rid,
        msg: '历史消息',
        ts: '2026-07-15T00:00:00.000Z',
        u: { _id: 'other', username: 'other' },
      } as RcMessage,
    ];
  }) as typeof rest.getHistory;
  rest.getMembers = async () => [];
  rest.markRead = (async (rid) => {
    readCalls.push(rid);
  }) as typeof rest.markRead;
  useChat.setState({
    subscriptions: {},
    rooms: { [discussion._id]: discussion },
    messages: {},
    historyLoaded: {},
    hasMore: {},
    members: {},
    memberErrors: {},
    activeRid: null,
  });

  await useChat.getState().openDiscussion(discussion._id);
  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.equal(useChat.getState().activeRid, discussion._id);
  assert.equal(subscriptionRefreshes, 1);
  assert.equal(useChat.getState().subscriptions[discussion._id]?.rid, discussion._id);
  assert.deepEqual(historyCalls, [{ rid: discussion._id, type: 'p' }]);
  assert.equal(useChat.getState().historyLoaded[discussion._id], true);
  assert.deepEqual(readCalls, [discussion._id]);
});

test('真正未订阅的讨论可以加载历史，但不会调用 subscriptions.read', async () => {
  const readCalls: string[] = [];
  rest.getSubscriptions = async () => [];
  rest.getRooms = async () => [discussion];
  rest.getHistory = async () => [];
  rest.getMembers = async () => [];
  rest.markRead = (async (rid) => {
    readCalls.push(rid);
  }) as typeof rest.markRead;
  useChat.setState({
    subscriptions: {},
    rooms: { [discussion._id]: discussion },
    messages: {},
    historyLoaded: {},
    hasMore: {},
    members: {},
    memberErrors: {},
    activeRid: 'parent-room',
  });

  await useChat.getState().openDiscussion(discussion._id);
  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.equal(useChat.getState().activeRid, discussion._id);
  assert.equal(useChat.getState().historyLoaded[discussion._id], true);
  assert.deepEqual(readCalls, []);
});

test('讨论历史加载失败时回滚到之前的会话', async () => {
  rest.getSubscriptions = async () => [];
  rest.getRooms = async () => [discussion];
  rest.getHistory = async () => {
    throw new Error('history unavailable');
  };
  rest.getMembers = async () => [];
  useChat.setState({
    subscriptions: {},
    rooms: { [discussion._id]: discussion },
    messages: {},
    historyLoaded: {},
    activeRid: 'parent-room',
  });

  await useChat.getState().openDiscussion(discussion._id);

  assert.equal(useChat.getState().activeRid, 'parent-room');
});

test('讨论加载失败不能覆盖期间发生的新导航', async () => {
  let rejectHistory!: (reason: Error) => void;
  const history = new Promise<RcMessage[]>((_, reject) => {
    rejectHistory = reject;
  });
  rest.getSubscriptions = async () => [];
  rest.getRooms = async () => [discussion];
  rest.getHistory = async () => history;
  rest.getMembers = async () => [];
  useChat.setState({
    subscriptions: {},
    rooms: { [discussion._id]: discussion },
    messages: {},
    historyLoaded: {},
    activeRid: 'parent-room',
  });

  const opening = useChat.getState().openDiscussion(discussion._id);
  for (let attempt = 0; attempt < 20 && useChat.getState().activeRid !== discussion._id; attempt++) {
    await Promise.resolve();
  }
  assert.equal(useChat.getState().activeRid, discussion._id);
  useChat.setState({ activeRid: 'new-room' });
  rejectHistory(new Error('history unavailable'));
  await opening;

  assert.equal(useChat.getState().activeRid, 'new-room');
});
