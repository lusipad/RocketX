import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createWorkItemRequest,
  directCreateWorkItem,
  directGetBuild,
  directGetWorkItemHierarchy,
  directGetPullRequest,
  directGetPullRequests,
} from '../../apps/web/src/lib/adoDirect';
import { fetchPullRequest, parseAdoUrl } from '../../apps/web/src/lib/ado';
import {
  hierarchyPreview,
  loadLastWorkItemProject,
  preferredWorkItemProject,
  saveLastWorkItemProject,
  workItemTemplatesForTypes,
  type HierarchyLayout,
} from '../../apps/web/src/stores/wiTemplates';
import { pullRequestReviewSummary } from '../../apps/web/src/components/AdoEntityLink';
import { AdoClient } from '../../services/ado-bridge/src/ado';

(globalThis as Record<string, unknown>).React = React;

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  values.clear();
});

function adoJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('创建工作项使用真实类型名和 ADO JSON Patch 契约', async () => {
  const cfg = { adoBase: 'http://ado/tfs/DefaultCollection/', pat: '', auth: 'none' as const };
  const request = createWorkItemRequest(cfg, 'Road Map', 'Product Backlog Item', '修复 404', {
    tags: 'RocketX;Bug',
    iterationPath: 'Road Map\\Sprint 1',
    parentId: 17,
  });

  assert.equal(
    request.path,
    '/Road%20Map/_apis/wit/workitems/$Product%20Backlog%20Item?api-version=7.0',
  );
  assert.equal(request.contentType, 'application/json-patch+json');
  assert.deepEqual(request.body[0], {
    op: 'add',
    path: '/fields/System.Title',
    value: '修复 404',
  });
  assert.equal(
    request.body.find((op) => op.path === '/relations/-')?.value.url,
    'http://ado/tfs/DefaultCollection/_apis/wit/workitems/17',
  );

  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init };
    return adoJson({
      id: 21,
      fields: {
        'System.Title': '修复 404',
        'System.WorkItemType': 'Product Backlog Item',
        'System.State': 'New',
        'System.TeamProject': 'Road Map',
      },
    });
  }) as typeof fetch;

  const created = await directCreateWorkItem(
    cfg,
    'Road Map',
    'Product Backlog Item',
    '修复 404',
  );
  assert.equal(captured?.url, `http://ado/tfs/DefaultCollection${request.path}`);
  assert.equal(captured?.init?.method, 'POST');
  assert.equal(
    (captured?.init?.headers as Record<string, string>)['Content-Type'],
    'application/json-patch+json',
  );
  assert.equal(created.type, 'Product Backlog Item');
});

test('非 Agile 项目按服务器真实类型恢复层级模板，且不含 Epic 顶层（issue #65）', () => {
  const templates = [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }];
  const cases = [
    {
      name: 'Basic',
      types: ['Epic', 'Issue', 'Task'],
      hierarchy: ['Epic', 'Issue', 'Task'],
      expected: ['Issue', 'Task', 'Task'],
    },
    {
      name: 'Scrum',
      types: ['Epic', 'Feature', 'Product Backlog Item', 'Task'],
      hierarchy: ['Epic', 'Feature', 'Product Backlog Item', 'Task'],
      expected: ['Feature', 'Product Backlog Item', 'Task', 'Task'],
    },
    {
      name: 'CMMI',
      types: ['Epic', 'Feature', 'Requirement', 'Task'],
      hierarchy: ['Epic', 'Feature', 'Requirement', 'Task'],
      expected: ['Feature', 'Requirement', 'Task', 'Task'],
    },
    {
      name: '自定义',
      types: ['Initiative', 'Capability', 'Story', 'Task'],
      hierarchy: ['Initiative', 'Capability', 'Story', 'Task'],
      expected: ['Capability', 'Story', 'Task', 'Task'],
    },
    {
      name: '只有 Epic 和 Task 时保留原层级，级联不能退化成单项',
      types: ['Epic', 'Task'],
      hierarchy: ['Epic', 'Task'],
      expected: ['Epic', 'Task', 'Task'],
    },
  ];

  for (const item of cases) {
    const resolved = workItemTemplatesForTypes(templates, item.types, item.hierarchy);
    assert.equal(resolved[0]?.name, '层级工作项', item.name);
    assert.deepEqual(resolved[0]?.items.map((entry) => entry.type), item.expected, item.name);
    assert.ok(
      resolved[0]?.items.every((entry) => item.types.includes(entry.type)),
      `${item.name} 不得回退到项目不存在的硬编码类型`,
    );
  }
});

