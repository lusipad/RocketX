import assert from 'node:assert/strict';
import test from 'node:test';
import { butlerStepLabel, butlerToolLabel } from '../../apps/web/src/lib/butlerToolLabels';

test('工具标签：白名单内的参数进摘要，白名单外一律不显示', () => {
  // 无参数时必须原样返回纯标签——既有回归逐字断言「搜索消息」这类值
  assert.equal(butlerStepLabel('search_messages'), '搜索消息');
  assert.equal(butlerStepLabel('search_messages', '{}'), '搜索消息');
  assert.equal(butlerStepLabel('list_todos', '{"query":"发布"}'), '查询待办');

  assert.equal(butlerStepLabel('search_messages', '{"query":"发布失败"}'), '搜索消息（发布失败）');
  assert.equal(
    butlerStepLabel('list_pull_requests', '{"project":"商城","repo":"payments"}'),
    '查询拉取请求（商城 · payments）',
  );
});

test('ADO CLI 只暴露 resource，绝不显示查询参数或内网地址', () => {
  const label = butlerStepLabel(
    'run_azure_devops_server_cli',
    JSON.stringify({
      area: 'git',
      resource: 'pullrequests/101',
      project: '商城',
      query: { collectionUrl: 'https://ado-internal/tfs/DefaultCollection', pat: 'secret-token' },
    }),
  );
  assert.equal(label, '运行 Azure DevOps 只读 CLI（pullrequests/101）');
  assert.doesNotMatch(label, /ado-internal|secret-token|DefaultCollection/);
});

test('过长参数截断，坏 JSON 与未知工具优雅降级', () => {
  const long = butlerStepLabel('search_messages', JSON.stringify({ query: '很长的关键词'.repeat(10) }));
  assert.match(long, /…）$/);
  assert.ok(long.length < 60);

  assert.equal(butlerStepLabel('search_messages', '不是 JSON'), '搜索消息');
  assert.equal(butlerStepLabel('search_messages', '[1,2]'), '搜索消息');
  assert.equal(butlerToolLabel('unknown_tool'), 'unknown_tool');
  assert.equal(butlerStepLabel('unknown_tool', '{"query":"x"}'), 'unknown_tool');
});
