import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUTLER_BRIEF_FEEDBACK_KEY,
  listBriefFeedback,
  noiseBriefFeedback,
  recordBriefFeedback,
} from '../../apps/web/src/lib/butlerBriefFeedback';
import {
  runButlerRounds,
  serializeButlerRoundsInput,
  suppressNoiseFeedbackItems,
  type RoundsInput,
  type RoundsResult,
} from '../../apps/web/src/kernel/ai/features/butler-rounds';
import type { AiChatRequest, AiChunk } from '../../apps/web/src/kernel/ai/provider';
import type { AiChatGateway } from '../../apps/web/src/kernel/ai/features/structured-output';
import { ledgerFromTodos } from '../../apps/web/src/lib/butlerLedger';
import { rememberButlerMemory, serializeButlerMemoryState } from '../../apps/web/src/lib/butlerMemory';
import {
  setButlerProfileStorage,
  writeButlerActiveMemoryV2RawJson,
} from '../../apps/web/src/lib/butlerProfile';
import { briefRoundPreferences } from '../../apps/web/src/lib/butlerRoundsRunner';
import { useAuth } from '../../apps/web/src/stores/auth';
import type { Todo } from '../../apps/web/src/stores/todos';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.get(key);
  }

  setItem(key: string, value: string): void {
    this.set(key, value);
  }
}

function gateway(chunks: AiChunk[], inspect?: (request: AiChatRequest) => void): AiChatGateway {
  return {
    async *chat(_capability, request) {
      inspect?.(request);
      for (const chunk of chunks) yield chunk;
    },
  };
}

function roundsInput(overrides: Partial<RoundsInput> = {}): RoundsInput {
  const todos: Todo[] = [{
    id: 't1',
    title: '提交发布说明',
    due: '2026-07-25',
    committedTo: '发布组',
    done: false,
    createdAt: 1,
  }];
  return {
    ledger: ledgerFromTodos(todos, '2026-07-25'),
    todos,
    workItems: [],
    pullRequests: [],
    builds: [],
    iterationEndDate: null,
    localTime: '2026-07-25T12:00:00+08:00',
    lastRoundsAt: null,
    mutes: [],
    ...overrides,
  };
}

function resultJson(items: unknown[] = []): string {
  return JSON.stringify({
    headline: '今天先处理承诺',
    summary: '有一件事值得现在处理。',
    items,
    proposals: [],
    suppressed: [],
  });
}

test('反馈按标题归并覆盖，后点覆盖先点，坏数据被过滤', () => {
  const storage = new MemoryStorage();
  assert.ok(recordBriefFeedback({ ref: 'todo:t1', title: '提交发布说明', verdict: 'noise' }, storage, 1));
  assert.ok(recordBriefFeedback({ ref: 'todo:t1-next', title: '提交发布说明', verdict: 'useful' }, storage, 2));
  const feedback = listBriefFeedback(storage);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].verdict, 'useful');
  assert.equal(feedback[0].ref, 'todo:t1-next');

  assert.equal(recordBriefFeedback({ ref: ' ', title: '空引用', verdict: 'noise' }, storage), null);
  storage.setItem(BUTLER_BRIEF_FEEDBACK_KEY, JSON.stringify([
    { ref: 'todo:x', title: '合法', verdict: 'noise', at: 3 },
    { ref: 'todo:y', title: '非法档位', verdict: 'meh', at: 4 },
    '不是对象',
  ]));
  const filtered = listBriefFeedback(storage);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, '合法');
});

test('反馈最多保留 200 条，超出裁掉最旧', () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < 201; index++) {
    recordBriefFeedback({ ref: `todo:${index}`, title: `条目 ${index}`, verdict: 'noise' }, storage, index);
  }
  const feedback = listBriefFeedback(storage);
  assert.equal(feedback.length, 200);
  assert.equal(feedback[0].title, '条目 1');
  assert.equal(feedback[199].title, '条目 200');
});

