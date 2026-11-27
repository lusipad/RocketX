import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abortRoundtableRun,
  dispatchRoundtableDecisionToWork,
  handleRoomAiParticipantMessage,
  setRoomAiButlerRunner,
  skipCurrentRoundtableSeat,
  startRoomAiParticipantBridge,
  useRoundtableLiveState,
} from '../../apps/web/src/agent/roomAiParticipantRuntime';
import {
  cleanupCardManagedWorktree,
  IDLE_WORKTREE_TTL_MS,
  planSafeExecutionWorkspace,
  setWorktreeLifecycleDriversForTests,
  sweepIdleManagedWorktrees,
} from '../../apps/web/src/agent/worktreeLifecycle';
import {
  formatAiDiscussionHandoffDraft,
  readAiParticipantDrag,
  writeAiParticipantDrag,
} from '../../apps/web/src/lib/butlerChatBridge';
import {
  formatDecisionBlock,
  inferHostedAgentRole,
  parseDecisionBlockFromBody,
  parseHostedAgentAnswer,
} from '../../apps/web/src/lib/hostedAgentAnswer';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useButlerRoomBindings } from '../../apps/web/src/stores/butlerRoomBindings';
import { useButlerSkills } from '../../apps/web/src/stores/butlerSkills';
import { useChat } from '../../apps/web/src/stores/chat';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import {
  createDefaultRoundtableSeats,
  useRoomAiParticipants,
} from '../../apps/web/src/stores/roomAiParticipants';
import { beginWorkLedgerAccount, useWorkLedger } from '../../apps/web/src/stores/workLedger';

function installMemoryStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
  });
}

function createMockDataTransfer(): DataTransfer {
  const bag = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types() {
      return [...bag.keys()];
    },
    setData: (mime: string, value: string) => {
      bag.set(mime, value);
    },
    getData: (mime: string) => bag.get(mime) ?? '',
  } as unknown as DataTransfer;
}

function resetTestEnv(): Array<{ text: string; rid: string; tmid?: string }> {
  installMemoryStorage();
  setRoomAiButlerRunner(null);
  setWorktreeLifecycleDriversForTests(null);
  const doneAccount = beginWorkLedgerAccount('local');
  doneAccount();
  const sentMessages: Array<{ text: string; rid: string; tmid?: string }> = [];

  useAuth.setState({
    user: { _id: 'u-alice', username: 'alice', name: 'Alice' } as never,
    localMode: false,
  });
  useCodexWorkspace.setState({
    workspaceRoot: 'd:/Repos/rocketchatx',
    butlerWorkspaceRoot: 'd:/Repos/rocketchatx-butler',
    defaultWorkspaceRoot: 'd:/Repos/rocketchatx',
    status: 'ready',
  });
  useButlerSkills.setState({
    accountScope: 'u-alice@same-origin',
    skills: [],
    hydrated: true,
    loading: false,
    error: null,
  });
  useButlerRoomBindings.setState({
    accountScope: 'u-alice@same-origin',
    hydrated: true,
    bindings: [],
  });
  useWorkLedger.setState({
    cards: [],
    links: [],
    sessions: [],
    evidences: [],
    events: [],
    actions: [],
    hydrated: true,
    loading: false,
    lastError: null,
  });
  useRoomAiParticipants.setState({
    accountScope: 'u-alice@same-origin',
    hydrated: true,
    participants: {},
  });
  useRoundtableLiveState.setState({ runs: {} });
  useChat.setState({
    subscriptions: {
      'disc-rt-1': { rid: 'disc-rt-1', prid: 'grp-dev', t: 'p', name: 'rt-feature', fname: '定时提醒圆桌讨论' } as never,
      'grp-dev': { rid: 'grp-dev', t: 'p', name: 'eng-main', fname: '研发主群' } as never,
    },
    rooms: {
      'disc-rt-1': { _id: 'disc-rt-1', prid: 'grp-dev', t: 'p', name: 'rt-feature', fname: '定时提醒圆桌讨论' } as never,
      'grp-dev': { _id: 'grp-dev', t: 'p', name: 'eng-main', fname: '研发主群' } as never,
    },
    messages: {
      'disc-rt-1': [],
      'grp-dev': [],
    },
    send: async (text, opts) => {
      const rid = opts?.rid ?? 'disc-rt-1';
      const entry = { text, rid, tmid: opts?.tmid };
      sentMessages.push(entry);
      const nextMsg = {
        _id: `bot-${sentMessages.length}`,
        rid,
        tmid: opts?.tmid,
        msg: text,
        ts: new Date().toISOString(),
        u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
      };
      useChat.setState((state) => ({
        messages: {
          ...state.messages,
          [rid]: [...(state.messages[rid] ?? []), nextMsg as never],
        },
      }));
      return { delivery: 'server', message: nextMsg } as never;
    },
  });

  return sentMessages;
}

