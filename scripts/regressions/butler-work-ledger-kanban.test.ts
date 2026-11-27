import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const persistedLedger = new Map<string,string>();
Object.defineProperty(globalThis, 'localStorage', { configurable:true, value: {
  getItem:(key:string) => persistedLedger.get(key) ?? null,
  setItem:(key:string,value:string) => { persistedLedger.set(key,value); },
  removeItem:(key:string) => { persistedLedger.delete(key); },
} });

import {
  buildSessionContextImportSpec,
  checkSessionDispatchEligibility,
  CODEX_CAPABILITIES,
  DSH_CAPABILITIES,
  evaluateSessionControlMode,
} from '../../apps/web/src/agent/sessionAdapter';
import {
  correlateExternalEvent,
  evaluateCardCompletionGate,
  evaluateEventDispatchDecision,
  reconcilePendingDispatchActions,
  verifyExternalEventAgainstLiveState,
} from '../../apps/web/src/agent/workCoordinator';
import type {
  NativeDispatchActionRecord,
  NativeWorkCard,
  NativeWorkEvidence,
  NativeWorkLink,
  NativeWorkSessionRecord,
} from '../../apps/web/src/platform/desktopCommands';
import { extractAdoStructuredEvent } from '../../services/ado-bridge/src/transform';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';

function sampleCard(overrides: Partial<NativeWorkCard> = {}): NativeWorkCard {
  const now = 1_700_000_000_000;
  return {
    id: 'card-1',
    source: 'ado',
    rid: 'room-1',
    mid: null,
    adoWorkItemId: 292,
    adoProject: 'RocketX',
    title: '实现外部反馈闭环与统一工作看板',
    note: null,
    roomName: 'devops-room',
    author: 'alice',
    done: false,
    priority: 2,
    due: null,
    createdAt: now,
    doneAt: null,
    updatedAt: now,
    committedTo: null,
    waitingFor: null,
    ...overrides,
    state: {
      todoId: overrides.id ?? 'card-1',
      visibility: 'room_shared',
      stage: 'in_progress',
      waitState: 'none',
      waitReason: null,
      goal: '闭环处理 PR 与 CI 反馈',
      requirementsVersion: 1,
      contentVersion: 0,
      ownerKind: 'ai_dispatched',
      projectKey: 'RocketX',
      environmentId: null,
      acceptance: ['CI 构建通过', '单元测试全部通过'],
      boundaries: [],
      dependsOn: [],
      nextStep: '等待 CI 结果',
      nextCheckAt: null,
      lastVerifiedAt: now,
      autonomyMode: 'autonomous',
      maxAutoTurns: 3,
      autoTurnsUsed: 1,
      consecutiveFailures: 0,
      revokedAt: null,
      updatedAt: now,
      ...(overrides.state ?? {}),
    },
  };
}

