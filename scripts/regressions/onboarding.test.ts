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
  describeLoginFailure,
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
  assert.equal(classifyLoginFailure(new Error('unreachable')), 'unreachable');
  assert.equal(classifyLoginFailure(new Error('unreadable')), 'unreachable');
  assert.equal(classifyLoginFailure(new Error('getaddrinfo ENOTFOUND chat.example.com')), 'dns');
  assert.equal(classifyLoginFailure(new Error('certificate verify failed for https://u:p@example.com')), 'tls');
  assert.equal(classifyLoginFailure(new Error('proxy connect aborted with status 407')), 'proxy');
  assert.equal(classifyLoginFailure(new Error('request timed out after 30s')), 'timeout');
  assert.equal(classifyLoginFailure(new Error('URL not allowed by remote scope')), 'scope');
  assert.equal(classifyLoginFailure(new Error('HTTP 502')), 'http_status');
  assert.equal(classifyLoginFailure(new Error('HTTP 404')), 'not_rocket_chat');
  assert.equal(classifyLoginFailure(new Error('Unauthorized')), 'credentials');
  assert.equal(classifyLoginFailure(new Error('session expired')), 'session_expired');
  assert.match(loginFailureMessage(new Error('HTTP 404')), /Rocket.Chat/);
});

test('登录失败描述保留阶段、友好主文案与脱敏细节', () => {
  const failure = describeLoginFailure(
    new Error('certificate verify failed for https://admin:secret@example.com/api/v1/login?token=abc'),
    'probe',
  );
  assert.equal(failure.stage, 'probe');
  assert.equal(failure.kind, 'tls');
  assert.match(failure.summary, /检查服务器|证书/i);
  assert.match(failure.detail ?? '', /证书|TLS/i);
  assert.doesNotMatch(failure.detail ?? '', /secret|token=abc/i);
  assert.match(failure.detail ?? '', /\[REDACTED\]/);
});

test('未知登录错误不再直接回显裸英文', () => {
  const failure = describeLoginFailure(new Error('opaque backend explosion'), 'login');
  assert.equal(failure.kind, 'unknown');
  assert.match(failure.summary, /登录失败/);
  assert.match(failure.detail ?? '', /opaque backend explosion/);

  const unreadable = describeLoginFailure(new Error('unreadable'), 'login');
  assert.equal(unreadable.kind, 'unreachable');
  assert.doesNotMatch(`${unreadable.summary} ${unreadable.detail}`, /unreadable/i);
  assert.match(unreadable.detail ?? '', /代理|网关|证书/);
});
