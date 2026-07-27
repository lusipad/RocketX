import assert from 'node:assert/strict';
import test from 'node:test';
import type { ButlerErrandRun } from '../../apps/web/src/lib/butlerErrands';
import type { StoredRoundsResult } from '../../apps/web/src/lib/butlerRoundsRunner';
import { getServerBase } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';
import type { Todo } from '../../apps/web/src/stores/todos';
import {
  archivedButlerErrandsForDate,
  buildButlerPaperViewModel,
  butlerBriefForDate,
  butlerPaperDateKey,
  formatButlerPaperDate,
  partitionButlerPaperErrands,
  shiftButlerPaperDate,
  shouldExpandButlerConversation,
  visibleButlerTodos,
} from '../../apps/web/src/lib/butlerPaper';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function storedBrief(generatedAt: string): StoredRoundsResult {
  return {
    result: {
      headline: '那天的纸',
      summary: '一条历史简报。',
      items: [{ ref: 'history:1', why: '当天需要处理' }],
      proposals: [],
      suppressed: [],
    },
    generatedAt,
    checkedCount: 1,
    refTitles: { 'history:1': '历史事项' },
  };
}

function errand(
  id: string,
  status: ButlerErrandRun['status'],
  startedAt: number,
  archivedAt?: number,
): ButlerErrandRun {
  return {
    id,
    title: id,
    threadId: `thread-${id}`,
    workspaceRoot: 'D:/Repos/rocketchatx',
    workspaceName: '主仓',
    readOnly: false,
    startedAt,
    status,
    approvals: [],
    traces: [],
    archivedAt,
  };
}

function todo(
  id: string,
  createdAt: number,
  due?: string,
  done = false,
): Todo {
  return {
    id,
    title: id,
    done,
    due,
    createdAt,
  };
}

test('纸把等审批与其余在办活分区，并排除已经收下的活', () => {
  const sections = partitionButlerPaperErrands([
    errand('running-old', 'running', 1),
    errand('approval', 'awaiting-approval', 2),
    errand('replied', 'replied', 3),
    errand('archived', 'replied', 4, 5),
  ]);

  assert.deepEqual(sections.approvals.map((run) => run.id), ['approval']);
  assert.deepEqual(sections.active.map((run) => run.id), ['running-old', 'replied']);
});

test('今日纸直接投影真实未完成待办，截止日优先且历史纸不泄露实时状态', () => {
  const todos = [
    todo('无期限-旧', 1),
    todo('明天到期', 2, '2026-07-27'),
    todo('无期限-新', 3),
    todo('今天到期', 4, '2026-07-26'),
    todo('已经完成', 5, '2026-07-25', true),
  ];

  assert.deepEqual(
    visibleButlerTodos(todos).map((item) => item.id),
    ['今天到期', '明天到期', '无期限-新', '无期限-旧'],
  );

  const todayPaper = buildButlerPaperViewModel({
    dateKey: '2026-07-26',
    todayKey: '2026-07-26',
    runs: [],
    todos,
    brief: null,
  });
  assert.deepEqual(
    todayPaper.todos.map((item) => item.id),
    ['今天到期', '明天到期', '无期限-新', '无期限-旧'],
  );

  const historyPaper = buildButlerPaperViewModel({
    dateKey: '2026-07-25',
    todayKey: '2026-07-26',
    runs: [],
    todos,
    brief: null,
  });
  assert.deepEqual(historyPaper.todos, []);
});

test('旧纸只显示所选本地日期收下的活', () => {
  const july25 = new Date(2026, 6, 25, 10).getTime();
  const july26 = new Date(2026, 6, 26, 10).getTime();
  const filtered = archivedButlerErrandsForDate([
    errand('25', 'replied', 1, july25),
    errand('26', 'replied', 2, july26),
    errand('visible', 'running', 3),
  ], '2026-07-25');

  assert.deepEqual(filtered.map((run) => run.id), ['25']);
});

test('旧纸只复用 generatedAt 命中当天的现有简报', () => {
  const brief = {
    generatedAt: new Date(2026, 6, 25, 9).toISOString(),
  } as StoredRoundsResult;

  assert.equal(butlerBriefForDate(brief, '2026-07-25'), brief);
  assert.equal(butlerBriefForDate(brief, '2026-07-24'), null);
  assert.equal(butlerBriefForDate(null, '2026-07-25'), null);
});

test('历史简报按日期从快照读取，纸面投影不会泄露今天的在办状态', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousUser = useAuth.getState().user;
  const storage = new MemoryStorage();
  const historyBrief = storedBrief('2026-07-25T01:00:00.000Z');
  const accountId = 'paper-history-user';
  useAuth.setState({ user: { _id: accountId, username: accountId } as never });
  storage.setItem(`rcx-butler-v1:rounds-history:${getServerBase() || 'same-origin'}:${accountId}`, JSON.stringify({
    '2026-07-25': historyBrief,
    '2026-07-24': historyBrief,
  }));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });

  try {
    const brief = butlerBriefForDate(null, '2026-07-25');
    const paper = buildButlerPaperViewModel({
      dateKey: '2026-07-25',
      todayKey: '2026-07-26',
      runs: [errand('running-today', 'running', Date.now())],
      todos: [],
      brief,
    });

    assert.equal(paper.brief?.generatedAt, historyBrief.generatedAt);
    assert.equal(paper.isToday, false);
    assert.deepEqual(paper.errands, { approvals: [], active: [] });
    assert.equal(butlerBriefForDate(null, '2026-07-24'), null);

    useAuth.setState({ user: { _id: 'another-paper-user', username: 'other' } as never });
    assert.equal(butlerBriefForDate(null, '2026-07-25'), null);
  } finally {
    useAuth.setState({ user: previousUser } as never);
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('翻纸按本地日历移动，连续第 3 轮才升级完整对话', () => {
  assert.equal(shiftButlerPaperDate('2026-07-26', -1), '2026-07-25');
  assert.equal(butlerPaperDateKey(new Date(2026, 6, 26, 12)), '2026-07-26');
  assert.equal(formatButlerPaperDate('2026-07-26'), '7月26日 周日');
  assert.equal(shouldExpandButlerConversation(2), false);
  assert.equal(shouldExpandButlerConversation(3), true);
});
