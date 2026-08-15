import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  codexNewThreadDeepLink,
  codexSurfaceDeepLink,
  codexThreadDeepLink,
  openCodexSurface,
  openCodexThread,
  setCodexUrlOpener,
  transferTranscript,
} from '../../apps/web/src/agent/codexTransfer';

test('RocketX 只把仍然外置的 Codex 工作面交给官方 deep link', () => {
  assert.equal(codexSurfaceDeepLink('scheduled'), 'codex://automations');
  assert.equal(codexSurfaceDeepLink('plugins'), 'codex://plugins/');
  assert.equal(codexSurfaceDeepLink('skills'), 'codex://skills');
  assert.equal(codexSurfaceDeepLink('settings'), 'codex://settings');
});

test('外置工作面由桌面打开器接管，失败时返回 unavailable', async () => {
  const opened: string[] = [];
  const restore = setCodexUrlOpener(async (url) => { opened.push(url); });
  try {
    assert.equal(await openCodexSurface('scheduled'), 'opened');
    assert.equal(await openCodexSurface('plugins'), 'opened');
    assert.deepEqual(opened, ['codex://automations', 'codex://plugins/']);
  } finally {
    restore();
  }

  const restoreFailure = setCodexUrlOpener(async () => { throw new Error('not installed'); });
  try {
    assert.equal(await openCodexSurface('settings'), 'unavailable');
  } finally {
    restoreFailure();
  }
});

test('当前任务切到 Codex App 时复用线程 deep link，编号仍做严格校验', async () => {
  assert.equal(codexThreadDeepLink('0198a4b5-7af0-7000-8000-123456789abc'), 'codex://threads/0198a4b5-7af0-7000-8000-123456789abc');
  assert.throws(() => codexThreadDeepLink(''), /线程编号无效/);
  assert.throws(() => codexThreadDeepLink('new'), /线程编号无效/);
  assert.throws(() => codexThreadDeepLink('../settings'), /线程编号无效/);

  const opened: string[] = [];
  const restore = setCodexUrlOpener(async (url) => { opened.push(url); });
  try {
    assert.equal(await openCodexThread('butler-thread'), 'opened-existing');
    assert.deepEqual(opened, ['codex://threads/butler-thread']);
  } finally {
    restore();
  }
});

test('新任务 deep link 只预填输入和工作区，不在 RocketX 内重复实现独立 Codex 页面', () => {
  const url = new URL(codexNewThreadDeepLink('第一行\n第二行', 'D:\\Repos\\rocketchatx'));
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.host, 'threads');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('prompt'), '第一行\n第二行');
  assert.equal(url.searchParams.get('path'), 'D:\\Repos\\rocketchatx');
  assert.throws(() => codexNewThreadDeepLink('', ''), /缺少上下文和工作区/);

  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const workspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  assert.match(conversation, /const result = await handoffToCodex\(\)/);
  assert.match(workspace, /return await openCodexThread\(current\.activeThreadId\)/);
  assert.match(conversation, /openCodexNewThread\('', workspaceRoot\)/);
  assert.match(history, /openCodexSurface\('scheduled'\)/);
  assert.match(history, /openCodexSurface\('plugins'\)/);
  assert.doesNotMatch(history, /CodexPage/);
});

test('转移完整记录时跳过欢迎语之前的内容和 📌 标记行', () => {
  const transcript = transferTranscript('管家对话', [
    { role: 'assistant', text: '我是你的管家。' },
    { role: 'user', text: '第一问' },
    { role: 'assistant', text: '📌 已记录记忆' },
    { role: 'assistant', text: '第一答' },
  ]);

  assert.doesNotMatch(transcript, /我是你的管家/);
  assert.doesNotMatch(transcript, /已记录记忆/);
  assert.match(transcript, /【用户】\n第一问/);
  assert.match(transcript, /【助手】\n第一答/);
  assert.match(transcript, /从 RocketX 转移过来的管家对话完整记录/);
  assert.match(transcript, /如果最后一个用户请求包含尚未完成的明确任务，直接继续执行/);
});
