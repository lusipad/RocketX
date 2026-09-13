import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDiscussion, RcRestClient, slugifyRoomName } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import {
  normalizeDiscussionEnabled,
  refreshDiscussionsCapability,
  setDiscussionEnabledProviderForTests,
  useChat,
} from '../../apps/web/src/stores/chat';
import { useToast } from '../../apps/web/src/stores/toast';

function captureClient(seen: Array<{ path: string; body: Record<string, unknown> }>): RcRestClient {
  return new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push({
        path: String(input).replace(/^.*\/api\/v1\//, ''),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ success: true, discussion: { _id: 'd1', name: 'd1' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
}

const originalCreateDiscussion = rest.createDiscussion;
const originalGetSubs = rest.getSubscriptions;
const originalGetRooms = rest.getRooms;

test.afterEach(() => {
  rest.createDiscussion = originalCreateDiscussion;
  rest.getSubscriptions = originalGetSubs;
  rest.getRooms = originalGetRooms;
  useToast.setState({ toasts: [] });
  useChat.setState({ discussionsEnabled: true });
});

test('不带 pmid 也能创建讨论：空群/新群不用先有消息（真机验证过的 Rocket.Chat 行为）', async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rc = captureClient(seen);

  await createDiscussion(rc.endpointContext(), 'room-general', '方案讨论');

  assert.equal(seen[0].path, 'rooms.createDiscussion');
  assert.equal(seen[0].body.prid, 'room-general');
  assert.equal('pmid' in seen[0].body, false, '房间级创建不能带 pmid');
  // 名称仍走 issue #392 的 slug 清洗（服务端只放行 [0-9a-zA-Z-_.]，中文会被摘要兜底）
  assert.equal(seen[0].body.t_name, slugifyRoomName('方案讨论', 'discussion'));
  assert.match(seen[0].body.t_name as string, /^[0-9a-zA-Z-_.]+$/);
});

test('带 pmid 时仍然原样透传（从消息创建的老路径不变）', async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rc = captureClient(seen);

  await createDiscussion(rc.endpointContext(), 'room-general', '方案讨论', 'msg-1');

  assert.equal(seen[0].body.pmid, 'msg-1');
});

test('Discussion_enabled 关掉时入口收口，而不是让用户点了才吃服务端错误', async () => {
  assert.equal(normalizeDiscussionEnabled(false), false);
  assert.equal(normalizeDiscussionEnabled('false'), false);
  // 读不到（老服务端 / 限流）按开启处理：不凭一次读取失败把功能藏起来
  for (const value of [true, 'true', undefined, null, '', 0]) {
    assert.equal(normalizeDiscussionEnabled(value), true, `value: ${JSON.stringify(value)}`);
  }

  const messageItem = await readFile(
    new URL('../../apps/web/src/components/MessageItem.tsx', import.meta.url),
    'utf8',
  );
  const conversationList = await readFile(
    new URL('../../apps/web/src/components/ConversationList.tsx', import.meta.url),
    'utf8',
  );
  const navRail = await readFile(
    new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url),
    'utf8',
  );
  const roomInfo = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );

  // 启动时探测一次，并把结果同步进 store
  assert.match(chatStore, /void refreshDiscussionsCapability\(\);/);
  assert.match(chatStore, /getPublicSetting\('Discussion_enabled'\)/);
  // 每个入口都按开关决定是否显示
  assert.match(messageItem, /!inThread && discussionsEnabled/);
  assert.match(conversationList, /filter === 'discussions' && !discussionsEnabled/);
  assert.match(navRail, /\{discussionsEnabled && \(/);
  assert.match(roomInfo, /discussionsEnabled && \(conv\.type === 'c' \|\| conv\.type === 'p'\)/);
});

test('房间级创建讨论的入口在 + 菜单、会话分类和群信息里都有', async () => {
  const navRail = await readFile(
    new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url),
    'utf8',
  );
  const conversationList = await readFile(
    new URL('../../apps/web/src/components/ConversationList.tsx', import.meta.url),
    'utf8',
  );
  const roomInfo = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );
  const dialog = await readFile(
    new URL('../../apps/web/src/components/CreateRoomDiscussionDialog.tsx', import.meta.url),
    'utf8',
  );

  assert.match(navRail, /创建讨论/);
  assert.match(conversationList, /discussions: \{ label: '创建讨论'/);
  assert.match(roomInfo, /在此房间创建讨论/);
  // 不选中任何消息也能建：弹窗只要求父房间，不要求消息
  assert.match(dialog, /createDiscussionInRoom\(parentRid, name\.trim\(\) \|\| undefined\)/);
});

