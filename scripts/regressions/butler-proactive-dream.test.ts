import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { executeRocketxDynamicTool, ROCKETX_DYNAMIC_TOOLS } from '../../apps/web/src/agent/codexHostTools';
import { consolidateDuplicateMemories } from '../../apps/web/src/agent/butlerDream';
import {
  resetProactiveLifecycleWatermarksForTests,
  syncProactiveSignalsSnapshot,
} from '../../apps/web/src/agent/proactiveLifecycle';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import { setButlerCognitionRunner, useButlerCognition } from '../../apps/web/src/stores/butlerCognition';
import { useButlerMemory } from '../../apps/web/src/stores/butlerMemory';
import { useButlerSkills } from '../../apps/web/src/stores/butlerSkills';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useChat } from '../../apps/web/src/stores/chat';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

function installMemoryStorage(): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

function resetStoresForTest(): void {
  installMemoryStorage();
  resetProactiveLifecycleWatermarksForTests();
  useButlerCognition.setState({
    accountScope: 'default',
    hydrated: true,
    ambientEnabled: true,
    dreamEnabled: true,
    lastUserActivityAt: 0,
    lastUserChannel: null,
    lastAmbientWakeAt: 0,
    autoWakeTimestamps: [],
    lastDreamDate: null,
    observations: [],
    watchpoints: [],
    insights: [],
    dreamJournal: [],
    ambientRunning: false,
    dreamRunning: false,
    lastError: null,
  });
  useButlerMemory.setState({
    accountScope: 'default',
    memories: [],
    digests: [],
    memoryPaused: false,
    hydrated: true,
    loading: false,
    lastError: null,
  });
  useButlerSkills.setState({
    accountScope: 'default',
    skills: [],
    hydrated: true,
    loading: false,
    error: null,
  });
  useAcpAgents.setState({
    sessions: {},
    agents: [],
  });
  useWorkLedger.setState({
    cards: [],
    actions: [],
    sessions: [],
    evidences: [],
    links: [],
  });
  useChat.setState({
    subscriptions: {},
    rooms: {},
    messages: {},
  });
  useCodexWorkspace.setState({
    workspaceRoot: 'd:/Repos/rocketchatx',
  });
}

