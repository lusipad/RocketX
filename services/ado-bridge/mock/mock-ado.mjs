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

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname.endsWith('/_apis/wit/wiql')) {
    send({ workItems: WORK_ITEMS.map((w) => ({ id: w.id })) });
  } else if (url.pathname.endsWith('/_apis/wit/workitems')) {
    const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number);
    send({ value: WORK_ITEMS.filter((w) => ids.includes(w.id)) });
  } else if (url.pathname.endsWith('/_apis/git/pullrequests')) {
    send({ value: PULL_REQUESTS });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `mock: 未实现 ${url.pathname}` }));
  }
}).listen(PORT, () => console.log(`mock ADO server: http://localhost:${PORT}/DefaultCollection`));