test('「没用」条目由代码强制降入工作日志，理由是你标过没用', () => {
  const result: RoundsResult = {
    headline: '今天先看这件',
    summary: '一条承诺临期。',
    items: [{ ref: 'todo:t1', why: '今天到期', suggestedAction: '确认交付' }],
    proposals: [],
    suppressed: [],
  };
  const suppressed = suppressNoiseFeedbackItems(
    result,
    { 'todo:t1': '提交发布说明' },
    [{ ref: 'todo:t1', title: '发布说明', verdict: 'noise', at: 1 }],
  );
  assert.deepEqual(suppressed.items, []);
  assert.deepEqual(suppressed.suppressed, [{ ref: 'todo:t1', reason: '你标过没用' }]);

  const useful = suppressNoiseFeedbackItems(
    result,
    { 'todo:t1': '提交发布说明' },
    [{ ref: 'todo:t1', title: '发布说明', verdict: 'useful', at: 1 }],
  );
  assert.equal(useful.items.length, 1);
});

test('noiseHints 与 briefPreferences 进入快照与巡视请求，noise 命中强制压制', async () => {
  const noiseFeedback = [
    { ref: 'todo:old', title: '发布说明', verdict: 'noise' as const, at: 1 },
    { ref: 'todo:keep', title: '值得盯的事', verdict: 'useful' as const, at: 2 },
  ];
  const briefPreferences = ['焦点：先说影响交付的事'];
  const snapshot = serializeButlerRoundsInput(roundsInput({ noiseFeedback, briefPreferences }));
  assert.deepEqual(snapshot.noiseHints, ['发布说明']);
  assert.deepEqual(snapshot.briefPreferences, briefPreferences);
  assert.deepEqual(noiseBriefFeedback(noiseFeedback), [{ text: '发布说明' }]);

  let requestSnapshot: { noiseHints: string[]; briefPreferences: string[] } | null = null;
  const result = await runButlerRounds(
    roundsInput({ noiseFeedback, briefPreferences }),
    gateway([
      {
        content: resultJson([{ ref: 'todo:t1', why: '今天到期', suggestedAction: '确认交付' }]),
        finishReason: 'stop',
      },
    ], (request) => {
      requestSnapshot = JSON.parse(request.messages[1].content) as typeof requestSnapshot;
    }),
  );
  assert.deepEqual(requestSnapshot?.noiseHints, ['发布说明']);
  assert.deepEqual(requestSnapshot?.briefPreferences, briefPreferences);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.suppressed, [{ ref: 'todo:t1', reason: '你标过没用' }]);
});

test('briefRoundPreferences 读取 brief: 前缀偏好记忆，未登录时静默为空', () => {
  const storage = new MemoryStorage();
  const restoreProfile = setButlerProfileStorage(storage);
  const previousUser = useAuth.getState().user;
  try {
    useAuth.setState({ user: undefined } as never);
    assert.deepEqual(briefRoundPreferences(10), []);

    useAuth.setState({ user: { _id: 'u1', username: 'user-u1' } } as never);
    const scope = { server: 'same-origin', account: 'u1' };
    let state = rememberButlerMemory(
      { schemaVersion: 2, records: [] },
      {
        kind: 'preference',
        scope,
        subject: 'brief:构建',
        value: '多盯失败，别报纯标签变更',
        provenance: { butlerSource: 'test', summary: 'test' },
      },
      { now: 5, createId: () => 'brief-pref-1' },
    ).state;
    state = rememberButlerMemory(
      state,
      {
        kind: 'preference',
        scope,
        subject: 'reply-style',
        value: '简短',
        provenance: { butlerSource: 'test', summary: 'test' },
      },
      { now: 6, createId: () => 'other-pref' },
    ).state;
    writeButlerActiveMemoryV2RawJson(serializeButlerMemoryState(state));

    assert.deepEqual(briefRoundPreferences(10), ['构建：多盯失败，别报纯标签变更']);
  } finally {
    useAuth.setState({ user: previousUser } as never);
    restoreProfile();
  }
});
