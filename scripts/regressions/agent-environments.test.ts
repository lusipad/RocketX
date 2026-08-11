import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentRoomSessionKey,
  environmentIsBusy,
  findEnvironmentByPath,
  normalizeEnvironmentPath,
  proposedAgentBranch,
  selectEnvironmentForProject,
  type LocalAgentEnvironment,
  type WorkItemDiscussionBinding,
  useAgentEnvironments,
} from '../../apps/web/src/stores/agentEnvironments';

function environment(id: string, project: string): LocalAgentEnvironment {
  return {
    id,
    name: id,
    path: `D:/Repos/${id}`,
    adoProjects: [project],
    defaultBaseBranch: 'main',
    branchPrefix: 'ai/',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function binding(environmentId: string, discussionRid = 'discussion-a'): WorkItemDiscussionBinding {
  return {
    id: `binding-${environmentId}`,
    serverId: 'https://chat.example',
    workItemId: 128,
    adoProject: 'RocketChatX',
    workItemTitle: 'Login failure',
    parentRid: 'engineering',
    discussionRid,
    sessionKey: agentRoomSessionKey(discussionRid),
    environmentId,
    hostDeviceId: 'device-a',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

test('同一目录只能被一个活动讨论占用，结束绑定后释放', () => {
  assert.equal(environmentIsBusy('env-a', [binding('env-a')]), true);
  assert.equal(environmentIsBusy('env-a', [{ ...binding('env-a'), status: 'ended' }]), false);
  assert.equal(environmentIsBusy('env-a', [binding('env-a')], 'discussion-a'), false);
});

test('默认环境优先使用项目上次选择，其次项目映射，并跳过忙碌目录', () => {
  const environments = [environment('env-a', 'RocketChatX'), environment('env-b', 'RocketChatX')];
  assert.equal(selectEnvironmentForProject(environments, [], 'rocketchatx', { rocketchatx: 'env-b' })?.id, 'env-b');
  assert.equal(
    selectEnvironmentForProject(environments, [binding('env-b')], 'RocketChatX', { rocketchatx: 'env-b' })?.id,
    'env-a',
  );
});

test('Discussion 会话键和 AI 分支名稳定且不泄露标题中的特殊字符', () => {
  assert.equal(agentRoomSessionKey('room-128'), 'room:room-128');
  assert.equal(proposedAgentBranch('ai', 128, 'Login failure!'), 'ai/128-login-failure');
  assert.equal(proposedAgentBranch('feature/', 9, '登录失败'), 'feature/9-task');
});

test('Windows 盘符和 UNC 目录使用不区分大小写的路径身份', () => {
  assert.equal(normalizeEnvironmentPath('D:\\Repos\\RocketX\\'), 'd:/repos/rocketx');
  assert.equal(normalizeEnvironmentPath('\\\\SERVER\\Share\\RocketX'), '//server/share/rocketx');
  assert.equal(normalizeEnvironmentPath('/opt/RocketX'), '/opt/RocketX');
});

test('忙碌项目可改显示元数据，但不能改目录或启停状态', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: () => undefined },
  });
  const snapshot = useAgentEnvironments.getState();
  useAgentEnvironments.setState({
    version: 1,
    environments: [environment('env-busy', 'RocketChatX')],
    bindings: [binding('env-busy')],
    lastEnvironmentByProject: {},
    lastDispatchEnvironmentId: undefined,
  });

  try {
    useAgentEnvironments.getState().updateEnvironment('env-busy', { name: '忙碌项目' });
    assert.equal(useAgentEnvironments.getState().environments[0]?.name, '忙碌项目');
    assert.throws(
      () => useAgentEnvironments.getState().updateEnvironment('env-busy', { enabled: false }),
      /不能修改目录或启停状态/,
    );
    assert.throws(
      () => useAgentEnvironments.getState().updateEnvironment('env-busy', { path: 'D:/Repos/other' }),
      /不能修改目录或启停状态/,
    );
  } finally {
    useAgentEnvironments.setState(snapshot);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('旧 workspaceRoots 导入 environment 时会去重，并保留已有项目元数据', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });

  const snapshot = useAgentEnvironments.getState();
  useAgentEnvironments.setState({
    version: 1,
    environments: [{
      ...environment('env-existing', 'RocketChatX'),
      name: '已有项目',
      path: 'D:/Repos/rocketchatx',
    }],
    bindings: [],
    lastEnvironmentByProject: {},
    lastDispatchEnvironmentId: undefined,
  });

  try {
    const imported = useAgentEnvironments.getState().importLegacyWorkspaceRoots([
      'D:/Repos/rocketchatx',
      'D:/Repos/new-project',
    ]);
    assert.equal(imported.environments.length, 2);
    assert.equal(imported.persisted, true);
    assert.equal(findEnvironmentByPath(useAgentEnvironments.getState().environments, 'D:/Repos/rocketchatx')?.name, '已有项目');
    assert.equal(findEnvironmentByPath(useAgentEnvironments.getState().environments, 'D:/Repos/new-project')?.name, 'new-project');
    assert.equal(useAgentEnvironments.getState().environments.length, 2);
  } finally {
    useAgentEnvironments.setState(snapshot);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('旧目录目标持久化失败时会明确返回失败，供迁移方保留旧来源', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      setItem: () => { throw new Error('quota exceeded'); },
    },
  });
  const snapshot = useAgentEnvironments.getState();
  useAgentEnvironments.setState({
    version: 1,
    environments: [],
    bindings: [],
    lastEnvironmentByProject: {},
    lastDispatchEnvironmentId: undefined,
  });

  try {
    const imported = useAgentEnvironments.getState().importLegacyWorkspaceRoots(['D:/Repos/legacy']);
    assert.equal(imported.persisted, false);
    assert.equal(imported.environments[0]?.path, 'D:/Repos/legacy');
  } finally {
    useAgentEnvironments.setState(snapshot);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