test('Rocket.Chat 拒绝嵌套讨论，父房间候选必须排除讨论（真机实测）', async () => {
  const workItemDialog = await readFile(
    new URL('../../apps/web/src/components/CreateWorkItemDiscussionDialog.tsx', import.meta.url),
    'utf8',
  );
  const helper = await readFile(
    new URL('../../apps/web/src/components/CreateDiscussionDialog.tsx', import.meta.url),
    'utf8',
  );
  const roomInfo = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );

  // 服务端对讨论再调 rooms.createDiscussion 返回 error-nested-discussion（RC 8.6 实测）
  assert.match(helper, /filter\(\(room\) => !room\.prid\)/);
  assert.match(workItemDialog, /\(room\.t === 'c' \|\| room\.t === 'p'\) && !room\.prid/);
  // 讨论里既不给「再建讨论」，也不给 RC 根本不存在的「升级为频道」假按钮
  assert.doesNotMatch(roomInfo, /在此讨论下再建讨论/);
  assert.doesNotMatch(roomInfo, /label="把讨论升级为频道"/);
  assert.doesNotMatch(roomInfo, /ConvertDiscussionDialog/);
  assert.doesNotMatch(roomInfo, /convertDiscussionToChannel/);
});

test('store 的房间级创建走不带 pmid 的接口，并把开关决定权交给服务端', async () => {
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );

  assert.match(chatStore, /createDiscussionInRoom: async \(rid, requestedName\)/);
  // 房间级创建不带 pmid：这是「群里没有消息也能开讨论」的关键
  assert.match(chatStore, /const discussion = await rest\.createDiscussion\(rid, name\);/);
  assert.match(chatStore, /if \(!\(await ensureDiscussionsEnabled\(\)\)\)/);
  assert.match(chatStore, /本服务器的讨论功能已被管理员关闭/);
});

test('服务端关闭讨论时，房间级创建只提示不请求（并同步掉 UI 入口）', async () => {
  const restoreProvider = setDiscussionEnabledProviderForTests(async () => false);
  let requests = 0;
  rest.createDiscussion = (async () => {
    requests += 1;
    return { _id: 'd1', t: 'p' } as never;
  }) as typeof rest.createDiscussion;

  try {
    await refreshDiscussionsCapability();
    assert.equal(useChat.getState().discussionsEnabled, false, '开关要同步进 store 供界面隐藏入口');

    await useChat.getState().createDiscussionInRoom('room-general', '方案讨论');

    assert.equal(requests, 0, '关闭时不该再发服务端请求');
    assert.ok(
      useToast.getState().toasts.some((toast) => toast.message.includes('管理员关闭')),
      '要给出明确原因，而不是把服务端错误抛给用户',
    );
  } finally {
    restoreProvider();
  }
});

test('服务端开启讨论时，房间级创建走接口并跳进新讨论', async () => {
  const restoreProvider = setDiscussionEnabledProviderForTests(async () => true);
  const opened: string[] = [];
  const originalOpenRoom = useChat.getState().openRoom;
  rest.createDiscussion = (async (prid: string) => {
    assert.equal(prid, 'room-general');
    return { _id: 'new-discussion', t: 'p' } as never;
  }) as typeof rest.createDiscussion;
  // 创建后会刷新会话列表快照；这里给最小替身，别让网络失败盖住断言目标。
  rest.getSubscriptions = (async () => []) as typeof rest.getSubscriptions;
  rest.getRooms = (async () => []) as typeof rest.getRooms;
  useChat.setState({ openRoom: async (rid: string) => void opened.push(rid) });

  try {
    await refreshDiscussionsCapability();
    assert.equal(useChat.getState().discussionsEnabled, true);

    await useChat.getState().createDiscussionInRoom('room-general', '方案讨论');

    assert.deepEqual(opened, ['new-discussion'], '创建后应跳进讨论');
  } finally {
    restoreProvider();
    useChat.setState({ openRoom: originalOpenRoom });
  }
});
