import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rest, setServerBase } from '../../apps/web/src/lib/client';
import { useChat } from '../../apps/web/src/stores/chat';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
};

const originalSaveDraft = rest.saveDraft;
const originalGetSubscription = rest.getSubscription;

test.afterEach(() => {
  rest.saveDraft = originalSaveDraft;
  rest.getSubscription = originalGetSubscription;
  useChat.setState({ drafts: {} });
  store.clear();
  setServerBase('');
});

/**
 * 服务端草稿：`rooms.saveDraft` 存在，但**没有** REST 读取端点 —— 草稿挂在订阅上，
 * 只能按房间走 `subscriptions.getOne`（`subscriptions.get` 不返回 draft，真机实测）。
 */
test('草稿写本地后防抖同步到服务端，失败也不清本地', async () => {
  const saved: Array<{ rid: string; draft: string }> = [];
  rest.saveDraft = (async (rid: string, draft: string) => {
    saved.push({ rid, draft });
    return {};
  }) as typeof rest.saveDraft;

  useChat.getState().setDraft('room-1', '没写完的内容');
  assert.equal(useChat.getState().drafts['room-1'], '没写完的内容', '本地立即生效（离线可用）');
  assert.equal(saved.length, 0, '不是每个按键都打服务端，要防抖');
  assert.equal(JSON.parse(store.get('rcx-drafts') ?? '{}')['room-1'], '没写完的内容', '本地缓存已写入');

  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.deepEqual(saved, [{ rid: 'room-1', draft: '没写完的内容' }], '防抖后同步一次');

  // 清空草稿同样要推服务端（否则别的设备还看得到旧草稿）
  useChat.getState().setDraft('room-1', '');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(saved.at(-1)?.draft, '');
});

test('服务端草稿只在本地没有时拉下来，避免覆盖正在打的内容', async () => {
  const calls: string[] = [];
  rest.getSubscription = (async (rid: string) => {
    calls.push(rid);
    return { rid, draft: '别的设备上写的' };
  }) as typeof rest.getSubscription;

  // openRoom 还会拉历史/订阅，这里全部用最小替身，只观察草稿这一条链路
  const originalGetHistory = rest.getHistory;
  const originalGetSubscriptions = rest.getSubscriptions;
  const originalGetRooms = rest.getRooms;
  rest.getHistory = (async () => []) as typeof rest.getHistory;
  rest.getSubscriptions = (async () => []) as typeof rest.getSubscriptions;
  rest.getRooms = (async () => []) as typeof rest.getRooms;

  try {
    useChat.setState({ drafts: {}, subscriptions: {}, rooms: {} });
    await useChat.getState().openRoom('room-remote');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls.includes('room-remote'), true, '打开房间会去取一次服务端草稿');
    assert.equal(useChat.getState().drafts['room-remote'], '别的设备上写的');

    // 本地已有内容时不能被服务端覆盖
    useChat.setState({ drafts: { 'room-remote': '本机正在写的' } });
    await useChat.getState().openRoom('room-remote');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(useChat.getState().drafts['room-remote'], '本机正在写的');
  } finally {
    rest.getHistory = originalGetHistory;
    rest.getSubscriptions = originalGetSubscriptions;
    rest.getRooms = originalGetRooms;
  }
});

test('刷新订阅时把服务端草稿并进本地（本地已有的不覆盖）', async () => {
  const originalList = rest.getSubscriptions;
  const originalRooms = rest.getRooms;
  rest.getSubscriptions = (async () => [
    { _id: 's1', rid: 'room-a', t: 'p', name: 'a', draft: '别的设备写的' },
    { _id: 's2', rid: 'room-b', t: 'p', name: 'b', draft: '本地不该被覆盖' },
  ]) as unknown as typeof rest.getSubscriptions;
  rest.getRooms = (async () => []) as typeof rest.getRooms;

  try {
    useChat.setState({ drafts: { 'room-b': '本机写的' } });
    await useChat.getState().createDiscussionInRoom.length; // 保证 store 已就绪
    // 走公开动作触发一次订阅刷新（startDM 会调用 refreshSubsAndRooms）
    const originalCreateDM = rest.createDirectMessage;
    const originalOpenDM = rest.openDirectMessage;
    const originalOpenRoom = useChat.getState().openRoom;
    rest.createDirectMessage = (async () => ({ _id: 'room-a', t: 'd' })) as typeof rest.createDirectMessage;
    rest.openDirectMessage = (async () => ({})) as typeof rest.openDirectMessage;
    useChat.setState({ openRoom: async () => undefined, rooms: {}, subscriptions: {} });
    await useChat.getState().startDM(['someone']);

    assert.equal(useChat.getState().drafts['room-a'], '别的设备写的', '本地没有 → 用服务端的');
    assert.equal(useChat.getState().drafts['room-b'], '本机写的', '本地有 → 不被服务端覆盖');
    assert.equal(JSON.parse(store.get('rcx-drafts') ?? '{}')['room-a'], '别的设备写的', '合并结果落本地缓存');

    rest.createDirectMessage = originalCreateDM;
    rest.openDirectMessage = originalOpenDM;
    useChat.setState({ openRoom: originalOpenRoom });
  } finally {
    rest.getSubscriptions = originalList;
    rest.getRooms = originalRooms;
  }
});

