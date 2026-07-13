/**
 * 往频道里传一个 PDF，用来验证预览。
 *   pnpm exec tsx scripts/seed-pdf.ts [频道名]
 */
import { readFileSync } from 'node:fs';
import { RcRestClient } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';
const CHANNEL = process.argv[2] ?? 'general-test';

async function main(): Promise<void> {
  const rest = new RcRestClient({ baseUrl: BASE });
  await rest.login(USER, PASS);
  const subs = await rest.getSubscriptions();
  const sub = subs.find((s) => (s.fname || s.name) === CHANNEL);
  if (!sub) throw new Error(`找不到频道 ${CHANNEL}`);

  const bytes = readFileSync(process.env.PDF_PATH ?? '/tmp/test.pdf');
  const blob = new Blob([bytes], { type: 'application/pdf' });
  await rest.uploadMedia(sub.rid, blob, { fileName: '测试文档.pdf' });
  console.log(`✓ 已发送 测试文档.pdf（${blob.size} 字节）到 ${CHANNEL}`);
}

void main();
