import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ControlledWorkItemStateError,
  directGetWorkItem,
  directSetWorkItemStateControlled,
  isControlledWorkItemStateOutcomeUnknown,
  updateWorkItemStateRequest,
} from '../../apps/web/src/lib/adoDirect';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const cfg = { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' as const };

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function adoJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function adoText(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function workItemJson(id: number, state: string, rev: number) {
  return {
    value: [
      {
        id,
        rev,
        fields: {
          'System.Title': `工作项 ${id}`,
          'System.WorkItemType': 'Task',
          'System.State': state,
          'System.TeamProject': 'Alpha',
        },
      },
    ],
  };
}

test('directGetWorkItem 映射顶层 revision', async () => {
  globalThis.fetch = (async () => adoJson(workItemJson(123, 'Active', 7))) as typeof fetch;

  const item = await directGetWorkItem(cfg, 123);

  assert.equal(item?.revision, 7);
});

test('direct ADO 请求给 fetch 传真实 AbortSignal', async () => {
  let receivedSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal as AbortSignal | undefined;
    return adoJson(workItemJson(123, 'Active', 7));
  }) as typeof fetch;

  await directGetWorkItem(cfg, 123);

  assert.ok(receivedSignal instanceof AbortSignal);
});

test('ADO 设置不会再引导用户创建无法执行确认写入的只读 PAT', () => {
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');
  assert.match(settings, /Work Items 读写、Code \/ Build 读取/);
  assert.doesNotMatch(settings, /Work Items \/ Code \/ Build 只读/);
});

test('updateWorkItemStateRequest 在 expectedRevision 存在时先 test /rev 再写状态', () => {
  const request = updateWorkItemStateRequest(123, '已解决', 7);

  assert.deepEqual(request.body, [
    { op: 'test', path: '/rev', value: 7 },
    { op: 'add', path: '/fields/System.State', value: '已解决' },
  ]);
  assert.throws(() => updateWorkItemStateRequest(123, '已解决', 0), /revision 无效/);
});

test('unknown helper 只把已尝试写入但结果无法确认归类为 unknown', () => {
  assert.equal(
    isControlledWorkItemStateOutcomeUnknown(
      new ControlledWorkItemStateError('write-attempted-unknown', 'x'),
    ),
    true,
  );
  assert.equal(
    isControlledWorkItemStateOutcomeUnknown(
      new ControlledWorkItemStateError('readback-timeout', 'x'),
    ),
    true,
  );
  assert.equal(
    isControlledWorkItemStateOutcomeUnknown(
      new ControlledWorkItemStateError('deadline-before-write', 'x'),
    ),
    false,
  );
  assert.equal(isControlledWorkItemStateOutcomeUnknown(new Error('x')), false);
});

test('受控状态更新遇到目标已满足时零 PATCH', async () => {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return adoJson(workItemJson(123, '已解决', 9));
  }) as typeof fetch;

  const result = await directSetWorkItemStateControlled(cfg, 123, '已解决', {
    expectedState: 'Active',
    expectedRevision: 7,
  });

  assert.equal(result.changed, false);
  assert.equal(result.item.state, '已解决');
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  assert.equal(calls.length, 1);
});

test('受控状态更新在预读发现状态冲突时零 PATCH 失败', async () => {
  const calls: { method: string }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET' });
    return adoJson(workItemJson(123, 'Closed', 7));
  }) as typeof fetch;

  await assert.rejects(
    () =>
      directSetWorkItemStateControlled(cfg, 123, '已解决', {
        expectedState: 'Active',
        expectedRevision: 7,
      }),
    /状态已从「Active」变为「Closed」/,
  );
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('受控状态更新在预读发现 revision 冲突时零 PATCH 失败', async () => {
  const calls: { method: string }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET' });
    return adoJson(workItemJson(123, 'Active', 8));
  }) as typeof fetch;

  await assert.rejects(
    () =>
      directSetWorkItemStateControlled(cfg, 123, '已解决', {
        expectedState: 'Active',
        expectedRevision: 7,
      }),
    /期望 rev 7，当前 rev 8/,
  );
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('受控状态更新在共享 budget 被预读耗尽时零 PATCH', async () => {
  const calls: { method: string }[] = [];
  const nowValues = [0, 0, 14_001];
  Date.now = () => nowValues.shift() ?? 14_001;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET' });
    return adoJson(workItemJson(123, 'Active', 7));
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal((failure as Error & { reason?: string }).reason, 'deadline-before-write');
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), false);
  assert.match((failure as Error).message, /预读已耗尽 15 秒写入时限/);
  assert.equal(calls.map((call) => call.method).join(','), 'GET');
});