/**
 * 自定义状态：接口只支持维护服务端的状态**列表**。
 *
 * 真机实测（RC 8.6）：`users.setStatus` 只接受 online/away/busy/offline，传自定义状态
 * id 直接 400；`users.updateOwnBasicInfo.statusType` 不报错但也不生效（那个值进的是
 * presence 逻辑）。所以实现里不做「应用到我」的假按钮，只做清单增删。
 */
test('自定义状态只做清单管理，不假装能应用（真机实测）', async () => {
  const users = await readFile(
    new URL('../../packages/rc-client/src/users.ts', import.meta.url),
    'utf8',
  );
  const settings = await readFile(
    new URL('../../apps/web/src/pages/SettingsPage.tsx', import.meta.url),
    'utf8',
  );

  // 删除的参数名是 customUserStatusId
  assert.match(users, /'custom-user-status\.delete', \{ customUserStatusId: id \}/);
  assert.match(settings, /\.listCustomUserStatuses\(/);
  assert.match(settings, /rest\.createCustomUserStatus/);
  assert.match(settings, /rest\.deleteCustomUserStatus/);
  // 不再有「把状态挂到自己身上」的入口
  assert.doesNotMatch(settings, /statusType: customStatusId/);
  assert.match(settings, /REST 做不到|无法把自定义状态挂到自己身上/);
  // 昵称/简介合并提交（服务端限流每分钟 1 次）
  assert.match(settings, /rest\.updateOwnBasicInfo\(\{ nickname, bio \}\)/);
  assert.match(settings, /限流每分钟 1 次/);
});

test('草稿在订阅列表里就有，不必逐个 getOne（真机实测）', async () => {
  const types = await readFile(
    new URL('../../packages/rc-client/src/types.ts', import.meta.url),
    'utf8',
  );
  assert.match(types, /`subscriptions\.get` 与 `subscriptions\.getOne` \*\*都会返回\*\*/);
});

test('停用账号：只给管理员看，且用 users.setActiveStatus', async () => {
  const userCard = await readFile(
    new URL('../../apps/web/src/components/UserCard.tsx', import.meta.url),
    'utf8',
  );
  const users = await readFile(
    new URL('../../packages/rc-client/src/users.ts', import.meta.url),
    'utf8',
  );

  assert.match(userCard, /me\?\.roles\?\.includes\('admin'\)/);
  assert.match(userCard, /canManageAccount && user\._id/);
  assert.match(userCard, /rest\.setUserActiveStatus\(user\._id, !user\.active\)/);
  assert.match(userCard, /停用后该账号无法登录/);
  // 成员列表接口不返回 active，打开卡片时补一次 users.info
  assert.match(userCard, /user\.active === false \? '启用账号' : '停用账号'/);
  assert.match(users, /'users\.setActiveStatus',/);
  assert.match(users, /activeStatus: active/);
});

test('成员面板点开个人卡片会补 users.info（成员列表没有 active）', async () => {
  const panel = await readFile(
    new URL('../../apps/web/src/components/MembersPanel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(panel, /const openMemberCard = async \(member: RcUser\)/);
  assert.match(panel, /rest\.getUserInfoById\(member\._id\)/);
  assert.match(panel, /onClick=\{\(\) => void openMemberCard\(m\)\}/);
});
