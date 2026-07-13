/**
 * 验证 ADO 地址推导：用户可能粘各种形态的地址，都要能推出集合根。
 *   pnpm exec tsx scripts/test-ado-probe.ts
 *
 * 直接 import 真实实现——之前这里复制了一份 candidateBases，
 * 改了 adoDirect.ts 这个测试也照样通过，等于没测。
 */
import { candidateBases } from '../apps/web/src/lib/adoDirect';

const CASES: { input: string; mustContain: string; desc: string }[] = [
  {
    desc: '本机 Server 2022：粘集合根（实测形态）',
    input: 'http://localhost:8081/DefaultCollection',
    mustContain: 'http://localhost:8081/DefaultCollection',
  },
  {
    desc: '本机 Server 2022：粘项目页',
    input: 'http://localhost:8081/DefaultCollection/test',
    mustContain: 'http://localhost:8081/DefaultCollection',
  },
  {
    desc: '本机 Server 2022：只给主机+端口',
    input: 'localhost:8081',
    mustContain: 'http://localhost:8081/DefaultCollection',
  },
  {
    desc: '用户的场景：无 /tfs，粘的是工作项页地址',
    input: 'http://ado-server:8080/DefaultCollection/MyProject/_workitems/edit/128',
    mustContain: 'http://ado-server:8080/DefaultCollection',
  },
  {
    desc: '无 /tfs，粘的是项目首页',
    input: 'http://ado-server:8080/DefaultCollection/MyProject',
    mustContain: 'http://ado-server:8080/DefaultCollection',
  },
  {
    desc: '无 /tfs，直接给集合根',
    input: 'http://ado-server:8080/DefaultCollection',
    mustContain: 'http://ado-server:8080/DefaultCollection',
  },
  {
    desc: '经典 TFS：带 /tfs 虚拟目录',
    input: 'http://ado:8080/tfs/DefaultCollection/Proj/_git/repo',
    mustContain: 'http://ado:8080/tfs/DefaultCollection',
  },
  {
    desc: '自定义集合名',
    input: 'http://ado:8080/ProductCollection/Proj/_workitems',
    mustContain: 'http://ado:8080/ProductCollection',
  },
  {
    desc: 'HTTPS + 域名',
    input: 'https://devops.company.com/DefaultCollection/Proj/_boards',
    mustContain: 'https://devops.company.com/DefaultCollection',
  },
  {
    desc: '只给主机（探测会试常见集合名）',
    input: 'ado-server:8080',
    mustContain: 'http://ado-server:8080/DefaultCollection',
  },
];

let pass = 0;
let fail = 0;
for (const { input, mustContain, desc } of CASES) {
  const bases = candidateBases(input);
  const ok = bases.includes(mustContain);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${desc}`);
  console.log(`   输入: ${input}`);
  console.log(`   候选: ${bases.join('  →  ')}`);
  if (!ok) console.log(`   期望包含: ${mustContain}`);
  console.log();
}
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
