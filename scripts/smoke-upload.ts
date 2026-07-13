/**
 * 冒烟测试：中文文件名上传（直接跑 rc-client，不经浏览器）
 * 用法：pnpm --filter @rcx/ado-bridge exec tsx ../../scripts/smoke-upload.ts
 */
import { RcRestClient } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const RID = process.env.RID ?? '6a53c2bac678c79d5a359eee';

async function main() {
  const rest = new RcRestClient({ baseUrl: BASE });
  await rest.login(process.env.RC_USER ?? 'admin', process.env.RC_PASS ?? 'rcxdev123');

  const name = '项目计划书.txt';
  await rest.uploadMedia(RID, new File(['中文内容测试'], name, { type: 'text/plain' }));

  const history = await rest.getHistory(RID, 'c', 1);
  const stored = history[0]?.file?.name;
  console.log('上传文件名:', name);
  console.log('服务端存储:', stored);
  console.log(stored === name ? '✓ 中文文件名正确' : '✗ 文件名被破坏');
  process.exit(stored === name ? 0 : 1);
}

void main();