test('多角色圆桌：按产品 -> 架构 -> 挑刺官 -> 主理人接力输出，并解析结构化《决议卡》', async () => {
  const sent = resetTestEnv();
  const seenPromptsByRole: Array<{ role: string; prompt: string }> = [];

  setRoomAiButlerRunner(async ({ seat, prompt }) => {
    const role = seat?.roleId ?? 'solo';
    seenPromptsByRole.push({ role, prompt });
    if (role === 'product') {
      return { text: '- 核心价值：防止遗漏重要群消息\n- 一期不做：复杂跨日历同步' };
    }
    if (role === 'architect') {
      return { text: '- 建议复用 `apps/web/src/stores/routines.ts` 与 `ChatArea.tsx` 触发器' };
    }
    if (role === 'contrarian') {
      return { text: '- 反方风险：不要轮询全部频道，谨防高频打扰与状态不同步' };
    }
    return {
      text: [
        '已完成团队收敛，建议先走轻量方案并保留工作卡执行边界。',
        formatDecisionBlock({
          title: '群消息定时跟进提醒',
          consensus: ['第一期只聚焦单群关键词/指定人提醒', '讨论阶段只读查码，拍板后走 WorkCard'],
          contention: '复用 routines 触发器 vs 新建独立提醒表',
          options: [
            { id: 'opt-a', label: '方案 A：复用 routines.ts（改动小、立即可用）', recommended: true },
            { id: 'opt-b', label: '方案 B：拆独立提醒存储表' },
          ],
          targetFiles: ['apps/web/src/stores/routines.ts', 'apps/web/src/components/ChatArea.tsx'],
          acceptance: ['pnpm typecheck', 'pnpm test:regression'],
        }),
      ].join('\n\n'),
    };
  });

  useRoomAiParticipants.getState().enrollRoom({
    rid: 'disc-rt-1',
    isDiscussion: true,
    mode: 'roundtable',
    seats: createDefaultRoundtableSeats(),
    agentKind: 'pi_butler',
    agentId: 'pi_butler',
    agentName: 'AI 圆桌智囊团',
    workspaceRoot: 'd:/Repos/rocketchatx',
  });

  const stop = startRoomAiParticipantBridge();
  try {
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'disc-rt-1': [
          {
            _id: 'u-msg-1',
            rid: 'disc-rt-1',
            msg: '我想做一个群消息定时提醒并自动跟进的功能',
            ts: new Date('2026-11-27T01:00:00Z').toISOString(),
            u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
          } as never,
        ],
      },
    }));

    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      seenPromptsByRole.map((x) => x.role),
      ['product', 'architect', 'contrarian', 'captain'],
    );
    // 挑刺官与主理人 Prompt 中必须能看到前序角色观点，形成真实辩论而非各自盲说
    assert.match(seenPromptsByRole[2].prompt, /核心价值：防止遗漏重要群消息/);
    assert.match(seenPromptsByRole[3].prompt, /反方风险：不要轮询全部频道/);

    assert.equal(sent.length, 4);
    assert.equal(inferHostedAgentRole('挑刺官'), 'contrarian');
    const captainParsed = parseHostedAgentAnswer(sent[3].text);
    assert.ok(captainParsed);
    assert.equal(inferHostedAgentRole(captainParsed.provider, captainParsed.note), 'captain');
    const decisionParsed = parseDecisionBlockFromBody(captainParsed.body);
    assert.ok(decisionParsed.decision);
    assert.equal(decisionParsed.decision.title, '群消息定时跟进提醒');
    assert.equal(decisionParsed.decision.options.length, 2);
    assert.ok(!decisionParsed.cleanBody.includes('rcx-decision'));

    // 拖动整个圆桌进普通群聊时，只带去收敛后的决议摘要，不泄露前面冗长草稿
    const participantState = useRoomAiParticipants.getState().participants['disc-rt-1'];
    assert.ok(participantState.latestDecisionSummary?.includes('群消息定时跟进提醒'));
    const dt = createMockDataTransfer();
    writeAiParticipantDrag(dt, {
      source: 'ai_discussion',
      mode: participantState.mode,
      seats: participantState.seats,
      agentKind: participantState.agentKind,
      agentId: participantState.agentId,
      agentName: participantState.agentName,
      discussionRid: 'disc-rt-1',
      discussionName: '定时提醒圆桌讨论',
      decisionSummary: participantState.latestDecisionSummary,
    });
    const dragPayload = readAiParticipantDrag(dt);
    assert.ok(dragPayload);
    const handoffDraft = formatAiDiscussionHandoffDraft(dragPayload);
    assert.match(handoffDraft, /群消息定时跟进提醒/);
    assert.doesNotMatch(handoffDraft, /反方风险/);
  } finally {
    stop();
    setRoomAiButlerRunner(null);
  }
});