test('主动心智底座：自调度 Watchpoint、后台脉冲去抖、NOOP 零打扰与注意力反馈', async () => {
  resetStoresForTest();
  const calls: string[] = [];
  const restoreRunner = setButlerCognitionRunner(async ({ text }) => {
    calls.push(text);
    // Simulate model deciding to inspect and surface 1 proactive decision via host tool
    await executeRocketxDynamicTool({
      tool: 'surface_proactive_insight',
      arguments: {
        level: 'inbox',
        kind: 'decision',
        title: 'Claude 完成鉴权重构，请确认是否合并',
        summary: '已跑通 12 个单元测试，需要您拍板是否提交 PR。',
        sessionKey: 'acp:claude:sess-1',
        suggestedActions: [{ label: '批准并复核 diff', prompt: '请帮我复核 acp:claude:sess-1 的改动' }],
      },
    });
    return { text: 'Surfaced 1 decision.' };
  });

  try {
    const toolNames = new Set(ROCKETX_DYNAMIC_TOOLS.map((item) => item.name));
    for (const requiredTool of [
      'read_activity_stream',
      'read_room_messages',
      'acp_inspect_session',
      'acp_steer_session',
      'watchpoint_manage',
      'surface_proactive_insight',
      'skill_evolve',
    ]) {
      assert.ok(toolNames.has(requiredTool), `Missing dynamic tool ${requiredTool}`);
    }

    // Arm watchpoint for ACP session settle via tool
    const wpResp = await executeRocketxDynamicTool({
      tool: 'watchpoint_manage',
      arguments: {
        op: 'set',
        reason: '等 Claude 完成 auth 模块修改后通知我审 diff',
        kind: 'acp_session_settle',
        sessionKey: 'acp:claude:sess-1',
      },
    });
    assert.equal(wpResp.success, true);

    // Seed an ACP session transition and sync world signals
    const baseTime = 1_764_100_000_000;
    useAcpAgents.setState({
      sessions: {
        'acp:claude:sess-1': {
          sessionKey: 'acp:claude:sess-1',
          agentId: 'claude',
          agentName: 'Claude Code',
          preset: 'claude-code',
          acpSessionId: 'acp-1',
          title: 'Auth refactor',
          workspaceRoot: 'd:/Repos/rocketchatx',
          linkedTodoId: 'card-auth',
          autonomyMode: 'confirm',
          status: 'running',
          error: null,
          modes: null,
          models: null,
          availableCommands: [],
          plan: [],
          messages: [],
          streamingText: '',
          streamingThought: '',
          toolCalls: [],
          pendingPermissions: [],
          stderrLogs: [],
          lastStopReason: null,
          turnCount: 0,
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      },
    });
    const initialSignal = syncProactiveSignalsSnapshot(baseTime);
    assert.equal(initialSignal, false);

    // Sub-agent completes turn -> fires watchpoint -> high salience observation
    useAcpAgents.setState((prev) => ({
      sessions: {
        ...prev.sessions,
        'acp:claude:sess-1': {
          ...prev.sessions['acp:claude:sess-1'],
          status: 'ready',
          turnCount: 1,
          messages: [
            { id: 'm1', role: 'assistant', text: 'Auth refactor completed; 12 tests passing.', timestamp: baseTime + 1000 },
          ],
          updatedAt: baseTime + 1000,
        },
      },
    }));
    const highSignal = syncProactiveSignalsSnapshot(baseTime + 1000);
    assert.equal(highSignal, true);
    assert.equal(syncProactiveSignalsSnapshot(baseTime + 1500), false);

    const beforePulse = useButlerCognition.getState();
    assert.equal(beforePulse.watchpoints[0]?.status, 'fired');
    assert.ok(beforePulse.observations.some((o) => o.kind === 'watchpoint_fired' && o.salience === 'high'));

    // Pulse wakes background cognition and calls runner
    const ran = await useButlerCognition.getState().evaluatePulse(baseTime + 20_000);
    assert.equal(ran, true);
    assert.equal(calls.length, 1);

    // Insights surfaced cleanly
    const insights = useButlerCognition.getState().insights;
    assert.equal(insights.length, 1);
    assert.equal(insights[0].title, 'Claude 完成鉴权重构，请确认是否合并');

    // Cooldown / no unconsumed observations prevents duplicate wake
    const ranAgain = await useButlerCognition.getState().evaluatePulse(baseTime + 25_000);
    assert.equal(ranAgain, false);
    assert.equal(calls.length, 1);

    // User marks feedback -> calibration recorded
    useButlerCognition.getState().markInsightFeedback(insights[0].id, 'acted');
    assert.equal(useButlerCognition.getState().insights[0].userFeedback, 'accepted');
  } finally {
    restoreRunner();
  }
});

test('正交观测与操控原语：read_room_messages / acp_inspect_session / acp_steer_session 安全边界', async () => {
  resetStoresForTest();
  useButlerCognition.getState().recordUserActivity(1_764_100_000_000, 'chat');

  useChat.setState({
    subscriptions: {
      'room-dev': { rid: 'room-dev', name: 'dev-channel', fname: '研发群', t: 'p', unread: 2, userMentions: 1, open: true } as any,
    },
    rooms: {
      'room-dev': { _id: 'room-dev', lastMessage: { _id: 'm0', rid: 'room-dev', msg: 'CI 挂了需要确认回滚' } } as any,
    },
    messages: {
      'room-dev': [
        {
          _id: 'm1',
          rid: 'room-dev',
          msg: '请看下主干 CI 失败日志',
          ts: '2026-11-26T00:05:00.000Z',
          u: { _id: 'u2', username: 'alice', name: 'Alice' },
        } as any,
      ],
    },
  });

  const roomList = await executeRocketxDynamicTool({ tool: 'read_room_messages', arguments: {} });
  assert.equal(roomList.success, true);
  const parsedRooms = JSON.parse(roomList.contentItems[0].text!);
  assert.equal(parsedRooms.rooms[0].rid, 'room-dev');

  const roomMsgs = await executeRocketxDynamicTool({ tool: 'read_room_messages', arguments: { rid: 'room-dev' } });
  const parsedMsgs = JSON.parse(roomMsgs.contentItems[0].text!);
  assert.equal(parsedMsgs.messages.length, 1);
  assert.match(parsedMsgs.messages[0].text, /主干 CI 失败日志/);

  useAcpAgents.setState({
    sessions: {
      'acp:codex:s2': {
        sessionKey: 'acp:codex:s2',
        agentId: 'codex',
        agentName: 'Codex CLI',
        preset: 'codex-acp',
        acpSessionId: 's2',
        title: 'Fix CI',
        workspaceRoot: 'd:/Repos/rocketchatx',
        linkedTodoId: null,
        autonomyMode: 'confirm',
        status: 'waiting_approval',
        error: null,
        modes: null,
        models: null,
        availableCommands: [],
        plan: [],
        messages: [{ id: 'a1', role: 'assistant', text: 'Need permission to run push', timestamp: Date.now() }],
        streamingText: '',
        streamingThought: '',
        toolCalls: [],
        pendingPermissions: [
          {
            requestId: 'perm-1',
            sessionId: 's2',
            toolCall: { toolCallId: 'tc-1', title: 'git push --force', kind: 'execute' },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ],
            reason: 'Force push requires confirmation',
            createdAt: Date.now(),
          },
        ],
        stderrLogs: [],
        lastStopReason: null,
        turnCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });

  const inspectRes = await executeRocketxDynamicTool({
    tool: 'acp_inspect_session',
    arguments: { sessionKey: 'acp:codex:s2' },
  });
  const inspected = JSON.parse(inspectRes.contentItems[0].text!);
  assert.equal(inspected.pendingPermissions[0].toolTitle, 'git push --force');

  // Guardrail: non-autonomous session cannot auto-approve dangerous permission unattended
  const blockedRes = await executeRocketxDynamicTool({
    tool: 'acp_steer_session',
    arguments: {
      sessionKey: 'acp:codex:s2',
      action: 'resolve_permission',
      requestId: 'perm-1',
      optionId: 'allow_once',
    },
  });
  const blocked = JSON.parse(blockedRes.contentItems[0].text!);
  assert.equal(blocked.blocked, true);

  // read_activity_stream reports watermark accurately
  const streamRes = await executeRocketxDynamicTool({ tool: 'read_activity_stream', arguments: {} });
  const stream = JSON.parse(streamRes.contentItems[0].text!);
  assert.ok(stream.lastUserActivityAt);
});

test('每日 Dream 引擎：重复记忆归并、注意力降噪校准、技能进化与按日去重', async () => {
  resetStoresForTest();
  const baseNow = new Date('2026-11-26T04:00:00Z').getTime();

  // Seed duplicate memories
  await useButlerMemory.getState().upsertMemory({
    category: 'project_fact',
    title: 'Windows npx spawning rule',
    content: 'Use cmd.exe /d /s /c on Windows when spawning npx MCP servers.',
    tags: ['windows', 'mcp'],
    workspaceRoot: 'd:/Repos/rocketchatx',
    sourceKind: 'conversation',
    pinned: true,
    enabled: true,
  });
  await useButlerMemory.getState().upsertMemory({
    category: 'project_fact',
    title: 'windows   npx spawning rule',
    content: 'Duplicate entry for Windows npx spawn handling.',
    tags: ['npx'],
    workspaceRoot: 'd:/Repos/rocketchatx',
    sourceKind: 'conversation',
    pinned: false,
    enabled: true,
  });

  // Seed dismissed insights so Dream calibrates preference
  const ins1 = useButlerCognition.getState().surfaceInsight({
    level: 'inbox',
    kind: 'progress',
    title: '常规进度播报 A',
    summary: 'minor progress',
  });
  const ins2 = useButlerCognition.getState().surfaceInsight({
    level: 'inbox',
    kind: 'progress',
    title: '常规进度播报 B',
    summary: 'minor progress 2',
  });
  useButlerCognition.getState().markInsightFeedback(ins1.id, 'dismissed');
  useButlerCognition.getState().markInsightFeedback(ins2.id, 'dismissed');

  // Seed expired watchpoint
  const wp = useButlerCognition.getState().addWatchpoint({
    reason: 'Expired test wp',
    condition: { kind: 'after_timestamp', wakeAt: baseNow - 10_000 },
    ttlMs: 60_000,
  });
  useButlerCognition.setState((s) => ({
    watchpoints: s.watchpoints.map((w) => (w.id === wp.id ? { ...w, expiresAt: baseNow - 1000 } : w)),
  }));

  const restoreRunner = setButlerCognitionRunner(async () => {
    // Reflective Dream evolves a skill during sleep cycle
    await executeRocketxDynamicTool({
      tool: 'skill_evolve',
      arguments: {
        op: 'upsert',
        slug: 'post-merge-verify',
        name: 'Post-Merge Verify',
        description: 'Run targeted typecheck & regression after ACP coder finishes',
        category: 'code',
        instructionsMd: '1. Run pnpm typecheck\n2. Run targeted test\n3. Surface concise summary',
        triggers: ['verify', 'acp-done'],
      },
    });
    return {
      text: '### Dream Reflection\n- Consolidated Windows npx facts\n- Evolved /post-merge-verify skill',
    };
  });

  try {
    const mergedOnly = await consolidateDuplicateMemories();
    assert.equal(mergedOnly, 1);

    // Run Dream cycle when user has been idle > 15m
    useButlerCognition.setState({ lastUserActivityAt: baseNow - 30 * 60_000 });
    const ranAuto = await useButlerCognition.getState().maybeRunDailyDream(baseNow);
    assert.equal(ranAuto, true);

    const cog = useButlerCognition.getState();
    assert.equal(cog.dreamJournal.length, 1);
    assert.equal(cog.dreamJournal[0].skillsEvolved, 1);
    assert.ok(cog.dreamJournal[0].memoriesCreated >= 1);
    assert.equal(useButlerSkills.getState().skills.some((s) => s.slug === 'post-merge-verify'), true);
    const readSkillRes = await executeRocketxDynamicTool({
      tool: 'skill_evolve',
      arguments: { op: 'read', slug: 'post-merge-verify' },
    });
    assert.equal(readSkillRes.success, true);
    const parsedSkill = JSON.parse(readSkillRes.contentItems[0].text!);
    assert.match(parsedSkill.instructionsMd, /pnpm typecheck/);
    assert.ok(
      useButlerMemory.getState().memories.some((m) => m.tags.includes('dream-calibrated')),
      'Expected Dream to record attention calibration preference memory',
    );

    // Same day will not re-trigger automatically
    const ranTwice = await useButlerCognition.getState().maybeRunDailyDream(baseNow + 60_000);
    assert.equal(ranTwice, false);
  } finally {
    restoreRunner();
  }
});

test('主动心智 UI、Pi 系统提示与词条完整性契约', () => {
  const center = readFileSync('apps/web/src/components/ButlerAssistantCenter.tsx', 'utf8');
  const conv = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const mainPage = readFileSync('apps/web/src/pages/MainPage.tsx', 'utf8');
  const piServer = readFileSync('apps/desktop/src-tauri/src/pi_app_server.mjs', 'utf8');

  assert.match(mainPage, /startProactiveLifecycle/);
  assert.match(center, /sectionTab === 'cognition'/);
  assert.match(center, /runDreamNow/);
  assert.match(center, /runAmbientTurn/);
  assert.match(conv, /useButlerCognition/);
  assert.match(conv, /unreadProactiveInsights\.length > 0/);
  assert.match(piServer, /watchpoint_manage/);
  assert.match(piServer, /read_activity_stream/);
  assert.ok(zhCN['butler.assistant.tabCognition']);
  assert.ok(enUS['butler.assistant.tabCognition']);
  assert.ok(zhCN['agent.hostTools.tool.watchpoint_manage']);
  assert.ok(enUS['agent.hostTools.tool.watchpoint_manage']);
});