function sampleSession(
  overrides: Partial<NativeWorkSessionRecord> = {},
): NativeWorkSessionRecord {
  const now = 1_700_000_000_000;
  return {
    id: 'session-1',
    todoId: 'card-1',
    visibility: 'room_shared',
    runtime: 'codex',
    origin: 'rocketx_managed',
    nativeSessionId: 'codex-thread-1',
    title: '修复 #292 构建问题',
    workspaceRoot: 'D:/Repos/rocketchatx',
    environmentId: null,
    accountScope: null,
    controlEndpoint: 'app-server://local',
    controlMode: 'controllable',
    controlReason: 'owned_live_controller',
    hostDeviceId: 'device-local',
    writerLeaseOwner: 'rocketx:local',
    writerLeaseExpiresAt: now + 60_000,
    runtimeStatus: 'idle',
    configSnapshotJson: null,
    lastEventSeq: 10,
    lastTurnId: 'turn-10',
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('Session 适配层：显式声明 Codex/DSH 能力矩阵，且外部进程占用或日志损坏时严守只读不抢锁', () => {
  assert.equal(CODEX_CAPABILITIES.steerActiveTurn, true);
  assert.equal(DSH_CAPABILITIES.steerActiveTurn, false);
  assert.equal(CODEX_CAPABILITIES.coldResume, true);
  assert.equal(DSH_CAPABILITIES.coldResume, true);

  const occupied = evaluateSessionControlMode({
    runtime: 'codex',
    nativeSessionId: 'cli-thread-99',
    origin: 'native_cli',
    workspaceRoot: 'D:/Repos/rocketchatx',
    workspaceExists: true,
    externalWriterActive: true,
  });
  assert.equal(occupied.controlMode, 'readonly');
  assert.equal(occupied.controlReason, 'active_external_writer');
  assert.equal(occupied.canSendPromptDirectly, false);
  assert.equal(occupied.canImportContextToNewSession, true);

  const corrupt = evaluateSessionControlMode({
    runtime: 'dsh',
    nativeSessionId: 'dsh-partial-1',
    workspaceRoot: 'D:/Repos/rocketchatx',
    logIntegrity: 'partial',
  });
  assert.equal(corrupt.controlMode, 'readonly');
  assert.equal(corrupt.controlReason, 'corrupt_or_partial_log');

  const resumable = evaluateSessionControlMode({
    runtime: 'codex',
    nativeSessionId: 'codex-stopped-2',
    workspaceRoot: 'D:/Repos/rocketchatx',
    workspaceExists: true,
    hasOwnedLiveController: false,
    externalWriterActive: false,
  });
  assert.equal(resumable.controlMode, 'resumable');
  assert.equal(resumable.canColdResume, true);
});

test('外部反馈回路：ADO 结构化事件提取、三级关联、乱序旧构建抑制与暂停水位拦截', () => {
  const adoPayload = {
    id: 'evt-build-100',
    eventType: 'build.complete',
    createdDate: '2026-07-26T10:00:00Z',
    message: { text: 'Build 100 failed' },
    resource: {
      id: 100,
      buildNumber: '20260726.1',
      result: 'failed',
      sourceBranch: 'refs/heads/ai/292-fix-ci',
      sourceVersion: 'sha-100',
      project: { name: 'RocketX' },
      definition: { id: 7, name: 'CI' },
    },
  };
  const structured = extractAdoStructuredEvent(adoPayload);
  assert.ok(structured);
  assert.equal(structured.buildId, 100);
  assert.equal(structured.project, 'RocketX');
  assert.equal(structured.commitSha, 'sha-100');

  const card = sampleCard();
  const links: NativeWorkLink[] = [
    {
      id: 'link-branch',
      todoId: card.id,
      kind: 'git_branch',
      externalId: 'ai/292-fix-ci',
      project: 'RocketX',
      repo: 'rocketchatx',
      rid: null,
      headSha: 'sha-100',
      title: 'ai/292-fix-ci',
      webUrl: null,
      stateSnapshot: 'active',
      lastVerifiedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
    },
  ];

  const exactMatch = correlateExternalEvent(structured, [card], links);
  assert.equal(exactMatch.todoId, card.id);
  assert.equal(exactMatch.tier, 'exact');

  // 当同一定义+项目已有更新的 Build #101 成功时，旧的 Build #100 失败事件应被判定为 stale
  const staleCheck = verifyExternalEventAgainstLiveState(
    {
      eventType: 'build.complete',
      project: 'RocketX',
      buildId: 100,
      commitSha: 'sha-100',
      occurredAt: Date.parse('2026-07-26T10:00:00Z'),
    },
    card,
    {
      recentBuilds: [
        {
          id: 101,
          buildNumber: '20260726.2',
          status: 'completed',
          result: 'succeeded',
          definition: 'CI',
          project: 'RocketX',
          sourceBranch: 'refs/heads/ai/292-fix-ci',
          finishTime: '2026-07-26T10:05:00Z',
        },
      ],
    },
  );
  assert.equal(staleCheck.stale, true);
  assert.match(staleCheck.reason, /#20260726\.2/);

  // 用户暂停/撤销自动跟进后，早于水位线的迟到事件不得再次唤醒任务
  const revokedCard = sampleCard({
    state: {
      ...card.state,
      waitState: 'paused',
      revokedAt: Date.parse('2026-07-26T10:10:00Z'),
    },
  });
  const revokedCheck = verifyExternalEventAgainstLiveState(
    {
      eventType: 'git.pullrequest.updated',
      project: 'RocketX',
      buildId: null,
      commitSha: 'sha-102',
      occurredAt: Date.parse('2026-07-26T10:08:00Z'),
    },
    revokedCard,
  );
  assert.equal(revokedCheck.stale, true);
  assert.match(revokedCheck.reason, /revoked_at/);
});

test('崩溃恢复对账：重启后先对比 Session 最新事件水位线，已送达动作不重复发送', () => {
  const sessionAdvanced = sampleSession({
    id: 'session-advanced',
    lastEventSeq: 15,
    lastTurnId: 'turn-15',
  });
  const sessionUnchanged = sampleSession({
    id: 'session-unchanged',
    lastEventSeq: 10,
    lastTurnId: 'turn-10',
  });

  const actions: NativeDispatchActionRecord[] = [
    {
      id: 'act-1',
      idempotencyKey: 'evt-1:session-advanced:prompt',
      todoId: 'card-1',
      eventId: 'evt-1',
      sessionId: 'session-advanced',
      actionKind: 'session_prompt',
      specJson: '{}',
      baselineMarker: 'seq:10',
      state: 'verifying_delivery',
      receiptRef: null,
      errorMessage: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    },
    {
      id: 'act-2',
      idempotencyKey: 'evt-2:session-unchanged:prompt',
      todoId: 'card-1',
      eventId: 'evt-2',
      sessionId: 'session-unchanged',
      actionKind: 'session_prompt',
      specJson: '{}',
      baselineMarker: 'seq:10',
      state: 'verifying_delivery',
      receiptRef: null,
      errorMessage: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    },
  ];

  const outcomes = reconcilePendingDispatchActions(actions, [
    sessionAdvanced,
    sessionUnchanged,
  ]);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].actionId, 'act-1');
  assert.equal(outcomes[0].nextState, 'verifying_delivery');
  assert.equal(outcomes[1].actionId, 'act-2');
  assert.equal(outcomes[1].nextState, 'verifying_delivery');
});

test('隐私防火墙与外部占用降级：私密任务禁止派发到房间共享会话，只读会话支持安全导入上下文', () => {
  const privateCard = sampleCard({
    state: {
      ...sampleCard().state,
      visibility: 'private',
    },
  });
  const sharedSession = sampleSession({
    visibility: 'room_shared',
  });

  const privacyEligibility = checkSessionDispatchEligibility(
    sharedSession,
    privateCard.state.visibility,
    'session_prompt',
  );
  assert.equal(privacyEligibility.allowed, false);
  assert.match(privacyEligibility.reason, /隐私保护拦截/);

  const readonlySession = sampleSession({
    visibility: 'private',
    controlMode: 'readonly',
    controlReason: 'active_external_writer',
  });
  const decision = evaluateEventDispatchDecision(
    {
      id: 'ev-1',
      dedupeKey: 'k-1',
      source: 'ado_webhook',
      eventType: 'ms.vss-code.git-pullrequest-comment-event',
      resourceKey: 'ado:pr:RocketX:88',
      resourceVersion: 2,
      project: 'RocketX',
      repo: 'rocketchatx',
      branch: 'ai/292-fix',
      commitSha: 'sha-2',
      workItemId: 292,
      prId: 88,
      buildId: null,
      rid: null,
      todoId: privateCard.id,
      correlationTier: 'exact',
      payloadJson: '{"comment":"请补充空指针判断"}',
      status: 'correlated',
      statusDetail: null,
      occurredAt: 1_700_000_005_000,
      processedAt: null,
    },
    privateCard,
    [readonlySession],
    { stale: false, reason: 'ok' },
  );

  assert.equal(decision.decision, 'blocked_readonly_session');
  assert.equal(decision.suggestImportFromSessionId, readonlySession.id);
  assert.match(decision.specText, /<rocketx_task_spec>/);
  assert.match(decision.specText, /<rocketx_untrusted_evidence>/);

  const importedSpec = buildSessionContextImportSpec({
    sourceSession: readonlySession,
    cardGoal: privateCard.title,
    recentTranscriptExcerpt: '上次修改了 transform.ts',
    nextInstruction: '处理评审意见',
  });
  assert.match(importedSpec, /<rocketx_task_spec>/);
  assert.match(importedSpec, /<rocketx_untrusted_evidence>/);
});

test('验收证据门禁：Session 空闲或证据过期时禁止直接标记已完成，且保留统一看板与 SQLite 账本接线', () => {
  const card = sampleCard({
    state: {
      ...sampleCard().state,
      stage: 'verifying',
    },
  });

  const staleEvidence: NativeWorkEvidence = {
    id: 'evd-1',
    todoId: card.id,
    sessionId: 'session-1',
    kind: 'ci_build',
    title: 'CI Build #100 Passed',
    summary: null,
    headSha: 'sha-1',
    workspaceRoot: null,
    webUrl: null,
    passed: true,
    stale: true,
    staleReason: 'head_sha_changed',
    verifiedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
  };

  const gateWithStaleOnly = evaluateCardCompletionGate(card, [staleEvidence], false);
  assert.equal(gateWithStaleOnly.canMarkDone, false);
  assert.equal(gateWithStaleOnly.recommendedStage, 'verifying');
  assert.match(gateWithStaleOnly.reason, /当前版本/);

  const freshEvidence: NativeWorkEvidence = {
    ...staleEvidence,
    id: 'evd-2',
    headSha: 'sha-2',
    stale: false,
    staleReason: null,
    requirementsVersion: 1,
    contentVersion: 0,
    criterionIds: card.state.acceptance,
  };
  const gateWithFresh = evaluateCardCompletionGate(
    card,
    [staleEvidence, freshEvidence],
    false,
  );
  assert.equal(gateWithFresh.canMarkDone, true);
  assert.equal(gateWithFresh.recommendedStage, 'done');

  const todosPageSource = readFileSync(
    new URL('../../apps/web/src/pages/TodosPage.tsx', import.meta.url),
    'utf8',
  );
  assert.match(todosPageSource, /t\('pages\.todos\.butlerKanbanTitle'\)/);
  assert.match(zhCN['pages.todos.butlerKanbanTitle'], /统一看板/);
  assert.ok(enUS['pages.todos.butlerKanbanTitle'].trim());
  assert.match(todosPageSource, /t\('pages\.todos\.advanceInKanbanTitle'\)/);
  assert.match(zhCN['pages.todos.advanceInKanbanTitle'], /统一看板/);
  assert.ok(enUS['pages.todos.advanceInKanbanTitle'].trim());
  assert.match(todosPageSource, /WorkKanbanBoard/);
});

import { executeRocketxDynamicTool } from '../../apps/web/src/agent/codexHostTools';
import {
  parseChatMessageAsExternalEvent,
  setSuperAgentRuntimeDriversForTests,
  spawnCardWorkerInWorktree,
} from '../../apps/web/src/agent/superAgentBridge';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

test('Super Agent 零 Token 预过滤器：忽略普通群聊，精确提取 ADO 构建/PR 通知卡片', () => {
  const normalChat = parseChatMessageAsExternalEvent({
    _id: 'msg-human-1',
    rid: 'room-dev',
    msg: '大家中午吃什么？',
    ts: new Date('2026-07-26T12:00:00Z').toISOString(),
    u: { _id: 'u-1', username: 'bob', name: 'Bob' },
  } as never);
  assert.equal(normalChat, null);

  const adoWebhookMsg = parseChatMessageAsExternalEvent({
    _id: 'msg-ado-415',
    rid: 'room-dev',
    alias: 'Azure DevOps',
    msg: 'Build 415 failed',
    ts: new Date('2026-07-26T12:05:00Z').toISOString(),
    u: { _id: 'bot-1', username: 'devops-bot' },
    attachments: [
      {
        title: '🏗️ 构建完成',
        title_link: 'https://ado.example.com/DefaultCollection/RocketX/_build/results?buildId=415',
        text: 'PR #88 分支 refs/heads/ai/292-super-agent 构建失败 (commit a1b2c3d4)',
      },
    ],
  } as never);

  assert.ok(adoWebhookMsg);
  assert.equal(adoWebhookMsg.dedupeKey, 'rc-msg:msg-ado-415');
  assert.equal(adoWebhookMsg.eventType, 'build.complete');
  assert.equal(adoWebhookMsg.project, 'RocketX');
  assert.equal(adoWebhookMsg.prId, 88);
  assert.equal(adoWebhookMsg.buildId, 415);
  assert.equal(adoWebhookMsg.branch, 'ai/292-super-agent');
});

test('Super Agent Worktree 隔离派工与宿主动态工具：从只读会话安全拉起隔离 Worker 并通过证据门禁', async () => {
  useTodos.setState({
    todos: [
      {
        id: 'todo-sa-1',
        source: 'ado',
        adoWorkItemId: 400,
        adoProject: 'RocketX',
        title: '实现 Super Agent Worktree 隔离调度',
        done: false,
        priority: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ],
  });
  useWorkLedger.setState({
    cards: [],
    links: [],
    sessions: [],
    evidences: [],
    events: [],
    actions: [],
  });
  useWorkLedger.getState().syncWithTodos();
  await useWorkLedger.getState().updateCard('todo-sa-1', {
    enroll:true, goal:'修复构建并补齐单测', acceptance:['回归测试通过'],
  });

  // 先挂载一个被外部终端占用的只读会话
  const readonlySess = await useWorkLedger.getState().upsertSession({
    todoId: 'todo-sa-1',
    visibility: 'room_shared',
    runtime: 'codex',
    origin: 'native_cli',
    nativeSessionId: 'cli-occupied-1',
    title: '终端本地会话',
    workspaceRoot: 'D:/Repos/rocketchatx',
    environmentId: null,
    accountScope: null,
    controlEndpoint: null,
    controlMode: 'readonly',
    controlReason: 'active_external_writer',
    hostDeviceId: 'local',
    writerLeaseOwner: 'external:cli',
    writerLeaseExpiresAt: null,
    runtimeStatus: 'running',
    configSnapshotJson: null,
    lastEventSeq: 3,
    lastTurnId: null,
  });

  const worktreeCalls: string[] = [];
  const spawnedSpecs: string[] = [];
  const restoreDrivers = setSuperAgentRuntimeDriversForTests({
    isDesktop: () => true,
    prepareWorktree: async ({ branchName }) => {
      worktreeCalls.push(branchName);
      return {
        worktreePath: 'C:/AppData/RocketX/worktrees/ab12cd/card-todo-sa',
        repoTopLevel: 'D:/Repos/rocketchatx',
        branch: branchName,
        headSha: 'deadbeef1234',
        reused: false,
      };
    },
    startCodexWorkerTask: async ({ workspaceRoot, specText }) => {
      assert.equal(workspaceRoot, 'C:/AppData/RocketX/worktrees/ab12cd/card-todo-sa');
      spawnedSpecs.push(specText);
      return { threadId: 'codex-worker-wt-1' };
    },
  });

  try {
    const dispatchRes = await spawnCardWorkerInWorktree({
      todoId: 'todo-sa-1',
      instruction: '在独立 Worktree 中修复构建并补齐单测',
      isolateWorktree: true,
      importFromSessionId: readonlySess.id,
      repoRootOverride: 'D:/Repos/rocketchatx',
    });

    assert.equal(dispatchRes.ok, true);
    assert.equal(worktreeCalls[0], 'ai/400');
    assert.equal(dispatchRes.action.state, 'acknowledged');
    assert.equal(dispatchRes.action.receiptRef, 'pi:thread:codex-worker-wt-1');
    assert.equal(dispatchRes.session?.runtime, 'pi');
    assert.equal(dispatchRes.session?.controlMode, 'controllable');
    assert.match(spawnedSpecs[0], /<rocketx_task_spec>/);
    assert.match(spawnedSpecs[0], /<rocketx_untrusted_evidence>/);

    const afterSpawnCard = useWorkLedger.getState().cards.find((c) => c.id === 'todo-sa-1')!;
    assert.equal(afterSpawnCard.state.stage, 'in_progress');
    assert.equal(afterSpawnCard.state.ownerKind, 'ai_dispatched');

    // 验证宿主动态工具：无证据时尝试置为 done 会被拒绝，登记证据后成功流转至 done
    const blockedDone = await executeRocketxDynamicTool({
      tool: 'update_work_card',
      arguments: { todoId: 'todo-sa-1', stage: 'done' },
    });
    assert.equal(blockedDone.success, false);

    const recordEv = await executeRocketxDynamicTool({
      tool: 'record_work_evidence',
      arguments: {
        todoId: 'todo-sa-1',
        kind: 'test_run',
        title: 'Worktree 回归测试全部通过',
        headSha: 'deadbeef1234',
        passed: true,
        criterionIds: ['回归测试通过'],
        requirementsVersion: afterSpawnCard.state.requirementsVersion,
        contentVersion: afterSpawnCard.state.contentVersion,
      },
    });
    assert.equal(recordEv.success, true);

    const declaredDone = await executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: 'todo-sa-1', stage: 'done' } });
    assert.equal(declaredDone.success, false, 'Agent 声明不能冒充宿主执行证据');
    await useWorkLedger.getState().addEvidence({ todoId: 'todo-sa-1', sessionId: null, kind: 'test_run', title: '受控宿主测试结果', summary: '此fixture模拟宿主已观察到的测试结果，非模型声明', passed: true,
      headSha: 'deadbeef1234', workspaceRoot: 'C:/AppData/RocketX/worktrees/ab12cd/card-todo-sa', webUrl: null,
      criterionIds: ['回归测试通过'], requirementsVersion: afterSpawnCard.state.requirementsVersion, contentVersion: afterSpawnCard.state.contentVersion });

    const reportedDone = await executeRocketxDynamicTool({
      tool: 'update_work_card',
      arguments: { todoId: 'todo-sa-1', stage: 'done' },
    });
    assert.equal(reportedDone.success, true);
    assert.equal(
      useWorkLedger.getState().cards.find((c) => c.id === 'todo-sa-1')?.state.stage,
      'done',
    );
  } finally {
    restoreDrivers();
  }

  const portalSource = readFileSync(
    new URL('../../apps/web/src/components/WorkCardPortal.tsx', import.meta.url),
    'utf8',
  );
  assert.match(portalSource, /t\('agent\.portal\.spawnWorktreeBtn'\)/);
  assert.match(zhCN['agent.portal.spawnWorktreeBtn'], /隔离 Worktree 派工/);
  assert.ok(enUS['agent.portal.spawnWorktreeBtn'].trim());
  assert.match(portalSource, /t\('agent\.portal\.gitSnapshotHeading'\)/);
  assert.match(zhCN['agent.portal.gitSnapshotHeading'], /工作区 Git 实时快照/);
  assert.ok(enUS['agent.portal.gitSnapshotHeading'].trim());

  const kernelHostSource = readFileSync(
    new URL('../../apps/web/src/lib/kernelHost.ts', import.meta.url),
    'utf8',
  );
  assert.match(kernelHostSource, /startSuperAgentBridge/);
});
