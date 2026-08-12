import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildContributionWeeks,
  contributionLevel,
} from '../../apps/web/src/components/ContributionHeatmap';
import type { ContributionEvent } from '../../apps/web/src/lib/adoContributions';
import { useProfileContributions } from '../../apps/web/src/stores/profileContributions';

test('贡献日历按周补齐边界，并把本地日期事件放入对应格子', () => {
  const events: ContributionEvent[] = [
    {
      id: 'pr:1',
      type: 'pull-request',
      occurredAt: '2026-08-10T23:30:00Z',
      day: '2026-08-11',
      project: 'Alpha',
      repository: 'RocketX',
      title: '修复本地日期分桶',
      url: 'https://ado.example/pullrequest/1',
    },
  ];
  const weeks = buildContributionWeeks({ from: '2026-08-10', to: '2026-08-12' }, events);

  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].length, 7);
  assert.equal(weeks[0][0].day, '2026-08-09');
  assert.equal(weeks[0].find((day) => day.day === '2026-08-11')?.count, 1);
  assert.equal(weeks[0][0].inRange, false);
});

test('贡献强度固定为 0 到 4 级', () => {
  assert.equal(contributionLevel(0, 8), 0);
  assert.equal(contributionLevel(1, 8), 1);
  assert.equal(contributionLevel(4, 8), 2);
  assert.equal(contributionLevel(8, 8), 4);
  assert.equal(contributionLevel(80, 8), 4);
});

test('贡献筛选只保留项目维度', () => {
  useProfileContributions.setState({ filters: { project: 'Alpha' } });
  useProfileContributions.getState().setFilters({ project: 'Beta' });
  assert.deepEqual(useProfileContributions.getState().filters, { project: 'Beta' });
  useProfileContributions.getState().setFilters({ project: undefined });
  assert.deepEqual(useProfileContributions.getState().filters, { project: undefined });
});

test('我的贡献归入工作台，并保留键盘格子、覆盖警告与中性文案合同', async () => {
  const [runtime, nav, workbench, heatmap, page] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/WorkbenchPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ContributionHeatmap.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/ProfileContributionsPage.tsx', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(runtime, /ProfileContributionsModule|\['contributions'/);
  assert.doesNotMatch(nav, /contributions: \{ label:/);
  assert.match(workbench, /label: '我的贡献'/);
  assert.match(workbench, /tab === 'contributions'[\s\S]*<ProfileContributionsPage \/>/);
  assert.match(workbench, /tab === 'contributions'\) return;[\s\S]*void refresh\(\)/);
  assert.match(page, /aria-label="我的贡献"/);
  assert.match(heatmap, /<button[\s\S]*aria-label=\{label\}[\s\S]*aria-pressed=\{selectedDay === day\.day\}[\s\S]*title=\{label\}/);
  assert.match(heatmap, /className="w-full rounded-xl/);
  assert.doesNotMatch(heatmap, /w-fit/);
  assert.match(heatmap, /mx-auto w-max[\s\S]*aria-label="贡献强度图例"/);
  assert.match(page, /数据覆盖说明/);
  assert.match(page, /仅部分覆盖/);
  assert.match(page, /status\.state === 'partial' && status\.count > 0/);
  assert.match(page, /\? `≥\$\{status\.count\}`[\s\S]*: '—'/);
  assert.match(page, /hasIncompleteCoverage \? '已读取的 ADO PR'/);
  assert.match(page, /正在统计 Azure DevOps PR/);
  assert.doesNotMatch(page, />仓库</);
  assert.doesNotMatch(page, />活动类型</);
  assert.match(page, /取消加载/);
  assert.match(page, /load\(\{ force: true \}\)/);
  assert.match(page, /const AUTO_LOAD_DELAY_MS = 200/);
  assert.match(page, /setTimeout\(\(\) => void load\(\), AUTO_LOAD_DELAY_MS\)/);
  assert.doesNotMatch(page, /排名|绩效|排行榜/);
});
