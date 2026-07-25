import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUTLER_TURN_TIMINGS_KEY,
  addButlerToolRoundtrip,
  beginButlerTurnTiming,
  butlerTimingsSummary,
  listButlerTurnTimings,
  type ButlerTurnTiming,
} from '../../apps/web/src/lib/butlerTimings';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test('一轮问答按分段落盘：线程建立、首 token、工具往返、整轮', () => {
  const storage = new MemoryStorage();
  const time = clock();
  const timing = beginButlerTurnTiming({ threadSetupMs: 40, resumeMode: 'native' }, storage, time.now);

  time.advance(120);
  timing.markFirstToken();
  time.advance(30);
  timing.markFirstToken();
  timing.addToolRoundtrip('search_messages', 800);
  time.advance(1000);
  timing.end('completed');
  timing.end('completed');

  const rows = listButlerTurnTimings(storage);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].threadSetupMs, 40);
  assert.equal(rows[0].resumeMode, 'native');
  assert.equal(rows[0].firstTokenMs, 120);
  assert.deepEqual(rows[0].toolRoundtrips, [{ tool: 'search_messages', ms: 800 }]);
  assert.equal(rows[0].totalMs, 1150);
  assert.equal(rows[0].outcome, 'completed');
});

test('全局工具往返只写进行中的轮，结束或没有轮时静默丢弃', () => {
  const storage = new MemoryStorage();
  addButlerToolRoundtrip('orphan_tool', 5);

  const timing = beginButlerTurnTiming({ threadSetupMs: 0 }, storage, clock().now);
  addButlerToolRoundtrip('list_pull_requests', 300);
  timing.end('failed');
  addButlerToolRoundtrip('late_tool', 7);

  const rows = listButlerTurnTimings(storage);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].toolRoundtrips, [{ tool: 'list_pull_requests', ms: 300 }]);
  assert.equal(rows[0].outcome, 'failed');
});

test('计时最多保留 200 轮，坏数据被过滤', () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < 201; index++) {
    const time = clock(index * 10);
    beginButlerTurnTiming({ threadSetupMs: index }, storage, time.now).end('completed');
  }
  const rows = listButlerTurnTimings(storage);
  assert.equal(rows.length, 200);
  assert.equal(rows[0].threadSetupMs, 1);
  assert.equal(rows[199].threadSetupMs, 200);

  storage.setItem(BUTLER_TURN_TIMINGS_KEY, JSON.stringify([
    rows[0],
    { at: 'x', totalMs: 'bad', toolRoundtrips: [], threadSetupMs: 0, outcome: 'completed' },
    '不是对象',
  ]));
  assert.equal(listButlerTurnTimings(storage).length, 1);
});

test('迟到的工具往返记回它自己那一轮，不算到下一轮头上', () => {
  const storage = new MemoryStorage();
  const timeA = clock(1_000);
  const turnA = beginButlerTurnTiming({ threadSetupMs: 0 }, storage, timeA.now);
  // 工具发起时捕获句柄（宿主接线的做法），返回时 A 已结束、B 已开始
  const capturedForA = turnA;
  turnA.end('stopped');
  const turnB = beginButlerTurnTiming({ threadSetupMs: 0 }, storage, clock(9_000).now);
  capturedForA.addToolRoundtrip('late_from_a', 4_000);
  turnB.addToolRoundtrip('own_of_b', 100);
  turnB.end('completed');

  const rows = listButlerTurnTimings(storage);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].toolRoundtrips, []);
  assert.equal(rows[0].outcome, 'stopped');
  assert.deepEqual(rows[1].toolRoundtrips, [{ tool: 'own_of_b', ms: 100 }]);
});

test('用户中止的轮次记为 stopped，被截断的整轮时长不污染 P50/P95', () => {
  const timings: ButlerTurnTiming[] = [
    ...[1_000, 1_000, 1_000].map((totalMs, index) => ({
      at: new Date(index).toISOString(),
      threadSetupMs: 0,
      firstTokenMs: 300,
      toolRoundtrips: [{ tool: 't', ms: 200 }],
      totalMs,
      outcome: 'completed' as const,
    })),
    {
      at: new Date(9).toISOString(),
      threadSetupMs: 0,
      firstTokenMs: 100,
      toolRoundtrips: [{ tool: 'cut', ms: 50 }],
      totalMs: 120,
      outcome: 'stopped' as const,
    },
  ];
  const summary = butlerTimingsSummary(timings);
  assert.equal(summary.count, 4);
  assert.equal(summary.completed, 3);
  assert.equal(summary.stopped, 1);
  // 被中止的 120ms 若混进分布，P50 会被拉到 1000 以下
  assert.equal(summary.p50TotalMs, 1_000);
  assert.equal(summary.p50FirstTokenMs, 300);
  // 工具往返是真实测量，仍然计入
  assert.equal(summary.p95ToolRoundtripMs, 200);
});

test('汇总给出 P50/P95，failed 轮不进整轮分布但工具耗时仍计入', () => {
  const timings: ButlerTurnTiming[] = [
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((totalMs, index) => ({
      at: new Date(index).toISOString(),
      threadSetupMs: 0,
      firstTokenMs: totalMs / 2,
      toolRoundtrips: [{ tool: 't', ms: totalMs / 10 }],
      totalMs,
      outcome: 'completed' as const,
    })),
    {
      at: new Date(99).toISOString(),
      threadSetupMs: 0,
      toolRoundtrips: [{ tool: 'slow', ms: 9999 }],
      totalMs: 88888,
      outcome: 'failed' as const,
    },
  ];
  const summary = butlerTimingsSummary(timings);
  assert.equal(summary.count, 11);
  assert.equal(summary.completed, 10);
  assert.equal(summary.p50TotalMs, 500);
  assert.equal(summary.p95TotalMs, 1000);
  assert.equal(summary.p50FirstTokenMs, 250);
  assert.equal(summary.p95FirstTokenMs, 500);
  assert.equal(summary.p95ToolRoundtripMs, 9999);
  assert.equal(summary.avgToolCallsPerTurn, 1);

  const empty = butlerTimingsSummary([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.p50TotalMs, undefined);
});