test('层级工作项四种形态:含不含 Feature 层 × 拆不拆开发测试(用户配置)', () => {
  const templates = [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }];
  const types = ['Epic', 'Feature', 'User Story', 'Task'];
  const hierarchy = ['Epic', 'Feature', 'User Story', 'Task'];

  const cases: { layout: HierarchyLayout; expected: string[]; preview: string }[] = [
    {
      layout: 'feature-split',
      expected: ['Feature', 'User Story', 'Task', 'Task'],
      preview: 'Feature → User Story → 【开发】Task + 【测试】Task',
    },
    {
      layout: 'feature-single',
      expected: ['Feature', 'User Story', 'Task'],
      preview: 'Feature → User Story → Task',
    },
    {
      layout: 'story-split',
      expected: ['User Story', 'Task', 'Task'],
      preview: 'User Story → 【开发】Task + 【测试】Task',
    },
    {
      layout: 'story-single',
      expected: ['User Story', 'Task'],
      preview: 'User Story → Task',
    },
  ];

  for (const item of cases) {
    const [auto] = workItemTemplatesForTypes(templates, types, hierarchy, item.layout);
    assert.equal(auto?.name, '层级工作项', item.layout);
    assert.deepEqual(auto?.items.map((entry) => entry.type), item.expected, item.layout);
    assert.equal(hierarchyPreview(auto!), item.preview, item.layout);
    // 单 Task 形态标题不带前缀,拆分形态两条都带
    const tasks = auto!.items.filter((entry) => entry.type === 'Task');
    if (item.layout.endsWith('split')) {
      assert.deepEqual(tasks.map((entry) => entry.title), ['【开发】{title}', '【测试】{title}'], item.layout);
    } else {
      assert.deepEqual(tasks.map((entry) => entry.title), ['{title}'], item.layout);
    }
    // 父子链完整:每一项(除根)都挂在前一层
    for (const [index, entry] of auto!.items.entries()) {
      if (index === 0) assert.equal(entry.parent, undefined, item.layout);
      else assert.ok(entry.parent !== undefined && entry.parent < index, item.layout);
    }
  }

  // 过程模板末级不是 Task 时,「仅故事层」退回完整层级(开关无意义不硬砍)
  const noTask = workItemTemplatesForTypes(
    templates,
    ['Feature', 'User Story'],
    ['Feature', 'User Story'],
    'story-split',
  );
  assert.deepEqual(noTask[0]?.items.map((entry) => entry.type), ['Feature', 'User Story']);
});

test('过程层级读取使用 Server 2022 API 并保留真实类型名', async () => {
  let requested = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return adoJson({
      portfolioBacklogs: [{ workItemTypes: [{ name: 'Initiative' }] }],
      requirementBacklog: { workItemTypes: [{ name: 'Story' }] },
      taskBacklog: { workItemTypes: [{ name: 'Task' }] },
    });
  }) as typeof fetch;

  const hierarchy = await directGetWorkItemHierarchy(
    { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' },
    'Road Map',
  );

  assert.equal(
    requested,
    'http://ado/tfs/DefaultCollection/Road%20Map/_apis/work/processconfiguration?api-version=7.0',
  );
  assert.deepEqual(hierarchy, ['Initiative', 'Story', 'Task']);
});

