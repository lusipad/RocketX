import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checklistComplete,
  defaultOnboardingState,
  onboardingStorageKey,
  parseOnboardingState,
  skipChecklist,
  updateChecklist,
} from '../../apps/web/src/lib/onboarding';
import {
  classifyLoginFailure,
  loginFailureMessage,
} from '../../apps/web/src/lib/loginDiagnostic';

test('引导状态按服务器和用户隔离，并规范化地址', () => {
  const first = onboardingStorageKey('HTTPS://CHAT.EXAMPLE.COM/', 'user-a');
  assert.equal(first, onboardingStorageKey('https://chat.example.com', 'user-a'));
  assert.notEqual(first, onboardingStorageKey('https://chat.example.com', 'user-b'));
  assert.notEqual(first, onboardingStorageKey('https://chat-2.example.com', 'user-a'));
});

test('已有有效 ADO 配置时不强制重复第二步', () => {
  assert.equal(
    defaultOnboardingState({ adoBase: 'http://ado/tfs/c', account: '' }).ado,
    'configured',
  );
  assert.equal(defaultOnboardingState(null).ado, 'pending');
});

test('损坏或旧版引导状态安全回退，合法状态补齐布尔字段', () => {
  assert.equal(parseOnboardingState('{broken'), null);
  assert.equal(parseOnboardingState(JSON.stringify({ version: 2, ado: 'skipped', checklist: {} })), null);
  assert.deepEqual(
    parseOnboardingState(JSON.stringify({ version: 1, ado: 'skipped', checklist: {} })),
    {
      version: 1,
      ado: 'skipped',
      checklist: {
        startedConversation: false,
        sentMessage: false,
        notificationsEnabled: false,
        dismissed: false,
      },
    },
  );
});

test('首用清单只在三个真实完成点均成功后结束', () => {
  let state = defaultOnboardingState(null);
  state = updateChecklist(state, 'startedConversation');
  state = updateChecklist(state, 'sentMessage');
  assert.equal(checklistComplete(state), false);
  state = updateChecklist(state, 'notificationsEnabled');
  assert.equal(checklistComplete(state), true);
});

test('跳过首用清单会持久标记不再提醒且保持幂等', () => {
  const state = defaultOnboardingState(null);
  const skipped = skipChecklist(state);
  assert.equal(skipped.checklist.dismissed, true);
  assert.equal(skipChecklist(skipped), skipped);
});

test('登录失败能区分地址、网络、服务类型、凭据和会话失效', () => {
  assert.equal(classifyLoginFailure(new Error('invalid_address')), 'invalid_address');
  assert.equal(classifyLoginFailure(new Error('Failed to fetch')), 'unreachable');
  assert.equal(classifyLoginFailure(new Error('HTTP 404')), 'not_rocket_chat');
  assert.equal(classifyLoginFailure(new Error('Unauthorized')), 'credentials');
  assert.equal(classifyLoginFailure(new Error('session expired')), 'session_expired');
  assert.match(loginFailureMessage(new Error('HTTP 404')), /Rocket.Chat/);
});