test('受控状态更新成功时 PATCH 带 /rev 并在成功后回读', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoJson({
      id: 123,
      rev: 8,
      fields: {
        'System.Title': '工作项 123',
        'System.WorkItemType': 'Task',
        'System.State': '已解决',
        'System.TeamProject': 'Alpha',
      },
    }),
    adoJson(workItemJson(123, '已解决', 8)),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  const result = await directSetWorkItemStateControlled(cfg, 123, '已解决', {
    expectedState: 'Active',
    expectedRevision: 7,
  });

  assert.equal(result.changed, true);
  assert.equal(result.item.revision, 8);
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
  assert.match(calls[1]?.body ?? '', /"op":"test","path":"\/rev","value":7/);
  assert.match(calls[1]?.body ?? '', /"path":"\/fields\/System.State","value":"已解决"/);
});

test('PATCH 失败后只回读一次；目标已满足则按幂等成功返回', async () => {
  const calls: { method: string }[] = [];
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoText('conflict', 409),
    adoJson(workItemJson(123, '已解决', 8)),
  ];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET' });
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  const result = await directSetWorkItemStateControlled(cfg, 123, '已解决', {
    expectedState: 'Active',
    expectedRevision: 7,
  });

  assert.equal(result.changed, true);
  assert.equal(result.item.state, '已解决');
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
});

test('PATCH 失败后回读仍未满足且出现 revision 冲突时返回明确冲突', async () => {
  const calls: { method: string }[] = [];
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoText('conflict', 409),
    adoJson(workItemJson(123, 'Active', 8)),
  ];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET' });
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), false);
  assert.match(failure.message, /期望 rev 7，当前 rev 8/);
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
});

test('PATCH 的 5xx 结果不明且回读出现 revision 冲突时仍归类为 unknown', async () => {
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoText('server busy', 500),
    adoJson(workItemJson(123, 'Active', 8)),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match(failure.message, /结果暂时无法确认.*期望 rev 7，当前 rev 8/);
});

test('PATCH 失败后回读仍未满足且无冲突证据时返回无法确认', async () => {
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoText('server busy', 500),
    adoJson(workItemJson(123, 'Active', 7)),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match(failure.message, /状态更新结果暂时无法确认/);
});

test('PATCH 的确定性 400 失败在回读确认未写入后保留服务端错误', async () => {
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoText('invalid transition', 400),
    adoJson(workItemJson(123, 'Active', 7)),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  await assert.rejects(
    () => directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    }),
    /ADO 返回 400：invalid transition/,
  );
});

test('PATCH 后目标状态虽匹配但 revision 未前进时不声明成功', async () => {
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoJson({ id: 123, rev: 8, fields: {} }),
    adoJson(workItemJson(123, '已解决', 7)),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return next;
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match(failure.message, /revision 未前进，结果暂时无法确认/);
});

test('PATCH 失败且回读也失败时不重发 PATCH，并明确结果无法确认', async () => {
  const calls: { method: string }[] = [];
  const responses: Array<Response | Error> = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoText('server busy', 500),
    new Error('network down'),
  ];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET' });
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match((failure as Error).message, /写入请求失败且回读也失败，结果暂时无法确认/);
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
});

