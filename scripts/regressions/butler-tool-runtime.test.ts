import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { useAuth } from '../../apps/web/src/stores/auth';
import { createButlerProposalCheckpoint } from '../../apps/web/src/lib/butlerProposalActions';
import { createButlerTools } from '../../apps/web/src/lib/butlerTools';
import {
  executeApprovedButlerOperation,
  flushButlerPersist,
  resetButlerPersistenceForTests,
  setButlerPersistence,
  setButlerToolAuditWriter,
  useButler,
} from '../../apps/web/src/stores/butler';
import type { ButlerToolAuditEntry } from '../../apps/web/src/lib/butlerToolRuntime';
import { useWorkbench } from '../../apps/web/src/stores/workbench';

function resetStores(): void {
  useButler.getState().reset();
  useAuth.setState({ user: undefined } as never);
  useWorkbench.setState({ config: null });
  resetButlerPersistenceForTests();
}

let restoreDefaultAudit = () => {};
test.beforeEach(() => {
  restoreDefaultAudit = setButlerToolAuditWriter(() => undefined);
});
test.afterEach(() => {
  restoreDefaultAudit();
  resetStores();
});

test('写动作在明确审批前不会直接完成执行', async () => {
  useButler.setState({
    lines: [
      { id: 'welcome', role: 'assistant', text: '我是你的管家。消息、待办、日程、工作项都可以直接问我。' },
      {
        id: 'assistant-line',
        role: 'assistant',
        text: '建议先给发布群发一条确认消息。',
        sources: [{ kind: 'message', id: 'msg-1', mid: 'msg-1', rid: 'room-release', label: '发布群消息' }],
      },
    ],
    context: {
      kind: 'room',
      label: '发布群',
      detail: '当前 Rocket.Chat 房间',
      sources: [{ kind: 'room', id: 'room-release', rid: 'room-release', label: '发布群' }],
    },
  });

  useButler.getState().proposeAction('reply', 'assistant-line');
  assert.ok(useButler.getState().actionDraft, '预期先出现可见草案');

  await assert.rejects(
    useButler.getState().completeAction('回复草稿已放入原会话编辑框'),
    /不在执行状态/,
  );

  assert.ok(useButler.getState().actionDraft, 'P4 合同要求审批前仍保留 pending draft/checkpoint');
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'approval-required');
  assert.notEqual(useButler.getState().lines.at(-1)?.text, '✅ 回复草稿已放入原会话编辑框');

  assert.deepEqual(await useButler.getState().beginAction(), { allowed: true });
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'running');
  await useButler.getState().completeAction('回复草稿已放入原会话编辑框');
  assert.equal(useButler.getState().actionDraft, null);
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'completed');
});

test('draft_action 把上一条有效回答转成确认卡，不直接执行', async () => {
  useButler.setState({
    lines: [
      { id: 'welcome', role: 'assistant', text: '我是你的管家。消息、待办、日程、工作项都可以直接问我。' },
      { id: 'answer', role: 'assistant', text: '发布前需要 Alice 确认检查清单。' },
      { id: 'request', role: 'user', text: '把这个转成待办。' },
    ],
    actionDraft: null,
    runtimeCheckpoints: [],
  });
  const tool = createButlerTools().find((candidate) => candidate.name === 'draft_action');
  assert.ok(tool);
  assert.equal(tool.effect, 'draft');
  assert.equal(tool.approve, undefined);

  const result = await tool.invoke({ kind: 'todo' }, { sessionId: 'session-action' });

  assert.equal(result.status, 'completed');
  assert.match(result.content ?? '', /已准备待办草案/);
  assert.equal(useButler.getState().actionDraft?.kind, 'todo');
  assert.equal(useButler.getState().actionDraft?.sourceLineId, 'answer');
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'approval-required');
});