test('固定模板创建时保留服务器返回的精确类型名', () => {
  const resolved = workItemTemplatesForTypes(
    [{
      name: 'Feature 全套',
      items: [
        { type: 'Feature', title: '{title}' },
        { type: 'User Story', title: '{title}', parent: 0 },
        { type: 'Task', title: '{title}', parent: 1 },
      ],
    }],
    ['FEATURE', 'USER STORY', 'TASK'],
  );
  // 「层级工作项」恒排第一,自定义固定模板跟在后面——按名取再断言类型名精确保留
  const fixed = resolved.find((template) => template.name === 'Feature 全套');
  assert.deepEqual(fixed?.items.map((item) => item.type), ['FEATURE', 'USER STORY', 'TASK']);
});

test('创建工作项优先恢复上次项目，再回退配置默认值和首项', () => {
  const projects = ['Alpha', 'Beta', 'Gamma'];
  assert.equal(preferredWorkItemProject(projects, 'Gamma', 'Beta'), 'Gamma');
  assert.equal(preferredWorkItemProject(projects, 'Missing', 'Beta'), 'Beta');
  assert.equal(preferredWorkItemProject(projects, 'Missing', 'Other'), 'Alpha');

  saveLastWorkItemProject('HTTP://ado/tfs/DefaultCollection/', 'Gamma');
  assert.equal(loadLastWorkItemProject('http://ado/tfs/DefaultCollection'), 'Gamma');
});

test('我提的 PR 只请求活动状态', async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/_apis/connectionData')) {
      return adoJson({ authenticatedUser: { id: 'me', properties: {} } });
    }
    return adoJson({ value: [] });
  }) as typeof fetch;

  await directGetPullRequests({ adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' });

  const mine = requested.find((url) => url.includes('creatorId=me'));
  assert.match(mine ?? '', /searchCriteria\.status=active/);
  assert.doesNotMatch(mine ?? '', /status=all/);
});

test('PR 卡片摘要保留批准进度和必审组', () => {
  const summary = pullRequestReviewSummary({
    id: 7,
    title: '完善卡片',
    repo: 'RocketX',
    project: 'Road Map',
    creator: 'Alice',
    creatorUnique: 'alice',
    reviewers: [
      { name: 'Core Team', unique: 'core', vote: 10, isRequired: true, isContainer: true },
      { name: 'Bob', unique: 'bob', vote: 0, isRequired: true, isContainer: false },
    ],
    sourceBranch: 'feature/card',
    targetBranch: 'main',
    webUrl: 'http://ado/Road/_git/RocketX/pullrequest/7',
  });
  assert.deepEqual(summary, {
    voted: 1,
    approved: 1,
    rejected: 0,
    total: 2,
    requiredGroups: ['Core Team'],
  });
});

test('只把当前 ADO 集合的工作项、PR 和构建 URL 识别为卡片', () => {
  const base = 'http://ado/tfs/DefaultCollection';
  assert.deepEqual(
    parseAdoUrl(`${base}/Road%20Map/_git/Rocket%20X/pullrequest/42`, base),
    {
      kind: 'pullrequest',
      id: 42,
      href: `${base}/Road%20Map/_git/Rocket%20X/pullrequest/42`,
    },
  );
  assert.deepEqual(
    parseAdoUrl(`${base}/_git/Rocket%20X/pullrequest/43?discussionId=5`, base),
    {
      kind: 'pullrequest',
      id: 43,
      href: `${base}/_git/Rocket%20X/pullrequest/43?discussionId=5`,
    },
  );
  assert.deepEqual(
    parseAdoUrl(`${base}/Road%20Map/_build/results?buildId=88&view=results`, base),
    {
      kind: 'build',
      project: 'Road Map',
      id: 88,
      href: `${base}/Road%20Map/_build/results?buildId=88&view=results`,
    },
  );
  assert.equal(parseAdoUrl(`${base}/Road/_workitems/edit/9`, base)?.kind, 'workitem');
  assert.equal(parseAdoUrl(`${base}/Road/_git/Repo/commit/abcdef`, base), null);
  assert.equal(parseAdoUrl(`${base}/Road/_release?releaseId=3`, base), null);
  assert.equal(parseAdoUrl('http://ado/tfs/DefaultCollection-evil/Road/_workitems/edit/9', base), null);
});

