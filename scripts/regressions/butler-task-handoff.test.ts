import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  handoffToButlerTaskWith,
  type ButlerTaskHandoffDependencies,
} from '../../apps/web/src/lib/butlerTaskHandoff';

function createDeps(
  overrides: Partial<ButlerTaskHandoffDependencies> = {},
): ButlerTaskHandoffDependencies {
  const opens: string[] = [];
  const queued: Array<{ rid: string; prompt: string }> = [];
  const copied: string[] = [];
  const notices: string[] = [];
  const calls = {
    connect: 0,
    startTask: [] as Array<{ text: string; title: string }>,
    setComposerDraft: [] as string[],
  };

  const base: ButlerTaskHandoffDependencies = {
    getProvider: () => 'codex',
    openConversation: () => {
      opens.push('opened');
    },
    openRoomPanel: () => undefined,
    getCodexWorkspace: () => ({
      workspaceRoot: '',
      status: 'idle',
      connect: async () => {
        calls.connect += 1;
      },
      startTask: async (text, title) => {
        calls.startTask.push({ text, title });
      },
      setComposerDraft: (text) => {
        calls.setComposerDraft.push(text);
      },
    }),
    draftHostedRoomPrompt: (rid, prompt) => {
      queued.push({ rid, prompt });
    },
    copyDeepSeekPrompt: async (prompt) => {
      copied.push(prompt);
    },
    notifyDeepSeekPaste: () => {
      notices.push('notified');
    },
    ...overrides,
  };

  Object.assign(base, {
    __opens: opens,
    __queued: queued,
    __copied: copied,
    __notices: notices,
    __calls: calls,
  });
  return base;
}

test('消息入口文案改为通用的 AI 管家，而不是硬编码 Codex 任务', () => {
  const item = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const list = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');

  assert.match(item, /label: '交给 AI 管家'/);
  assert.doesNotMatch(item, /创建 Codex 任务/);

  assert.match(list, /已交给 AI 管家：/);
  assert.match(list, /让 AI 管家从这些消息里提取承诺/);
  assert.match(list, /让 AI 管家总结这段对话/);
  assert.doesNotMatch(list, /已创建 Codex 任务：/);
});

test('房间交接只预填 canonical 托管指令，不创建 provider 专用会话', () => {
  const source = readFileSync('apps/web/src/lib/butlerTaskHandoff.ts', 'utf8');

  assert.match(source, /draftHostedRoomPrompt/);
  assert.match(source, /const command = `@ai \$\{prompt\}`/);
  assert.doesNotMatch(source, /roomButlerSessions|queueDeepSeekRoomPrompt/);
});

test('Codex provider 在无工作区时只打开管家并写入 Codex 草稿', async () => {
  const deps = createDeps();
  const result = await handoffToButlerTaskWith('  整理这段消息  ', '房间总结', deps);
  const internals = deps as ButlerTaskHandoffDependencies & {
    __opens: string[];
    __queued: Array<{ rid: string; prompt: string }>;
    __calls: {
      connect: number;
      startTask: Array<{ text: string; title: string }>;
      setComposerDraft: string[];
    };
  };

  assert.deepEqual(result, {
    provider: 'codex',
    status: 'drafted',
  });
  assert.deepEqual(internals.__opens, ['opened']);
  assert.deepEqual(internals.__calls.setComposerDraft, ['整理这段消息']);
  assert.equal(internals.__calls.connect, 0);
  assert.deepEqual(internals.__calls.startTask, []);
  assert.deepEqual(internals.__queued, []);
});

test('DeepSeek 全局任务不触碰 Codex，而是复制提示词并打开官方 DSH Web', async () => {
  const deps = createDeps({
    getProvider: () => 'deepseek',
    getCodexWorkspace: () => ({
      workspaceRoot: 'D:/Repos/rocketchatx',
      status: 'ready',
      connect: async () => {
        throw new Error('deepseek route should not connect codex');
      },
      startTask: async () => {
        throw new Error('deepseek route should not start codex task');
      },
      setComposerDraft: () => {
        throw new Error('deepseek route should not set codex draft');
      },
    }),
  });
  const result = await handoffToButlerTaskWith(
    '请总结这 3 条消息并标出承诺',
    '项目群 · 总结这段',
    deps,
  );
  const internals = deps as ButlerTaskHandoffDependencies & {
    __opens: string[];
    __queued: Array<{ rid: string; prompt: string }>;
    __copied: string[];
    __notices: string[];
    __calls: {
      connect: number;
      startTask: Array<{ text: string; title: string }>;
      setComposerDraft: string[];
    };
  };

  assert.deepEqual(result, {
    provider: 'deepseek',
    status: 'copied',
  });
  assert.deepEqual(internals.__opens, ['opened']);
  assert.deepEqual(internals.__queued, []);
  assert.deepEqual(internals.__copied, ['请总结这 3 条消息并标出承诺']);
  assert.deepEqual(internals.__notices, ['notified']);
});

test('DeepSeek 房间任务预填同一托管 session 的 @ai 指令并打开侧栏', async () => {
  const openedRooms: string[] = [];
  const deps = createDeps({
    getProvider: () => 'deepseek',
    openRoomPanel: (rid) => openedRooms.push(rid),
  });
  const result = await handoffToButlerTaskWith(
    '请总结房间消息',
    '项目群 · 总结',
    deps,
    { rid: 'room-1', preferRoomPanel: true },
  );
  const internals = deps as ButlerTaskHandoffDependencies & {
    __opens: string[];
    __queued: Array<{ rid: string; prompt: string }>;
    __copied: string[];
  };

  assert.deepEqual(result, { provider: 'deepseek', status: 'drafted' });
  assert.deepEqual(openedRooms, ['room-1']);
  assert.deepEqual(internals.__opens, []);
  assert.deepEqual(internals.__copied, []);
  assert.deepEqual(internals.__queued, [{
    prompt: '请总结房间消息',
    rid: 'room-1',
  }]);
});

test('无 AI 模式拒绝任务且不打开任何运行时', async () => {
  const deps = createDeps({ getProvider: () => 'none' });
  await assert.rejects(
    () => handoffToButlerTaskWith('处理这条消息', '无 AI', deps),
    /当前未启用 AI/,
  );
  const internals = deps as ButlerTaskHandoffDependencies & { __opens: string[]; __queued: unknown[] };
  assert.deepEqual(internals.__opens, []);
  assert.deepEqual(internals.__queued, []);
});
