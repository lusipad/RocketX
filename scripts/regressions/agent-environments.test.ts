import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentRoomSessionKey,
  environmentIsBusy,
  proposedAgentBranch,
  selectEnvironmentForProject,
  type LocalAgentEnvironment,
  type WorkItemDiscussionBinding,
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