test('PATCH timeout 后一次回读可确认成功', async () => {
  const calls: { method: string; signal?: AbortSignal }[] = [];
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoJson(workItemJson(123, '已解决', 8)),
  ];
  let timerId = 0;
  globalThis.setTimeout = (((callback: (...args: any[]) => void) => {
    timerId += 1;
    if (timerId === 2) callback();
    return timerId as ReturnType<typeof setTimeout>;
  }) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (((_handle?: ReturnType<typeof setTimeout>) => {}) as unknown) as typeof clearTimeout;
  globalThis.fetch = (((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const signal = init?.signal as AbortSignal | undefined;
    calls.push({ method, signal });
    if (method === 'PATCH') {
      return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return Promise.resolve(next);
  }) as unknown) as typeof fetch;

  const result = await directSetWorkItemStateControlled(cfg, 123, '已解决', {
    expectedState: 'Active',
    expectedRevision: 7,
  });

  assert.equal(result.changed, true);
  assert.equal(result.item.state, '已解决');
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
});

test('PATCH timeout 后最多一次回读；未确认成功时返回 write-attempted-unknown', async () => {
  const calls: { method: string; signal?: AbortSignal }[] = [];
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoJson(workItemJson(123, 'Active', 7)),
  ];
  let timerId = 0;
  globalThis.setTimeout = (((callback: (...args: any[]) => void) => {
    timerId += 1;
    if (timerId === 2) callback();
    return timerId as ReturnType<typeof setTimeout>;
  }) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (((_handle?: ReturnType<typeof setTimeout>) => {}) as unknown) as typeof clearTimeout;
  globalThis.fetch = (((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const signal = init?.signal as AbortSignal | undefined;
    calls.push({ method, signal });
    if (method === 'PATCH') {
      return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return Promise.resolve(next);
  }) as unknown) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal((failure as Error & { reason?: string }).reason, 'write-attempted-unknown');
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match((failure as Error).message, /PATCH 超时/);
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
});

test('PATCH 成功但回读失败时不声明成功', async () => {
  const responses: Array<Response | Error> = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoJson({ id: 123, rev: 8, fields: {} }),
    new Error('network down'),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match((failure as Error).message, /PATCH 已提交但回读失败，结果暂时无法确认/);
});

test('PATCH 成功但回读 timeout 时返回 readback-timeout', async () => {
  const calls: { method: string; signal?: AbortSignal }[] = [];
  const responses = [
    adoJson(workItemJson(123, 'Active', 7)),
    adoJson({ id: 123, rev: 8, fields: {} }),
  ];
  let timerId = 0;
  globalThis.setTimeout = (((callback: (...args: any[]) => void) => {
    timerId += 1;
    if (timerId === 3) callback();
    return timerId as ReturnType<typeof setTimeout>;
  }) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (((_handle?: ReturnType<typeof setTimeout>) => {}) as unknown) as typeof clearTimeout;
  globalThis.fetch = (((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const signal = init?.signal as AbortSignal | undefined;
    calls.push({ method, signal });
    if (calls.length === 3) {
      return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    const next = responses.shift();
    assert.ok(next, 'fetch 响应队列不足');
    return Promise.resolve(next);
  }) as unknown) as typeof fetch;

  let failure: unknown;
  try {
    await directSetWorkItemStateControlled(cfg, 123, '已解决', {
      expectedState: 'Active',
      expectedRevision: 7,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal((failure as Error & { reason?: string }).reason, 'readback-timeout');
  assert.equal(isControlledWorkItemStateOutcomeUnknown(failure), true);
  assert.match((failure as Error).message, /回读超时/);
  assert.equal(calls.map((call) => call.method).join(','), 'GET,PATCH,GET');
});

test('工作项讨论默认启动本机 Agent，但默认不写回 ADO（issue #292）', () => {
  const source = readFileSync('apps/web/src/components/CreateWorkItemDiscussionDialog.tsx', 'utf8');

  assert.match(source, /const \[startAgent, setStartAgent\] = useState\(true\);/);
  assert.match(source, /const \[writeBack, setWriteBack\] = useState\(false\);/);
  assert.match(source, /创建后启动本机 Agent/);
  assert.match(source, /将讨论链接写回 ADO 工作项/);
});

test('工作项讨论写回只走 commentWorkItem 评论，不触碰 AssignedTo（issue #292）', () => {
  const source = readFileSync('apps/web/src/components/CreateWorkItemDiscussionDialog.tsx', 'utf8');

  assert.match(source, /if \(writeBack\) \{/);
  assert.match(source, /await commentWorkItem\(item\.id, `RocketX 已创建工作项讨论：<a href="\$\{escapeHtml\(href\)\}">\$\{escapeHtml\(resolvedName\)\}<\/a>`\)/);
  assert.doesNotMatch(source, /System\.AssignedTo/);
});
