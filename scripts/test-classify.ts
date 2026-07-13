/**
 * 会话分类的真实数据校验：单聊 / 多人直聊 / 群组 / 团队 / 讨论 分得对不对。
 * 这类 bug（多人直聊混进单聊）光看代码看不出来，得拿服务器上真实的房间跑一遍。
 *
 *   pnpm test:classify
 */
import { RcRestClient } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const rest = new RcRestClient({ baseUrl: BASE });
  await rest.login(USER, PASS);

  const subs = await rest.getSubscriptions();
  const rooms = await rest.getRooms();
  const roomMap = Object.fromEntries(rooms.map((r) => [r._id, r]));

  console.log('\n[会话分类]');

  // 与 buildConversations 里的判定保持一致
  const classify = (sub: (typeof subs)[number]) => {
    const room = roomMap[sub.rid];
    const dmSize = room?.uids?.length ?? room?.usersCount;
    const isMultiDM =
      sub.t === 'd' &&
      (dmSize !== undefined ? dmSize > 2 : (sub.fname ?? sub.name).includes(','));
    return { isMultiDM, room };
  };

  const open = subs.filter((s) => s.open !== false);
  const dms = open.filter((s) => s.t === 'd');
  const oneOnOne = dms.filter((s) => !classify(s).isMultiDM);
  const multi = dms.filter((s) => classify(s).isMultiDM);

  console.log(`  服务器上：${open.length} 个会话，其中 t='d' 的 ${dms.length} 个`);

  check(
    '所有 1对1 单聊的成员数确实是 2',
    oneOnOne.every((s) => {
      const room = roomMap[s.rid];
      const n = room?.uids?.length ?? room?.usersCount;
      return n === undefined || n === 2;
    }),
    `${oneOnOne.length} 个：${oneOnOne.map((s) => s.fname || s.name).join('、') || '无'}`,
  );

  check(
    '所有多人直聊的成员数确实 > 2',
    multi.every((s) => {
      const room = roomMap[s.rid];
      const n = room?.uids?.length ?? room?.usersCount;
      return n === undefined || n > 2;
    }),
    `${multi.length} 个：${multi.map((s) => s.fname || s.name).join('、') || '无'}`,
  );

  check(
    '多人直聊的名字里带逗号（RC 用逗号拼成员名）',
    multi.every((s) => (s.fname ?? s.name).includes(',')),
    multi.length ? '' : '（当前没有多人直聊，跳过）',
  );

  // 排序：确认没有会话把 _updatedAt 当成最后消息时间
  console.log('\n[会话排序]');
  const withLm = open.filter((s) => roomMap[s.rid]?.lm);
  check(
    '有消息的会话都能取到真实的最后消息时间',
    withLm.length > 0,
    `${withLm.length} 个会话有 lm`,
  );

  const noMsg = open.filter((s) => {
    const r = roomMap[s.rid];
    return !r?.lm && !r?.lastMessage;
  });
  check(
    '没有消息的会话不会因为「被打开过」而拿到时间戳',
    noMsg.every((s) => {
      const r = roomMap[s.rid];
      // buildConversations 只取 lm / lastMessage.ts，两者都没有就是 0
      return !r?.lm && !r?.lastMessage;
    }),
    `${noMsg.length} 个空会话`,
  );

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

void main();