test('draft_ado_state 先读取工作项并生成参数化确认卡，确认前零 PATCH', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? 'GET', url });
    if (url.includes('/_apis/connectionData?api-version=7.0-preview')) {
      return new Response(JSON.stringify({
        authenticatedUser: {
          id: '00000000-0000-0000-0000-000000000123',
          customDisplayName: 'lus',
          properties: { Account: { $value: 'lus' } },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      value: [{
        id: 123,
        rev: 7,
        fields: {
          'System.Title': '修复发布失败',
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.TeamProject': 'Shop',
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  useWorkbench.setState({
    config: {
      adoBase: 'http://ado/DefaultCollection',
      pat: '',
      auth: 'none',
      account: 'lus',
    },
  });

  try {
    const tool = createButlerTools().find((candidate) => candidate.name === 'draft_ado_state');
    assert.ok(tool);
    assert.equal(tool.effect, 'draft');

    const result = await tool.invoke(
      { workItemId: 123, targetState: 'Resolved' },
      { sessionId: 'session-ado-state' },
    );

    assert.equal(result.status, 'completed');
    assert.match(result.content ?? '', /#123.*Active.*Resolved/);
    assert.deepEqual(requests.map((request) => request.method), ['GET', 'GET']);
    assert.deepEqual(
      {
        kind: useButler.getState().actionDraft?.kind,
        workItemId: useButler.getState().actionDraft?.workItemId,
        currentState: useButler.getState().actionDraft?.currentState,
        targetState: useButler.getState().actionDraft?.targetState,
        expectedRevision: useButler.getState().actionDraft?.expectedRevision,
        adoIdentityId: useButler.getState().actionDraft?.adoIdentityId,
      },
      {
        kind: 'ado-state',
        workItemId: 123,
        currentState: 'Active',
        targetState: 'Resolved',
        expectedRevision: 7,
        adoIdentityId: '00000000-0000-0000-0000-000000000123',
      },
    );
    assert.deepEqual(requests, [
      {
        method: 'GET',
        url: 'http://ado/DefaultCollection/_apis/connectionData?api-version=7.0-preview',
      },
      {
        method: 'GET',
        url: 'http://ado/DefaultCollection/_apis/wit/workitems?ids=123&fields=System.Title,System.WorkItemType,System.Parent,System.State,System.TeamProject,System.AssignedTo,System.ChangedDate,Microsoft.VSTS.Common.Priority,Microsoft.VSTS.Scheduling.DueDate,Microsoft.VSTS.Scheduling.TargetDate,Microsoft.VSTS.Scheduling.FinishDate&api-version=7.0',
      },
    ]);
    assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'approval-required');
    assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.attempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('draft_ado_state 取不到稳定 identity id 时失败且不会生成确认卡', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData?api-version=7.0-preview')) {
      return new Response(JSON.stringify({
        authenticatedUser: {
          customDisplayName: 'lus',
          properties: { Account: { $value: 'lus' } },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`不应继续读取工作项：${url}`);
  }) as typeof fetch;
  useWorkbench.setState({
    config: {
      adoBase: 'http://ado/DefaultCollection',
      pat: '',
      auth: 'none',
      account: 'lus',
    },
  });

  try {
    const tool = createButlerTools().find((candidate) => candidate.name === 'draft_ado_state');
    assert.ok(tool);

    const result = await tool.invoke(
      { workItemId: 123, targetState: 'Resolved' },
      { sessionId: 'session-ado-state-missing-identity' },
    );

    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /稳定 id/);
    assert.equal(useButler.getState().actionDraft, null);
    assert.equal(useButler.getState().runtimeCheckpoints.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ADO 连接或账号在草案后改变时 preflight fail closed', async () => {
  useWorkbench.setState({
    config: {
      adoBase: 'http://ado/DefaultCollection',
      pat: '',
      auth: 'none',
      account: 'lus',
    },
  });
  useButler.getState().proposeAdoStateAction({
    workItemId: 123,
    workItemTitle: '修复发布失败',
    currentState: 'Active',
    targetState: 'Resolved',
    expectedRevision: 7,
    adoIdentityId: '00000000-0000-0000-0000-000000000123',
    project: 'Shop',
    webUrl: 'http://ado/DefaultCollection/Shop/_workitems/edit/123',
    adoBase: 'http://ado/DefaultCollection',
    adoAuth: 'none',
    adoAccount: 'lus',
  });
  useWorkbench.setState({
    config: {
      adoBase: 'http://ado/OtherCollection',
      pat: '',
      auth: 'none',
      account: 'other',
    },
  });

  const authorization = await useButler.getState().beginAction();
  assert.deepEqual(authorization, {
    allowed: false,
    reason: 'ADO 连接或账号已变化，请重新发起状态修改',
  });
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'failed');
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.attempts, 0);
});

test('ADO 能力未配置时 preflight 不会把 checkpoint 推进执行态', async () => {
  useWorkbench.setState({ config: null });
  useButler.setState({
    lines: [
      { id: 'welcome', role: 'assistant', text: '我是你的管家。消息、待办、日程、工作项都可以直接问我。' },
      { id: 'assistant-line', role: 'assistant', text: '建议创建一个 ADO 工作项。' },
    ],
  });

  useButler.getState().proposeAction('ado', 'assistant-line');
  const authorization = await useButler.getState().beginAction();
  const checkpoint = useButler.getState().runtimeCheckpoints.at(-1);

  assert.deepEqual(authorization, { allowed: false, reason: '请先在设置中配置 ADO 直连' });
  assert.equal(checkpoint?.status, 'failed');
  assert.equal(checkpoint?.attempts, 0, '能力预检失败不能算作一次执行尝试');
  assert.equal(checkpoint?.error?.kind, 'preflight');
});

test('ado-state 非可重试失败后，同一卡片二次 begin 不会再次进入写', async () => {
  useWorkbench.setState({
    config: {
      adoBase: 'http://ado/DefaultCollection',
      pat: '',
      auth: 'none',
      account: 'lus',
    },
  });
  useButler.getState().proposeAdoStateAction({
    workItemId: 123,
    workItemTitle: '修复发布失败',
    currentState: 'Active',
    targetState: 'Resolved',
    expectedRevision: 7,
    adoIdentityId: '00000000-0000-0000-0000-000000000123',
    project: 'Shop',
    webUrl: 'http://ado/DefaultCollection/Shop/_workitems/edit/123',
    adoBase: 'http://ado/DefaultCollection',
    adoAuth: 'none',
    adoAccount: 'lus',
  });

  assert.deepEqual(await useButler.getState().beginAction(), { allowed: true });
  await useButler.getState().failAction('结果未知，请重新读取新卡', false);
  const failed = useButler.getState().runtimeCheckpoints.at(-1);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.error?.retryable, false);

  const retried = await useButler.getState().beginAction();
  assert.deepEqual(retried, {
    allowed: false,
    reason: '结果未知，请重新读取新卡',
  });
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.status, 'failed');
  assert.equal(useButler.getState().runtimeCheckpoints.at(-1)?.attempts, 1);
});

test('completeAction 会记录 completed 审计证据而不只是本地成功提示', async () => {
  const entries: ButlerToolAuditEntry[] = [];
  const restoreAudit = setButlerToolAuditWriter((entry) => entries.push(entry));
  try {
    useButler.setState({
      lines: [
        { id: 'welcome', role: 'assistant', text: '我是你的管家。消息、待办、日程、工作项都可以直接问我。' },
        {
          id: 'assistant-line',
          role: 'assistant',
          text: '建议补一个待办记录。',
          sources: [{ kind: 'message', id: 'msg-2', mid: 'msg-2', rid: 'room-dev', label: '研发群消息' }],
        },
      ],
    });
    useButler.getState().proposeAction('todo', 'assistant-line');
    assert.ok(useButler.getState().actionDraft, '预期先生成动作草案');
    assert.deepEqual(await useButler.getState().beginAction(), { allowed: true });
    await useButler.getState().completeAction('已创建待办 todo-1');

    assert.ok(entries.some((entry) => entry.action === 'butler.tool.action.todo.completed'
      && entry.operationId === useButler.getState().runtimeCheckpoints.at(-1)?.id));
  } finally {
    restoreAudit();
  }
});

test('待执行写动作会持久化为可恢复 checkpoint', async () => {
  const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
  const restorePersistence = setButlerPersistence(appData);

  try {
    useAuth.setState({ user: { _id: 'u-checkpoint', username: 'checkpoint' } as never });
    await useButler.getState().hydrate();
    useButler.setState({
      lines: [
        { id: 'welcome', role: 'assistant', text: '我是你的管家。消息、待办、日程、工作项都可以直接问我。' },
        {
          id: 'assistant-line',
          role: 'assistant',
          text: '可以先起一个 ADO 工作项草案。',
          sources: [{ kind: 'work-item', id: '175', label: '#175', webUrl: 'https://ado.example/175' }],
        },
      ],
    });

    useButler.getState().proposeAction('ado', 'assistant-line');
    const beforeRestart = useButler.getState().actionDraft;
    assert.ok(beforeRestart, '预期先持有待恢复草案');

    await flushButlerPersist();
    useButler.getState().reset();
    resetButlerPersistenceForTests();

    useAuth.setState({ user: { _id: 'u-checkpoint', username: 'checkpoint' } as never });
    await useButler.getState().hydrate();

    assert.deepEqual(
      useButler.getState().actionDraft,
      beforeRestart,
      'P4 合同要求多步写动作重启后仍可从 checkpoint 恢复',
    );
  } finally {
    restorePersistence();
  }
});

test('rounds 建议点击批准后走同一 checkpoint，重复执行不会重复写入', async () => {
  const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
  const restorePersistence = setButlerPersistence(appData);
  try {
    useAuth.setState({ user: { _id: 'u-rounds-runtime', username: 'rounds' } as never });
    await useButler.getState().hydrate();
    const checkpoint = createButlerProposalCheckpoint({
      kind: 'schedule-today',
      ref: 'todo:t-1',
      reason: '今天处理',
    }, {
      action: 'accept',
      generatedAt: '2026-07-23T09:00:00.000Z',
      today: '2026-07-23',
      now: 123,
    });
    let writes = 0;
    const execute = () => {
      writes += 1;
      return 'applied' as const;
    };

    assert.equal(await executeApprovedButlerOperation(checkpoint, execute), 'applied');
    assert.equal(await executeApprovedButlerOperation(checkpoint, execute), 'applied');
    assert.equal(writes, 1);
    assert.equal(
      useButler.getState().runtimeCheckpoints.find((item) => item.id === checkpoint.id)?.status,
      'completed',
    );
  } finally {
    restorePersistence();
  }
});

test('running checkpoint 重启后持久恢复为 failed，且不会自动重放副作用', async () => {
  const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
  const restorePersistence = setButlerPersistence(appData);
  try {
    useAuth.setState({ user: { _id: 'u-runtime-recovery', username: 'recovery' } as never });
    await useButler.getState().hydrate();
    useButler.setState({
      lines: [
        { id: 'welcome', role: 'assistant', text: '我是你的管家。消息、待办、日程、工作项都可以直接问我。' },
        { id: 'assistant-line', role: 'assistant', text: '建议创建一个待办。' },
      ],
    });
    useButler.getState().proposeAction('todo', 'assistant-line');
    assert.deepEqual(await useButler.getState().beginAction(), { allowed: true });
    const checkpointId = useButler.getState().actionDraft?.checkpointId;
    assert.ok(checkpointId);
    await flushButlerPersist();

    useButler.getState().reset();
    resetButlerPersistenceForTests();
    await useButler.getState().hydrate();
    const recovered = useButler.getState().runtimeCheckpoints.find((item) => item.id === checkpointId);
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.error?.kind, 'recovery');
    assert.equal(useButler.getState().actionDraft?.checkpointId, checkpointId);

    useButler.getState().reset();
    resetButlerPersistenceForTests();
    await useButler.getState().hydrate();
    assert.equal(
      useButler.getState().runtimeCheckpoints.find((item) => item.id === checkpointId)?.status,
      'failed',
    );
  } finally {
    restorePersistence();
  }
});
