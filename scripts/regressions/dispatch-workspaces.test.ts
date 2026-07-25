import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRegisteredWorkspace,
  dispatchWorkspaceLabel,
  resolveDispatchTargets,
} from '../../apps/web/src/lib/dispatchWorkspaces';
import type { LocalAgentEnvironment } from '../../apps/web/src/stores/agentEnvironments';

function environment(
  id: string,
  name: string,
  path: string,
  overrides: Partial<LocalAgentEnvironment> = {},
): LocalAgentEnvironment {
  return {
    id,
    name,
    path,
    adoProjects: [],
    defaultBaseBranch: 'main',
    branchPrefix: 'ai/',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('默认目标是上次用过的那个：常见路径一次点击就能派出去', () => {
  const environments = [
    environment('env-a', 'RocketX', 'D:/Repos/rocketchatx', { updatedAt: 10 }),
    environment('env-b', '内网工具', 'D:/Repos/intranet', { updatedAt: 20 }),
  ];
  const { options, defaultId } = resolveDispatchTargets(environments, undefined, 'env-a');
  assert.equal(defaultId, 'env-a', '记住的目标优先于排序结果');
  // 列表本身按最近更新排序
  assert.deepEqual(options.map((item) => item.id), ['env-b', 'env-a']);
});

test('没有记忆时用模型建议排序，但建议永远不能造出新目标', () => {
  const environments = [
    environment('env-a', 'RocketX', 'D:/Repos/rocketchatx', { updatedAt: 10 }),
    environment('env-b', '内网工具', 'D:/Repos/intranet', { updatedAt: 20 }),
  ];
  assert.equal(resolveDispatchTargets(environments, undefined, undefined, 'rocketx').defaultId, 'env-a');
  // 建议匹配不上就退回第一个，不会凭空多出候选
  const missed = resolveDispatchTargets(environments, undefined, undefined, '某个不存在的项目');
  assert.equal(missed.defaultId, 'env-b');
  assert.equal(missed.options.length, 2);
});

test('零配置：注册表为空时用执行间已选目录合成临时候选，选中才落库', () => {
  const { options, defaultId } = resolveDispatchTargets([], 'D:/Repos/rocketchatx', undefined);
  assert.equal(options.length, 1);
  assert.equal(options[0].pending, true);
  assert.equal(options[0].id, undefined);
  assert.match(options[0].name, /rocketchatx/);
  assert.equal(defaultId, undefined, '临时候选还没有 id');
  assert.match(dispatchWorkspaceLabel(options[0]), /首次使用会记住/);

  // 注册表非空时不再合成临时候选
  const registered = resolveDispatchTargets(
    [environment('env-a', 'RocketX', 'D:/Repos/rocketchatx')],
    'D:/Other/path',
    undefined,
  );
  assert.equal(registered.options.length, 1);
  assert.equal(registered.options[0].pending, undefined);
});

test('停用与空路径的工作区不进候选；两者都为空时列表为空', () => {
  const environments = [
    environment('env-a', '停用的', 'D:/Repos/a', { enabled: false }),
    environment('env-b', '空路径', '   '),
  ];
  const { options, defaultId } = resolveDispatchTargets(environments, undefined, undefined);
  assert.deepEqual(options, []);
  assert.equal(defaultId, undefined);
});

test('注册表就是白名单：未注册、已停用、空路径一律拒绝派发', () => {
  const environments = [
    environment('env-a', 'RocketX', 'D:/Repos/rocketchatx'),
    environment('env-off', '停用的', 'D:/Repos/off', { enabled: false }),
    environment('env-empty', '空的', '  '),
  ];
  assert.equal(assertRegisteredWorkspace('env-a', environments).path, 'D:/Repos/rocketchatx');

  // 模型编造的 id、临时候选（无 id）、停用与空路径都必须抛
  assert.throws(() => assertRegisteredWorkspace('env-does-not-exist', environments), /已添加的工作区/);
  assert.throws(() => assertRegisteredWorkspace(undefined, environments), /已添加的工作区/);
  assert.throws(() => assertRegisteredWorkspace('env-off', environments), /已停用/);
  assert.throws(() => assertRegisteredWorkspace('env-empty', environments), /没有有效路径/);
});

test('名字缺省时用文件夹名，Windows 与 POSIX 分隔符都认', () => {
  const windows = resolveDispatchTargets([environment('env-a', '   ', 'D:\\Repos\\rocketchatx\\')], undefined, undefined);
  assert.equal(windows.options[0].name, 'rocketchatx');
  const posix = resolveDispatchTargets([], '/home/lus/projects/intranet', undefined);
  assert.match(posix.options[0].name, /intranet/);
});