test('Markdown 中独立 PR 与构建 URL 渲染为卡片占位，未知 ADO URL 保持普通链接', async () => {
  const base = 'http://ado/tfs/DefaultCollection';
  values.set('rcx-ado-web', base);
  const { isPureAdoEntityText, renderMarkdown } = await import('../../apps/web/src/lib/markdown');
  const html = (value: string) => renderToStaticMarkup(renderMarkdown(value) as React.ReactElement);
  const pr = `${base}/Road/_git/RocketX/pullrequest/42`;
  const build = `${base}/Road/_build/results?buildId=88`;
  const commit = `${base}/Road/_git/RocketX/commit/abcdef`;

  assert.equal(isPureAdoEntityText(pr), true);
  assert.equal(isPureAdoEntityText(build), true);
  assert.match(html(pr), /PR !42 加载中/);
  assert.match(html(build), /构建 #88 加载中/);
  assert.doesNotMatch(html(commit), /加载中/);
  assert.match(html(commit), /<a /);
});

test('PR 使用集合级详情接口，构建保持项目作用域', async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/pullrequests/42')) {
      return adoJson({
        pullRequestId: 42,
        title: '修复链接卡片',
        repository: { name: 'Rocket X', project: { name: 'Road Map' } },
        createdBy: { displayName: 'Alice', uniqueName: 'alice' },
        reviewers: [],
        sourceRefName: 'refs/heads/fix/card',
        targetRefName: 'refs/heads/main',
      });
    }
    return adoJson({
      id: 88,
      buildNumber: '20260715.1',
      definition: { name: 'RocketX CI' },
      project: { name: 'Road Map' },
      status: 'completed',
      result: 'succeeded',
    });
  }) as typeof fetch;

  const directCfg = { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' as const };
  const directPr = await directGetPullRequest(directCfg, 42);
  const directBuild = await directGetBuild(directCfg, 'Road Map', 88);
  const bridge = new AdoClient({ baseUrl: directCfg.adoBase, pat: '' });
  const bridgePr = await bridge.getPullRequest(42);
  const bridgeBuild = await bridge.getBuild('Road Map', 88);

  assert.equal(directPr.webUrl, bridgePr.webUrl);
  assert.equal(directBuild.webUrl, bridgeBuild.webUrl);
  assert.equal(
    requested.filter((url) => url.includes('/_apis/git/pullrequests/42')).length,
    2,
  );
  assert.equal(
    requested.filter((url) => url.includes('/Road%20Map/_apis/build/builds/88')).length,
    2,
  );
});

test('Web bridge 的 PR 卡片请求不依赖 URL 中的项目或仓库名', async () => {
  values.set('rcx-workbench', JSON.stringify({
    mode: 'bridge',
    bridge: 'http://bridge.example',
    account: 'alice',
  }));
  let requested = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return adoJson({
      item: {
        id: 77,
        title: '集合根链接',
        repo: 'RocketX',
        project: 'Road Map',
        creator: 'Alice',
        creatorUnique: 'alice',
        reviewers: [],
        sourceBranch: 'fix/card',
        targetBranch: 'main',
        webUrl: 'http://ado/tfs/DefaultCollection/_git/RocketX/pullrequest/77',
      },
    });
  }) as typeof fetch;

  const item = await fetchPullRequest(77);

  assert.equal(requested, 'http://bridge.example/api/ado/pullrequest/77');
  assert.equal(item?.id, 77);
});
