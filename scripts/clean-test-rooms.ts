/**
 * 清理历史冒烟测试遗留的房间（冒烟测试-xxx / 讨论-xxx）。
 *
 * 早期的 smoke.ts 每跑一次就建一个频道且从不删除，跑几十次会把真实用户的
 * 会话列表淹掉。smoke 现在会自己清理，这个脚本只用来收拾历史遗留。
 *
 *   pnpm exec tsx scripts/clean-test-rooms.ts          # 只列出，不删
 *   pnpm exec tsx scripts/clean-test-rooms.ts --delete # 真删
 */
import { RcRestClient } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';
const DO_DELETE = process.argv.includes('--delete');

/** 只认这两种前缀 —— 宁可漏删，也不能误删真实频道 */
const TEST_NAME = /^(冒烟测试-|讨论-)/;

async function main(): Promise<void> {
  const rest = new RcRestClient({ baseUrl: BASE });
  await rest.login(USER, PASS);

  const rooms = await rest.getRooms();
  const targets = rooms.filter(
    (r) => (r.t === 'c' || r.t === 'p') && TEST_NAME.test(r.fname || r.name || ''),
  );

  console.log(`\n服务器上共 ${rooms.length} 个房间，其中测试遗留 ${targets.length} 个：\n`);
  for (const r of targets) console.log(`  ${r.t}  ${r.fname || r.name}`);

  if (targets.length === 0) return;

  if (!DO_DELETE) {
    console.log(`\n这是预演。确认无误后加 --delete 真正删除。\n`);
    return;
  }

  console.log('');
  let ok = 0;
  for (const r of targets) {
    try {
      await rest.deleteRoom(r._id, r.t as 'c' | 'p');
      ok++;
      console.log(`  ✓ 已删除 ${r.fname || r.name}`);
    } catch (err) {
      console.log(`  ✗ ${r.fname || r.name} — ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n完成：删除 ${ok} / ${targets.length}\n`);
}

void main();
