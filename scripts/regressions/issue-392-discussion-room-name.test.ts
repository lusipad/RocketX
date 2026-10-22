import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDiscussion,
  createGroup,
  createTeam,
  normalizeDiscussionName,
  RcRestClient,
  ROOM_NAME_MAX_LENGTH,
  saveRoomSettings,
  slugifyRoomName,
} from '../../packages/rc-client/src/index';

/**
 * issue #392：在群里创建讨论组失败 `is not a valid room name. [error-invalid-room-name]`。
 *
 * 服务端默认的房间名 slug 校验只放行 ASCII 字母数字与 `-_.`。这里用同一套规则
 * 伪造一个「会拒掉非法房间名」的服务端，确保 rc-client 边界永远不发非法名字，
 * 而不是等真实服务端回一个 400。
 */
const SERVER_SLUG_RE = /^[0-9a-zA-Z-_.]+$/;

const rejectingFetch = (seen: Array<{ path: string; body: Record<string, unknown> }>): typeof fetch =>
  (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = String(input).replace(/^.*\/api\/v1\//, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ path, body });
    const isDiscussion = path.includes('createDiscussion');
    const name = (isDiscussion ? undefined : (body.name ?? body.roomName)) as string | undefined;
    if (name !== undefined && !SERVER_SLUG_RE.test(name)) {
      return new Response(
        JSON.stringify({
          status: 'error',
          message: `${name} is not a valid room name.`,
          error: `${name} is not a valid room name. [error-invalid-room-name]`,
          errorType: 'error-invalid-room-name',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ success: true, discussion: { _id: 'r1', name } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

function client(seen: Array<{ path: string; body: Record<string, unknown> }>): RcRestClient {
  return new RcRestClient({ baseUrl: 'https://chat.example', fetchImpl: rejectingFetch(seen) });
}

test('房间名清洗后只含服务端放行的字符', () => {
  assert.equal(slugifyRoomName('hello world'), 'hello-world');
  assert.match(slugifyRoomName('引用块 + @ 的消息'), SERVER_SLUG_RE);
  assert.equal(slugifyRoomName('  Trim  Me  '), 'Trim-Me');
  assert.equal(slugifyRoomName('a---b'), 'a---b');
  assert.match(slugifyRoomName('!!!???'), /^room-[0-9a-f]{8}$/);
  for (const input of ['中文标题', '', '   ', '！！！', '🎉🎉', 'a b', '#1 标题']) {
    assert.match(slugifyRoomName(input), SERVER_SLUG_RE, `input: ${JSON.stringify(input)}`);
  }
});

test('清洗后为空时用摘要兜底，不同名字不会撞成同一个房间名', () => {
  const first = slugifyRoomName('修复登录失败', 'discussion');
  const second = slugifyRoomName('优化消息列表', 'discussion');
  assert.match(first, SERVER_SLUG_RE);
  assert.match(second, SERVER_SLUG_RE);
  assert.notEqual(first, second, '不同中文标题必须清洗成不同房间名，否则第二次创建会撞名');
  assert.match(first, /^discussion-[0-9a-f]{8}$/);
});

test('超长名字截断后仍保留区分度且不超上限', () => {
  const long = slugifyRoomName(`#${'标题'.repeat(80)}${'a'.repeat(120)}`, 'work-item-1');
  assert.ok(long.length <= ROOM_NAME_MAX_LENGTH, `length=${long.length}`);
  assert.match(long, SERVER_SLUG_RE);
  assert.notEqual(
    long,
    slugifyRoomName(`#${'问题'.repeat(80)}${'a'.repeat(120)}`, 'work-item-1'),
    '截断后仍要靠摘要区分不同标题',
  );
});

test('讨论名规范化：保留中文、空格与常用符号，截断超长，空值兜底（issue #397）', () => {
  assert.equal(normalizeDiscussionName('需求评审'), '需求评审');
  assert.equal(normalizeDiscussionName('  Trim  Me  '), 'Trim  Me');
  assert.equal(normalizeDiscussionName('#123 工作项讨论 🎉'), '#123 工作项讨论 🎉');
  assert.equal(normalizeDiscussionName(''), '讨论');
  assert.equal(normalizeDiscussionName('   ', '备用'), '备用');
  const long = '标'.repeat(80);
  assert.equal(normalizeDiscussionName(long).length, ROOM_NAME_MAX_LENGTH);
});

test('创建讨论组保留中文与空格等原名（issue #397）', async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rc = client(seen);

  // 走真实调用路径：讨论名称保留中文（Rocket.Chat 讨论名是 fname，跳过房间名 slug 校验）
  await rc.createDiscussion('parent-room', '引用块 + @ 的消息没有显示出来', 'msg-1');

  assert.equal(seen[0].path, 'rooms.createDiscussion');
  const name = seen[0].body.t_name as string;
  assert.equal(name, '引用块 + @ 的消息没有显示出来');
  assert.equal(seen[0].body.prid, 'parent-room');
  assert.equal(seen[0].body.pmid, 'msg-1');
});

test('创建群组与团队同样不会把中文名原样发给服务端（issue #392）', async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rc = client(seen);

  await rc.createGroup('测试 群组', ['alice']);
  await rc.createTeam('研发 团队', ['alice']);

  assert.equal(seen[0].path, 'groups.create');
  assert.match(seen[1].path, /^teams\.create$/);
  for (const entry of seen) {
    assert.match(entry.body.name as string, SERVER_SLUG_RE, `${entry.path} name=${entry.body.name}`);
  }
});

test('改房间名时也走同一套清洗规则', async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rc = client(seen);

  await saveRoomSettings(rc.endpointContext(), 'rid-1', { name: '新的 房间名' });

  assert.equal(seen[0].path, 'rooms.saveRoomSettings');
  assert.match(seen[0].body.roomName as string, SERVER_SLUG_RE);
});

test('真实服务端对频道群组会拒掉的房间名，清洗后必须被接受（issue #392）', async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rc = client(seen);

  // 反向校验：证明 groups.create 确实会拒掉原始名字
  const raw = await rejectingFetch(seen)('https://chat.example/api/v1/groups.create', {
    method: 'POST',
    body: JSON.stringify({ name: '#123 工作项标题' }),
  });
  assert.equal(raw.status, 400);
  assert.equal((await raw.json()).errorType, 'error-invalid-room-name');

  await rc.createGroup('#123 工作项标题', ['alice']);

  assert.equal(seen.length, 2);
  assert.match(seen[1].body.name as string, SERVER_SLUG_RE);
});
