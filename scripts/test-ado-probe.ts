/**
 * 验证 ADO 地址推导：用户可能粘各种形态的地址，都要能推出集合根。
 * 用法：pnpm exec tsx scripts/test-ado-probe.ts
 */

// 与 apps/web/src/lib/adoDirect.ts 的 candidateBases 保持一致
function candidateBases(input: string): string[] {
  let raw = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const origin = url.origin;
  const segments = url.pathname.split('/').filter(Boolean);
  const funcIdx = segments.findIndex((s) => s.startsWith('_'));
  const meaningful = funcIdx >= 0 ? segments.slice(0, funcIdx) : segments;

  const bases: string[] = [];
  for (let i = meaningful.length; i >= 0; i--) {
    const path = meaningful.slice(0, i).join('/');
    bases.push(path ? `${origin}/${path}` : origin);
  }
  if (!meaningful.includes('tfs')) {
    const withTfs = meaningful.length
      ? `${origin}/tfs/${meaningful.join('/')}`
      : `${origin}/tfs/DefaultCollection`;
    bases.push(withTfs);
    if (meaningful.length > 1) bases.push(`${origin}/tfs/${meaningful[0]}`);
    bases.push(`${origin}/tfs`);
  }
  if (meaningful.length === 0) {
    bases.push(`${origin}/DefaultCollection`, `${origin}/tfs/DefaultCollection`);
  }
  return [...new Set(bases)];
}

const CASES: { input: string; mustContain: string; desc: string }[] = [
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
