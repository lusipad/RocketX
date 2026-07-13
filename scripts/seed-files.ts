/**
 * 往指定频道传几个可预览的文件（txt / md / json），用来验证下载与预览。
 *   pnpm exec tsx scripts/seed-files.ts [频道名]
 */
import { RcRestClient } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';
const CHANNEL = process.argv[2] ?? 'general-test';

const files: { name: string; type: string; content: string }[] = [
  {
    name: '说明文档.txt',
    type: 'text/plain',
    content: '这是一个纯文本文件。\n第二行内容。\n用于验证点击预览。\n',
  },
  {
    name: '发布计划.md',
    type: 'text/markdown',
    content:
      '# 发布计划\n\n- [x] 修复会话排序\n- [ ] 备注名\n\n**重点**：下周一发版。\n\n```js\nconsole.log("hi")\n```\n',
  },
  {
    name: 'data.json',
    type: 'application/json',
    content: JSON.stringify({ ok: true, items: [1, 2, 3] }, null, 2),
  },
];

async function main(): Promise<void> {
  const rest = new RcRestClient({ baseUrl: BASE });
  await rest.login(USER, PASS);

  const subs = await rest.getSubscriptions();
  const sub = subs.find((s) => (s.fname || s.name) === CHANNEL);
  if (!sub) throw new Error(`找不到频道 ${CHANNEL}`);
  console.log('房间:', CHANNEL, sub.rid);

  for (const f of files) {
    const blob = new Blob([f.content], { type: f.type });
    await rest.uploadMedia(sub.rid, blob, { fileName: f.name });
    console.log('  ✓ 已发送', f.name, `(${blob.size} 字节)`);
  }
}

void main();
