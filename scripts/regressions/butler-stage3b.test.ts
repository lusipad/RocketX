import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiChatGateway } from '../../apps/web/src/kernel/ai/features/structured-output';
import {
  runButlerRounds,
  type RoundsInput,
  type RoundsProposal,
} from '../../apps/web/src/kernel/ai/features/butler-rounds';
import { turnButlerBriefItemIntoTodo } from '../../apps/web/src/lib/butlerBriefActions';
import {
  isProposalHandled,
  type ButlerProposalHandledStorage,
  type RecentSentMessage,
} from '../../apps/web/src/lib/butlerOutbox';
import {
  acceptButlerProposal,
  dismissButlerProposal,
} from '../../apps/web/src/lib/butlerProposalActions';
import {
  snoozeButlerRoundsItem,
  useButlerRoundsRunner,
  visibleButlerRoundItems,
  type StoredRoundsResult,
} from '../../apps/web/src/lib/butlerRoundsRunner';
import type { Todo } from '../../apps/web/src/stores/todos';

class MemoryStorage implements ButlerProposalHandledStorage, Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
}

const sentMessage: RecentSentMessage = {
  ref: 'msg:m42',
  rid: 'r1',
  roomName: 'Alice',
  peer: 'Alice',
  text: '我明天把结论发你',
  at: '2026-07-19T03:00:00.000Z',
};

function roundsInput(): RoundsInput {
  return {
    ledger: [],
    todos: [],
    workItems: [],
    pullRequests: [],
    builds: [],
    iterationEndDate: null,
    localTime: '2026-07-19T12:00:00+08:00',
    lastRoundsAt: null,
    mutes: [],
    recentSentMessages: [sentMessage],
  };
}

function gateway(value: unknown): AiChatGateway {
  return {
    async *chat() {
      yield { content: JSON.stringify(value), finishReason: 'stop' };
    },
  };
}

function roundsResult(ref: string) {
  return {
    headline: '有一句承诺值得确认',
    summary: '这句话还没有对应待办。',
    items: [],
    proposals: [{
      kind: 'add-commitment',
      ref,
      reason: '这是你答应 Alice 明天发结论的话',
      who: 'Alice',
      due: '2026-07-20',
    }],
    suppressed: [],
  };
}

test('rounds 接受快照里的 msg ref，未知前缀仍让整轮失败', async () => {
  const accepted = await runButlerRounds(roundsInput(), gateway(roundsResult('msg:m42')));
  assert.equal(accepted.proposals[0].ref, 'msg:m42');

  await assert.rejects(
    () => runButlerRounds(roundsInput(), gateway(roundsResult('unknown:m42'))),
    /不存在的条目: unknown:m42/,
  );
});

function todoState(todos: Todo[]) {
  return {
    todos,
    add(todo: Omit<Todo, 'id' | 'done' | 'createdAt'>) {
      const id = `new-${todos.length}`;
      todos.push({ ...todo, id, done: false, createdAt: 1 });
      return id;
    },
    update(id: string, patch: Partial<Pick<Todo, 'note' | 'due' | 'committedTo' | 'waitingFor'>>) {
      const todo = todos.find((item) => item.id === id);
      if (todo) Object.assign(todo, patch);
    },
    toggle(id: string) {
      const todo = todos.find((item) => item.id === id);
      if (todo) todo.done = !todo.done;
    },
  };
}

test('接受 msg 承诺会完整落 message 待办并标记 handled', () => {
  const todos: Todo[] = [];
  const storage = new MemoryStorage();
  const result = acceptButlerProposal(roundsResult('msg:m42').proposals[0] as RoundsProposal, {
    todoState: todoState(todos),
    messageRefs: { 'msg:m42': sentMessage },
    handledStorage: storage,
  });

  assert.equal(result, 'applied');
  assert.deepEqual(todos[0], {
    id: 'new-0',
    done: false,
    createdAt: 1,
    source: 'message',
    title: sentMessage.text,
    rid: 'r1',
    mid: 'm42',
    roomName: 'Alice',
    excerpt: sentMessage.text,
    note: '这是你答应 Alice 明天发结论的话',
    committedTo: 'Alice',
    due: '2026-07-20',
  });
  assert.equal(isProposalHandled('msg:m42', storage), true);
});

test('先不管 msg 提议也会标记 handled', () => {
  const storage = new MemoryStorage();
  dismissButlerProposal({
    kind: 'add-commitment',
    ref: 'msg:dismissed',
    reason: '暂不处理',
  }, storage);
  assert.equal(isProposalHandled('msg:dismissed', storage), true);
});

test('简报转任务按 adoWorkItemId 与 mid 防重', () => {
  const todos: Todo[] = [];
  const state = todoState(todos);
  assert.equal(turnButlerBriefItemIntoTodo('wi:42', '#42 修复发布', { todoState: state }), 'created');
  assert.equal(turnButlerBriefItemIntoTodo('wi:42', '#42 修复发布', { todoState: state }), 'already-exists');
  assert.equal(todos[0].adoWorkItemId, 42);

  assert.equal(turnButlerBriefItemIntoTodo('msg:m42', sentMessage.text, {
    todoState: state,
    message: sentMessage,
  }), 'created');
  assert.equal(turnButlerBriefItemIntoTodo('msg:m42', sentMessage.text, {
    todoState: state,
    message: sentMessage,
  }), 'already-exists');
  assert.equal(todos[1].rid, 'r1');
  assert.equal(todos[1].mid, 'm42');
});

test('稍后会写进当轮持久化结果，伪造下一轮后条目重新可见', () => {
  const previousState = useButlerRoundsRunner.getState();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  const stored = {
    generatedAt: '2026-07-19T04:00:00.000Z',
    checkedCount: 1,
    refTitles: { 'msg:m42': sentMessage.text },
    result: {
      headline: '有一件事',
      summary: '这轮需要看。',
      items: [{ ref: 'msg:m42', why: '可能会漏', suggestedAction: '确认进展' }],
      proposals: [],
      suppressed: [],
    },
  } satisfies StoredRoundsResult;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    useButlerRoundsRunner.setState({
      lastRoundsAt: stored.generatedAt,
      lastResult: stored,
      running: false,
      error: null,
    });
    assert.equal(snoozeButlerRoundsItem('msg:m42'), true);
    assert.deepEqual(visibleButlerRoundItems(useButlerRoundsRunner.getState().lastResult), []);
    const persisted = JSON.parse(storage.getItem('rcx-butler-v1:rounds-last-result') ?? '{}') as StoredRoundsResult;
    assert.deepEqual(persisted.snoozedRefs, ['msg:m42']);

    const nextRound = { ...stored, generatedAt: '2026-07-20T04:00:00.000Z' };
    assert.equal(visibleButlerRoundItems(nextRound).length, 1);
  } finally {
    useButlerRoundsRunner.setState(previousState);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
