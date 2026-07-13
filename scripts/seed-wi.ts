import { RcRestClient } from '../packages/rc-client/src/index';
async function main() {
  const rest = new RcRestClient({ baseUrl: 'http://localhost:3300' });
  await rest.login('admin', 'rcxdev123');
  for (const n of ['WI-1234-登录报错', 'WI-1290-导出超时', '产品周会']) {
    try {
      await rest.createGroup(n, [], true);
      console.log('  建群', n);
    } catch (e) { console.log('  跳过', n, (e as Error).message.slice(0, 40)); }
  }
}
void main();
