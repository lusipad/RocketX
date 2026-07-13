/**
 * 对着真实的 Azure DevOps 跑一遍工作台链路：自动探测 + 工作项 / PR / 构建查询。
 * 凭据只从环境变量读，不落盘、不打印。
 *
 *   ADO_BASE_URL=https://dev.azure.com/org ADO_PAT=xxx ADO_ACCOUNT=you@corp.com \
 *   pnpm test:ado
 *
 * ADO_BASE_URL 可以直接粘项目页/工作项页的地址，探测会自己往上找集合根。
 */
import {
  candidateBases,
  directGetBuilds,
  directGetPullRequests,
  directGetWorkItems,
  probeAdo,
  type ProbeStep,
} from '../apps/web/src/lib/adoDirect';

const BASE = process.env.ADO_BASE_URL ?? '';
const PAT = process.env.ADO_PAT ?? '';
const ACCOUNT = process.env.ADO_ACCOUNT ?? '';

function mask(s: string): string {
  return s ? `${s.slice(0, 4)}…（${s.length} 位）` : '(空)';
}

async function main(): Promise<void> {
  if (!BASE) {
    console.error('缺少 ADO_BASE_URL');
    process.exit(1);
  }

  console.log('\n[配置]');
  console.log(`  地址：${BASE}`);
  console.log(`  PAT ：${mask(PAT)}`);
  console.log(`  账号：${ACCOUNT || '(未设置，工作项查询会跳过)'}`);

  console.log('\n[候选集合根]（从你给的地址逐级往上推）');
  for (const b of candidateBases(BASE)) console.log(`  - ${b}`);

  console.log('\n[自动探测]');
  const result = await probeAdo(BASE, PAT, (s: ProbeStep) => {
    console.log(`  ${s.ok ? '✓' : '✗'} [${s.auth}] ${s.url}\n      ${s.detail ?? ''}`);
  });
  const found = result.found;

  if (!found) {
    console.log('\n✗ 探测失败：以上组合都没通。');
    console.log('  常见原因：地址不是集合根、PAT 权限不足（需要 Work Items / Code / Build 读取）、');
    console.log('  或服务器只认 Windows 集成认证（那种情况下浏览器/桌面端能通，Node 里不行）。');
    process.exit(1);
  }

  console.log(`\n✓ 探测成功：${found.adoBase}（认证方式：${found.auth}）`);
  console.log(`  可见 ${found.projects.length} 个项目：${found.projects.join('、')}`);

  const cfg = { adoBase: found.adoBase, pat: PAT, auth: found.auth };

  if (ACCOUNT) {
    console.log('\n[我的工作项]');
    try {
      const items = await directGetWorkItems(cfg, ACCOUNT);
      console.log(`  共 ${items.length} 条未关闭`);
      for (const w of items.slice(0, 8)) {
        console.log(
          `  #${w.id} [${w.type}/${w.state}${w.priority ? `/P${w.priority}` : ''}] ${w.title} — ${w.assignedTo ?? '未分配'} @ ${w.project}`,
        );
      }
    } catch (err) {
      console.log(`  ✗ 失败：${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('\n[进行中的 PR]');
  try {
    const prs = await directGetPullRequests(cfg);
    console.log(`  共 ${prs.length} 个`);
    for (const pr of prs.slice(0, 8)) {
      const votes = pr.reviewers.map((r) => `${r.name}:${r.vote}`).join(' ') || '无评审人';
      console.log(
        `  !${pr.id} ${pr.title} — ${pr.repo} ${pr.sourceBranch}→${pr.targetBranch} by ${pr.creator} [${votes}]`,
      );
    }
  } catch (err) {
    console.log(`  ✗ 失败：${err instanceof Error ? err.message : err}`);
  }

  console.log('\n[最近构建]');
  try {
    const builds = await directGetBuilds(cfg);
    console.log(`  共 ${builds.length} 条`);
    for (const b of builds.slice(0, 8)) {
      console.log(
        `  ${b.definition} ${b.buildNumber} [${b.status}/${b.result || '进行中'}] — ${b.requestedFor} @ ${b.project}`,
      );
    }
  } catch (err) {
    console.log(`  ✗ 失败：${err instanceof Error ? err.message : err}`);
  }

  console.log('');
}

void main();
