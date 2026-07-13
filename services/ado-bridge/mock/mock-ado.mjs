// Azure DevOps Server 2022 REST API 的最小 mock，用于本地联调工作台
// 用法: node mock/mock-ado.mjs  （默认端口 8378）
import { createServer } from 'node:http';

const PORT = process.env.MOCK_ADO_PORT ?? 8378;

const WORK_ITEMS = [
  {
    id: 128,
    fields: {
      'System.Title': '登录页在 IE11 下白屏',
      'System.WorkItemType': 'Bug',
      'System.State': 'Active',
      'System.TeamProject': 'RocketX',
      'System.AssignedTo': { displayName: 'lus', uniqueName: 'lus@example.com' },
      'System.ChangedDate': '2026-07-12T10:00:00Z',
      'Microsoft.VSTS.Common.Priority': 1,
    },
  },
  {
    id: 131,
    fields: {
      'System.Title': '工作台面板支持自定义布局',
      'System.WorkItemType': 'User Story',
      'System.State': 'New',
      'System.TeamProject': 'RocketX',
      'System.AssignedTo': { displayName: 'lus', uniqueName: 'lus@example.com' },
      'System.ChangedDate': '2026-07-11T08:00:00Z',
      'Microsoft.VSTS.Common.Priority': 2,
    },
  },
  {
    id: 135,
    fields: {
      'System.Title': '升级 Rocket.Chat 到 8.7 做兼容性验证',
      'System.WorkItemType': 'Task',
      'System.State': 'Active',
      'System.TeamProject': 'Platform',
      'System.AssignedTo': { displayName: 'lus', uniqueName: 'lus@example.com' },
      'System.ChangedDate': '2026-07-10T02:00:00Z',
      'Microsoft.VSTS.Common.Priority': 3,
    },
  },
];

const PULL_REQUESTS = [
  {
    pullRequestId: 42,
    title: '修复登录超时问题',
    creationDate: '2026-07-12T09:00:00Z',
    createdBy: { displayName: '张三', uniqueName: 'zhangsan@example.com' },
    reviewers: [{ displayName: 'lus', uniqueName: 'lus@example.com', vote: 0 }],
    sourceRefName: 'refs/heads/fix/login-timeout',
    targetRefName: 'refs/heads/main',
    repository: { name: 'rocketx', project: { name: 'RocketX' } },
  },
  {
    pullRequestId: 45,
    title: 'feat: 工作台 ADO 集成',
    creationDate: '2026-07-13T01:00:00Z',
    createdBy: { displayName: 'lus', uniqueName: 'lus@example.com' },
    reviewers: [{ displayName: '张三', uniqueName: 'zhangsan@example.com', vote: 10 }],
    sourceRefName: 'refs/heads/feat/workbench',
    targetRefName: 'refs/heads/main',
    repository: { name: 'rocketx', project: { name: 'RocketX' } },
  },
];

const BUILDS = [
  {
    id: 501,
    buildNumber: '20260713.2',
    definition: { name: 'rocketx-ci' },
    project: { name: 'RocketX' },
    status: 'completed',
    result: 'succeeded',
    requestedFor: { displayName: 'lus' },
    queueTime: '2026-07-13T02:40:00Z',
    finishTime: '2026-07-13T02:47:00Z',
  },
  {
    id: 502,
    buildNumber: '20260713.3',
    definition: { name: 'rocketx-desktop' },
    project: { name: 'RocketX' },
    status: 'inProgress',
    result: '',
    requestedFor: { displayName: '张三' },
    queueTime: '2026-07-13T03:30:00Z',
    finishTime: '',
  },
  {
    id: 498,
    buildNumber: '20260712.9',
    definition: { name: 'platform-nightly' },
    project: { name: 'Platform' },
    status: 'completed',
    result: 'failed',
    requestedFor: { displayName: 'lus' },
    queueTime: '2026-07-12T20:00:00Z',
    finishTime: '2026-07-12T20:12:00Z',
  },
];

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // CORS：让网页端也能直连本 mock（真实 ADO Server 通常不发跨域头，网页端需用桥接）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const send = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname.endsWith('/_apis/wit/wiql')) {
    send({ workItems: WORK_ITEMS.map((w) => ({ id: w.id })) });
  } else if (url.pathname.endsWith('/_apis/wit/workitems')) {
    const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number);
    send({ value: WORK_ITEMS.filter((w) => ids.includes(w.id)) });
  } else if (/\/_apis\/wit\/workitems\/\d+$/.test(url.pathname) && req.method === 'PATCH') {
    // 评论（System.History patch）
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`mock: 收到工作项评论 ${url.pathname}:`, body.slice(0, 200));
      send({ id: Number(url.pathname.split('/').pop()), fields: {} });
    });
  } else if (url.pathname.endsWith('/_apis/projects')) {
    send({ value: [{ name: 'RocketX' }, { name: 'Platform' }] });
  } else if (url.pathname.endsWith('/_apis/build/builds')) {
    const project = decodeURIComponent(url.pathname.split('/_apis/')[0].split('/').pop() ?? '');
    send({ value: BUILDS.filter((b) => b.project.name === project) });
  } else if (url.pathname.endsWith('/_apis/git/pullrequests')) {
    send({ value: PULL_REQUESTS });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `mock: 未实现 ${url.pathname}` }));
  }
}).listen(PORT, () => console.log(`mock ADO server: http://localhost:${PORT}/DefaultCollection`));
