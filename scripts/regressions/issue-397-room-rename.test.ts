import assert from 'node:assert/strict';
import test from 'node:test';
import { RcApiError, RcRestClient, normalizeDiscussionName, type RcRoom, type RcSubscription } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import { buildConversations, useChat } from '../../apps/web/src/stores/chat';
import { useToast } from '../../apps/web/src/stores/toast';

function captureClient(status = 200, errorType = '') {
  const requests: Array<{ path: string; body: Record<string, string> }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input, init) => {
      requests.push({ path: String(input).split('/api/v1/')[1], body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(status === 200 ? { success: true } : {
        success: false, errorType, error: errorType,
      }), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  return { client, requests };
}

test('重命名保留中文展示名，使用 roomName 而不是创建讨论的 t_name', async () => {
  const { client, requests } = captureClient();
  for (const name of ['需求评审', 'CNC 方案评审', '#123 修复（紧急）🎉', 'room-test']) {
    await client.saveRoomSettings('existing-room', { name });
    assert.deepEqual(requests.at(-1), {
      path: 'rooms.saveRoomSettings', body: { rid: 'existing-room', roomName: name },
    });
  }
});

test('空白或仅控制字符的重命名不发请求、不生成默认名', async () => {
  const { client, requests } = captureClient();
  for (const name of ['', ' \t\n ', '\u0000\u007f\u0085']) {
    await assert.rejects(client.saveRoomSettings('existing-room', { name }), /名称不能为空/);
  }
  assert.equal(requests.length, 0);
});

test('服务端命名限制或重名错误原样返回，不自动改成哈希名重试', async () => {
  for (const errorType of ['error-invalid-room-name', 'error-duplicate-channel-name', 'error-not-allowed']) {
    const { client, requests } = captureClient(400, errorType);
    await assert.rejects(client.saveRoomSettings('existing-room', { name: '需求评审' }),
      (error: unknown) => error instanceof RcApiError && error.errorType === errorType);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.roomName, '需求评审');
  }
});

test('名称清理控制字符、合并空白，保留中文和 emoji 的完整代理对', async () => {
  assert.equal(normalizeDiscussionName('  需求\u0000\t 评审\n（紧急）\u007f '), '需求 评审 （紧急）');
  assert.equal(normalizeDiscussionName('', '  备用\u0000 名  '), '备用 名');
  for (const name of ['中'.repeat(49) + '🎉', '中'.repeat(48) + '🎉', '🎉'.repeat(30)]) {
    const { client, requests } = captureClient();
    await client.saveRoomSettings('existing-room', { name });
    const output = requests[0].body.roomName;
    assert.equal(output, normalizeDiscussionName(name));
    assert.ok(output.length <= 50);
    assert.equal(output, new TextDecoder().decode(new TextEncoder().encode(output)), '不可截断 UTF-16 代理对');
  }
});

const originalSave = rest.saveRoomSettings;
const originalInfo = rest.getRoomInfo;
const rid = 'existing-room';
const originalRoom: RcRoom = { _id: rid, t: 'p', name: 'random-room-id', fname: '旧讨论', prid: 'parent', lm: '2026-10-26T00:00:00Z' };
const originalSub: RcSubscription = {
  _id: 'subscription-1', rid, t: 'p', name: 'random-room-id', fname: '旧讨论', prid: 'parent',
  open: true, unread: 3, alert: true, f: true, _updatedAt: '2026-10-26T00:00:00Z', u: { _id: 'me', username: 'me' },
};

test.beforeEach(() => {
  useChat.setState({ rooms: { [rid]: { ...originalRoom } }, subscriptions: { [rid]: { ...originalSub } } });
  useToast.setState({ toasts: [] });
});

test.afterEach(() => {
  rest.saveRoomSettings = originalSave;
  rest.getRoomInfo = originalInfo;
  useChat.setState({ rooms: {}, subscriptions: {} });
  useToast.setState({ toasts: [] });
});

test('讨论重命名回读 fname，同步会话列表，保留内部名称与订阅状态', async () => {
  const calls: string[] = [];
  rest.saveRoomSettings = async () => { calls.push('save'); };
  rest.getRoomInfo = async () => {
    calls.push('read');
    return { _id: rid, t: 'p', name: originalRoom.name, fname: '需求评审', prid: 'parent' };
  };
  await useChat.getState().saveRoomSettings(rid, { name: '  需求评审  ' });
  const { rooms, subscriptions } = useChat.getState();
  assert.deepEqual(calls, ['save', 'read']);
  assert.equal(rooms[rid].fname, '需求评审');
  assert.equal(rooms[rid].name, 'random-room-id');
  assert.equal(rooms[rid].prid, 'parent');
  assert.equal(rooms[rid].lm, originalRoom.lm, '回读不能丢掉房间活动时间');
  assert.deepEqual(subscriptions[rid], { ...originalSub, fname: '需求评审' });
  assert.equal(buildConversations(subscriptions, rooms)[0].name, '需求评审');
});

test('普通频道采用服务端返回的 slug 与展示名，不覆盖异步期间的新状态', async () => {
  rest.saveRoomSettings = async () => {};
  rest.getRoomInfo = async () => {
    useChat.setState((state) => ({
      subscriptions: { ...state.subscriptions, [rid]: { ...state.subscriptions[rid], unread: 7 } },
    }));
    return { _id: rid, t: 'c', name: 'yan-fa-ping-shen', fname: '研发评审' };
  };
  await useChat.getState().saveRoomSettings(rid, { name: '研发评审' });
  const state = useChat.getState();
  assert.equal(state.rooms[rid].name, 'yan-fa-ping-shen');
  assert.equal(state.rooms[rid].fname, '研发评审');
  assert.equal(state.subscriptions[rid].name, 'yan-fa-ping-shen');
  assert.equal(state.subscriptions[rid].unread, 7);
});

test('回读没有 fname 时清除旧展示名，未订阅房间不伪造订阅', async () => {
  rest.saveRoomSettings = async () => {};
  rest.getRoomInfo = async () => ({ _id: rid, t: 'p', name: 'new-name' });
  await useChat.getState().saveRoomSettings(rid, { name: 'new-name' });
  assert.equal(useChat.getState().rooms[rid].fname, undefined);
  assert.equal(useChat.getState().subscriptions[rid].fname, undefined);
  useChat.setState({ subscriptions: {} });
  await useChat.getState().saveRoomSettings(rid, { name: 'new-name' });
  assert.deepEqual(useChat.getState().subscriptions, {});
});

test('命名校验失败保留旧名称，提示命名设置而不是管理权限', async () => {
  const error = new RcApiError('invalid room name', 400, 'error-invalid-room-name');
  rest.saveRoomSettings = async () => { throw error; };
  rest.getRoomInfo = async () => { assert.fail('写入失败不应回读'); };
  await assert.rejects(useChat.getState().saveRoomSettings(rid, { name: '需求评审' }), error);
  assert.deepEqual(useChat.getState().rooms[rid], originalRoom);
  assert.deepEqual(useChat.getState().subscriptions[rid], originalSub);
  assert.match(useToast.getState().toasts.at(-1)!.message, /命名/);
  assert.equal(useToast.getState().toasts.some((item) => item.kind === 'success'), false);
});

test('保存成功但回读失败，明确提示已保存且待确认，不伪造本地新名', async () => {
  rest.saveRoomSettings = async () => {};
  rest.getRoomInfo = async () => { throw new Error('read failed'); };
  await useChat.getState().saveRoomSettings(rid, { name: '需求评审' });
  assert.deepEqual(useChat.getState().rooms[rid], originalRoom);
  assert.deepEqual(useChat.getState().subscriptions[rid], originalSub);
  assert.match(useToast.getState().toasts.at(-1)!.message, /已保存.*刷新失败/);
  assert.equal(useToast.getState().toasts.some((item) => item.kind === 'success'), false);
});

test('仅编辑公告仍支持清空，不触发改名或额外回读', async () => {
  rest.saveRoomSettings = async (_rid, settings) => { assert.deepEqual(settings, { announcement: '' }); };
  rest.getRoomInfo = async () => { assert.fail('非改名操作无须额外回读'); };
  await useChat.getState().saveRoomSettings(rid, { announcement: '' });
  assert.deepEqual(useChat.getState().rooms[rid], { ...originalRoom, announcement: '' });
});