test('中途跳过/插话打断、定向 @角色 路由，以及拖入普通大群后零噪音协作', async () => {
  const sent = resetTestEnv();
  const calledRoles: string[] = [];

  setRoomAiButlerRunner(async ({ seat, instruction }) => {
    const role = seat?.roleId ?? 'solo';
    calledRoles.push(`${role}:${instruction}`);
    if (role === 'architect') {
      await new Promise((r) => setTimeout(r, 80));
    }
    return { text: `${role} -> ${instruction}` };
  });

  useRoomAiParticipants.getState().enrollRoom({
    rid: 'disc-rt-1',
    isDiscussion: true,
    mode: 'roundtable',
    seats: createDefaultRoundtableSeats(),
    agentKind: 'pi_butler',
    agentId: 'pi_butler',
    agentName: 'AI 圆桌智囊团',
    workspaceRoot: 'd:/Repos/rocketchatx',
  });

  const stop = startRoomAiParticipantBridge();
  try {
    // 1) 发起圆桌并在 architect 环节点击跳过
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'disc-rt-1': [
          {
            _id: 'rt-steer-1',
            rid: 'disc-rt-1',
            msg: '议题一：设计多群消息聚合卡片',
            ts: new Date().toISOString(),
            u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
          } as never,
        ],
      },
    }));

    await new Promise((r) => setTimeout(r, 25));
    const skipped = skipCurrentRoundtableSeat('disc-rt-1');
    assert.equal(skipped, true);
    await new Promise((r) => setTimeout(r, 90));
    // product, contrarian, captain 应完成发帖；architect 被跳过不发帖
    assert.equal(sent.length, 3);
    assert.ok(!sent.some((m) => m.text.includes('architect ->')));

    // 2) 中途发人类纠偏插话，立刻打断上一轮未结束的圆桌
    const abortTestSentBefore = sent.length;
    setRoomAiButlerRunner(async ({ seat, instruction }) => {
      calledRoles.push(`v2:${seat?.roleId}:${instruction}`);
      if (instruction.includes('旧方向') && seat?.roleId === 'product') {
        await new Promise((r) => setTimeout(r, 120));
      }
      return { text: `${seat?.roleId} -> ${instruction}` };
    });

    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'disc-rt-1': [
          ...(state.messages['disc-rt-1'] ?? []),
          {
            _id: 'rt-old',
            rid: 'disc-rt-1',
            msg: '旧方向：做移动端弹窗',
            ts: new Date().toISOString(),
            u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
          } as never,
        ],
      },
    }));
    await new Promise((r) => setTimeout(r, 15));
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'disc-rt-1': [
          ...(state.messages['disc-rt-1'] ?? []),
          {
            _id: 'rt-new',
            rid: 'disc-rt-1',
            msg: '@架构工程 只改桌面端怎么落点？',
            ts: new Date().toISOString(),
            u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
          } as never,
        ],
      },
    }));
    await new Promise((r) => setTimeout(r, 160));
    const newReplies = sent.slice(abortTestSentBefore);
    // 旧圆桌被立刻中断不发帖；定向 @架构工程 只唤醒 architect 单席位
    assert.equal(newReplies.length, 1);
    assert.match(newReplies[0].text, /^🤖 架构工程/);
    assert.match(newReplies[0].text, /只改桌面端怎么落点？/);

    // 3) 拖入普通研发大群后，日常闲聊静默，点名 @挑刺官 单独回应
    const sourceState = useRoomAiParticipants.getState().participants['disc-rt-1'];
    const enrolledGroup = useRoomAiParticipants.getState().enrollFromDrag('grp-dev', false, {
      source: 'ai_discussion',
      mode: sourceState.mode,
      seats: sourceState.seats,
      agentKind: 'pi_butler',
      agentId: 'pi_butler',
      agentName: 'AI 圆桌智囊团',
      discussionRid: 'disc-rt-1',
      discussionName: '定时提醒圆桌讨论',
      decisionSummary: '- 已选方案 A',
    });
    assert.equal(enrolledGroup.replyPolicy, 'mention_only');

    const groupCasual = await handleRoomAiParticipantMessage('grp-dev', {
      _id: 'dev-1',
      rid: 'grp-dev',
      msg: '今天午饭吃什么',
      ts: new Date().toISOString(),
      u: { _id: 'u-bob', username: 'bob', name: 'Bob' },
    } as never);
    assert.equal(groupCasual, false);

    const groupMention = await handleRoomAiParticipantMessage('grp-dev', {
      _id: 'dev-2',
      rid: 'grp-dev',
      msg: '@挑刺官 这个改动会影响发版性能吗',
      ts: new Date().toISOString(),
      u: { _id: 'u-bob', username: 'bob', name: 'Bob' },
    } as never);
    assert.equal(groupMention, true);
    assert.match(sent.at(-1)?.text ?? '', /^🤖 挑刺官/);
  } finally {
    abortRoundtableRun('disc-rt-1');
    stop();
    setRoomAiButlerRunner(null);
  }
});

