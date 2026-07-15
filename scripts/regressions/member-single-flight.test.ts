import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcUser } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import { useChat } from '../../apps/web/src/stores/chat';

const room = { _id: 'single-flight-room', t: 'c' as const };
const member = (id: string): RcUser => ({ _id: id, username: `user-${id}` });
const originalGetMembers = rest.getMembers;
const originalInviteToRoom = rest.inviteToRoom;

function reset(memberErrors: Record<string, string> = {}, members: Record<string, RcUser[]> = {}) {
  useChat.setState({ rooms: { [room._id]: room }, subscriptions: {}, memberErrors, members });
}

test.afterEach(() => {
  rest.getMembers = originalGetMembers;
  rest.inviteToRoom = originalInviteToRoom;
  reset();
});

test('同房间同版本的并发成员加载只请求一次', async () => {
  reset();
  let calls = 0;
  let release!: (users: RcUser[]) => void;
  const gate = new Promise<RcUser[]>((resolve) => {
    release = resolve;
  });
  rest.getMembers = async () => {
    calls++;
    return gate;
  };

  const first = useChat.getState().loadMembers(room._id);
  const second = useChat.getState().loadMembers(room._id);
  release([member('1')]);
  const results = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.deepEqual(results.map((users) => users.map((user) => user._id)), [['1'], ['1']]);
});

test('并发失败只请求一次且下一次调用可以重试', async () => {
  reset();
  let calls = 0;
  rest.getMembers = async () => {
    calls++;
    throw new Error('暂时失败');
  };

  const failed = await Promise.all([
    useChat.getState().loadMembers(room._id),
    useChat.getState().loadMembers(room._id),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(failed, [[], []]);

  rest.getMembers = async () => {
    calls++;
    return [member('2')];
  };
  const retried = await useChat.getState().loadMembers(room._id);
  assert.equal(calls, 2);
  assert.deepEqual(retried.map((user) => user._id), ['2']);
});

test('已有成员缓存刷新失败时返回旧缓存', async () => {
  const cached = [member('cached')];
  reset({ [room._id]: '上次失败' }, { [room._id]: cached });
  rest.getMembers = async () => {
    throw new Error('仍然失败');
  };

  const result = await useChat.getState().loadMembers(room._id);
  assert.deepEqual(result, cached);
  assert.deepEqual(useChat.getState().members[room._id], cached);
});

test('旧版本请求完成时不会清掉邀请后的新版本在途请求', async () => {
  reset();
  let calls = 0;
  const releases: Array<(users: RcUser[]) => void> = [];
  rest.getMembers = () => {
    calls++;
    return new Promise<RcUser[]>((resolve) => releases.push(resolve));
  };
  rest.inviteToRoom = async () => undefined;

  const stale = useChat.getState().loadMembers(room._id);
  const invitedUser = member('invited');
  const inviting = useChat.getState().inviteMembers(room._id, [invitedUser]);
  for (let attempt = 0; attempt < 20 && calls < 2; attempt++) await Promise.resolve();
  assert.equal(calls, 2, '邀请后应启动一个新版本成员请求');

  releases[0]?.([member('old')]);
  await stale;
  useChat.setState({ memberErrors: { [room._id]: '强制检查新版本在途请求' } });
  const joined = useChat.getState().loadMembers(room._id);
  assert.equal(calls, 2);

  releases[1]?.([member('old'), invitedUser]);
  const [, joinedMembers] = await Promise.all([inviting, joined]);
  assert.equal(calls, 2);
  assert.deepEqual(joinedMembers.map((user) => user._id).sort(), ['invited', 'old']);
  assert.deepEqual(
    useChat.getState().members[room._id]?.map((user) => user._id).sort(),
    ['invited', 'old'],
  );
});