test('4 层防 Worktree 爆炸守护：默认原位快照、并发切换 Worktree、复用/上限3清理、完结安全销毁', async () => {
  const sent = resetTestEnv();
  const checkpointsCreated: string[] = [];
  const removedWorktrees: string[] = [];
  let dirtyFilesByPath: Record<string, string[]> = {};
  let managedWorktrees: Array<{ path: string; isManaged: boolean; isCurrent: boolean }> = [];

  setWorktreeLifecycleDriversForTests({
    isDesktop: () => true,
    inspectGit: async (root) => ({
      isGitRepo: true,
      repoTopLevel: 'd:/Repos/rocketchatx',
      branch: 'main',
      headSha: 'abc1234',
      hasOrigin: true,
      hasGh: false,
      isWorktree: root !== 'd:/Repos/rocketchatx',
      dirtyFiles: dirtyFilesByPath[root] ?? [],
      diffStat: null,
      recentCommits: [],
    }),
    createCheckpoint: async (_root, label) => {
      checkpointsCreated.push(label);
      return { id: `cp-${checkpointsCreated.length}` };
    },
    listWorktrees: async () =>
      managedWorktrees.map((w) => ({
        path: w.path,
        headSha: 'abc1234',
        branch: 'ai/work',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        isCurrent: w.isCurrent,
        isManaged: w.isManaged,
      })),
    removeWorktree: async (_repoRoot, wtPath) => {
      removedWorktrees.push(wtPath);
      managedWorktrees = managedWorktrees.filter((w) => w.path !== wtPath);
    },
  });

  // 1) 干净单线默认走原位快改 + Git Snapshot（0 Worktree）
  const cleanPlan = await planSafeExecutionWorkspace({
    repoRoot: 'd:/Repos/rocketchatx',
    cardId: 'card-in-place',
  });
  assert.equal(cleanPlan.mode, 'in_place_checkpoint');
  assert.equal(cleanPlan.isolateWorktree, false);
  assert.equal(cleanPlan.checkpointId, 'cp-1');

  // 2) 主仓库已脏或有并发写入者时，自动切隔离 Worktree
  dirtyFilesByPath = { 'd:/Repos/rocketchatx': ['apps/web/src/App.tsx'] };
  const dirtyPlan = await planSafeExecutionWorkspace({
    repoRoot: 'd:/Repos/rocketchatx',
    cardId: 'card-dirty',
  });
  assert.equal(dirtyPlan.mode, 'isolated_worktree');
  assert.equal(dirtyPlan.isolateWorktree, true);

  // 3) 同一张卡多次派发严格复用已有 Worktree，绝不裂变
  useWorkLedger.setState({
    cards: [
      {
        id: 'card-done-clean',
        source: 'manual',
        done: true,
        title: 'Done card',
        createdAt: 1,
        updatedAt: 1,
        state: { todoId: 'card-done-clean', stage: 'done' },
      } as never,
      {
        id: 'card-active-dirty',
        source: 'manual',
        done: false,
        title: 'Active dirty',
        createdAt: 1,
        updatedAt: 1,
        state: { todoId: 'card-active-dirty', stage: 'in_progress' },
      } as never,
      {
        id: 'card-active-3',
        source: 'manual',
        done: false,
        title: 'Active 3',
        createdAt: 1,
        updatedAt: 1,
        state: { todoId: 'card-active-3', stage: 'in_progress' },
      } as never,
      {
        id: 'card-reuse',
        source: 'manual',
        done: false,
        title: 'Reuse card',
        createdAt: 1,
        updatedAt: 1,
        state: { todoId: 'card-reuse', stage: 'in_progress' },
      } as never,
    ],
    sessions: [
      {
        id: 'sess-reuse',
        todoId: 'card-reuse',
        workspaceRoot: 'd:/wt/reuse',
        runtimeStatus: 'ready',
        configSnapshotJson: JSON.stringify({ isolatedWorktree: true }),
        updatedAt: Date.now(),
      } as never,
      {
        id: 'sess-done-clean',
        todoId: 'card-done-clean',
        workspaceRoot: 'd:/wt/done-clean',
        runtimeStatus: 'ready',
        configSnapshotJson: JSON.stringify({ isolatedWorktree: true }),
        updatedAt: Date.now() - IDLE_WORKTREE_TTL_MS - 5000,
      } as never,
      {
        id: 'sess-active-dirty',
        todoId: 'card-active-dirty',
        workspaceRoot: 'd:/wt/active-dirty',
        runtimeStatus: 'ready',
        configSnapshotJson: JSON.stringify({ isolatedWorktree: true }),
        updatedAt: Date.now() - IDLE_WORKTREE_TTL_MS - 5000,
      } as never,
      {
        id: 'sess-active-3',
        todoId: 'card-active-3',
        workspaceRoot: 'd:/wt/active-3',
        runtimeStatus: 'ready',
        configSnapshotJson: JSON.stringify({ isolatedWorktree: true }),
        updatedAt: Date.now(),
      } as never,
    ],
    links: [
      { todoId: 'card-done-clean', repo: 'd:/Repos/rocketchatx', stateSnapshot: 'workspace' } as never,
      { todoId: 'card-active-dirty', repo: 'd:/Repos/rocketchatx', stateSnapshot: 'workspace' } as never,
    ],
  });

  const reusedPlan = await planSafeExecutionWorkspace({
    repoRoot: 'd:/Repos/rocketchatx',
    cardId: 'card-reuse',
    forceIsolateWorktree: true,
  });
  assert.equal(reusedPlan.reusedExisting, true);
  assert.equal(reusedPlan.workspaceRoot, 'd:/wt/reuse');

  // 4) 达到 3 个上限时先回收干净已完结 worktree 再放行；若 3 个都在活跃中则拒绝爆仓
  managedWorktrees = [
    { path: 'd:/wt/done-clean', isManaged: true, isCurrent: false },
    { path: 'd:/wt/active-dirty', isManaged: true, isCurrent: false },
    { path: 'd:/wt/active-3', isManaged: true, isCurrent: false },
  ];
  dirtyFilesByPath = {
    'd:/wt/done-clean': [],
    'd:/wt/active-dirty': ['dirty.ts'],
    'd:/wt/active-3': [],
  };
  const freedPlan = await planSafeExecutionWorkspace({
    repoRoot: 'd:/Repos/rocketchatx',
    cardId: 'card-new-needed',
    forceIsolateWorktree: true,
  });
  assert.equal(freedPlan.prunedCount, 1);
  assert.deepEqual(removedWorktrees, ['d:/wt/done-clean']);

  // 再占满 3 个未完成 worktree，应报错阻止第 4 个
  managedWorktrees = [
    { path: 'd:/wt/active-dirty', isManaged: true, isCurrent: false },
    { path: 'd:/wt/active-3', isManaged: true, isCurrent: false },
    { path: 'd:/wt/reuse', isManaged: true, isCurrent: false },
  ];
  await assert.rejects(
    () =>
      planSafeExecutionWorkspace({
        repoRoot: 'd:/Repos/rocketchatx',
        cardId: 'card-overflow',
        forceIsolateWorktree: true,
      }),
    /Worktree|上限|limit/iu,
  );

  // 5) 脏 Worktree 在巡检与完结清理时受到保护，绝不误删未提交代码
  const sweep = await sweepIdleManagedWorktrees(['d:/Repos/rocketchatx'], Date.now());
  assert.ok(sweep.skippedDirty.includes('d:/wt/active-dirty'));
  const keptDirty = await cleanupCardManagedWorktree('card-active-dirty');
  assert.equal(keptDirty, false);

  // 6) 决策卡直接转 WorkCard（原位安全快照模式）
  dirtyFilesByPath = { 'd:/Repos/rocketchatx': [] };
  useRoomAiParticipants.getState().enrollRoom({
    rid: 'disc-rt-1',
    isDiscussion: true,
    mode: 'roundtable',
    agentKind: 'pi_butler',
    agentId: 'pi_butler',
    agentName: 'AI 圆桌智囊团',
    workspaceRoot: 'd:/Repos/rocketchatx',
  });
  const dispatched = await dispatchRoundtableDecisionToWork({
    rid: 'disc-rt-1',
    decision: {
      title: '群内决议交付验证',
      consensus: ['先跑通原位安全快照模式'],
      options: [{ id: 'opt-1', label: '原位方案', recommended: true }],
      acceptance: ['pnpm typecheck'],
    },
    chosenOptionId: 'opt-1',
  });
  assert.ok(dispatched.cardId);
  assert.equal(dispatched.mode, 'in_place_checkpoint');
  assert.ok(sent.some((m) => m.text.includes('原位快改')));

  setWorktreeLifecycleDriversForTests(null);
});
