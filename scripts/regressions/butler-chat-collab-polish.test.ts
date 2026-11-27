import assert from 'node:assert/strict';
import test from 'node:test';
import { setButlerCognitionRunner, shouldFireProactiveDesktopNotification, useButlerCognition } from '../../apps/web/src/stores/butlerCognition';
import {
  formatChatMessagesForButlerPrompt,
  formatSharePayloadForChat,
  parseSharedSkillFromMessage,
} from '../../apps/web/src/lib/butlerChatBridge';
import {
  resetProactiveLifecycleWatermarksForTests,
  syncProactiveSignalsSnapshot,
} from '../../apps/web/src/agent/proactiveLifecycle';
import { BUILTIN_SLASH_COMMANDS, rankSlashCommands } from '../../apps/web/src/lib/composerCommands';
import { t } from '../../apps/web/src/i18n';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useButlerMemory } from '../../apps/web/src/stores/butlerMemory';
import { useButlerRoomBindings } from '../../apps/web/src/stores/butlerRoomBindings';
import { useButlerSkills } from '../../apps/web/src/stores/butlerSkills';
import { useChat } from '../../apps/web/src/stores/chat';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';

function installMemoryStorage(): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

function resetStores(): void {
  installMemoryStorage();
  resetProactiveLifecycleWatermarksForTests();
  useAuth.setState({ user: { _id: 'u-alice', username: 'alice', name: 'Alice' } as never, localMode: false });
  useButlerCognition.setState({
    accountScope: 'u-alice@same-origin',
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
  useButlerRoomBindings.setState({
    accountScope: 'u-alice@same-origin',
    hydrated: true,
    bindings: [],
  });
  useButlerMemory.setState({
    accountScope: 'u-alice@same-origin',
    memories: [],
    digests: [],
    memoryPaused: false,
    hydrated: true,
    loading: false,
    lastError: null,
  });
  useButlerSkills.setState({
    accountScope: 'u-alice@same-origin',
    skills: [],
    hydrated: true,
    loading: false,
    error: null,
  });
  useAcpAgents.setState({ sessions: {}, agents: [] });
  useChat.setState({ subscriptions: {}, rooms: {}, messages: {} });
  useCodexWorkspace.setState({ workspaceRoot: 'd:/Repos/rocketchatx', status: 'ready' });
}

test('群聊拖拽桥：洞察/子Agent/技能卡格式化与群内一键导入技能还原', async () => {
  resetStores();

  const skillMd = formatSharePayloadForChat({
    kind: 'skill',
    skillId: 'sk-1',
    slug: 'hotfix-verify',
    name: 'Hotfix Verify',
    description: 'Run targeted unit + regression suite',
    category: 'ops',
    approvalPolicy: 'confirm_write',
    triggers: ['hotfix', 'verify'],
    allowedTools: ['git_diff', 'terminal'],
    instructionsMd: '1. Check git diff\n2. Run verification tests cleanly.',
  });
  assert.ok(skillMd.includes('```rocketx-skill'));

  const parsed = parseSharedSkillFromMessage(skillMd);
  assert.ok(parsed);
  assert.equal(parsed.slug, 'hotfix-verify');
  assert.equal(parsed.name, 'Hotfix Verify');
  assert.equal(parsed.category, 'ops');
  assert.equal(parsed.approvalPolicy, 'confirm_write');
  assert.deepEqual(parsed.triggers, ['hotfix', 'verify']);

  // Round-trip import directly into useButlerSkills
  const imported = await useButlerSkills.getState().importMarkdown(parsed.rawMarkdown);
  assert.equal(imported.slug, 'hotfix-verify');
  assert.equal(imported.name, 'Hotfix Verify');
  assert.ok(imported.instructionsMd.includes('Run verification tests cleanly.'));

  const chatPrompt = formatChatMessagesForButlerPrompt({
    rid: 'room-eng',
    roomName: '研发核心群',
    messages: [
      { mid: 'm1', sender: 'Bob', username: 'bob', ts: 1000, text: '上线前把 /responses 回归跑一下' },
      { mid: 'm2', sender: 'Carol', username: 'carol', ts: 2000, text: '顺便让 Claude 看下 PR #42' },
    ],
  });
  assert.ok(chatPrompt.includes('#研发核心群'));
  assert.ok(chatPrompt.includes('**Bob** (m1)'));
  assert.ok(chatPrompt.includes('PR #42'));
});

test('子 Agent 与盯梢绑定群话题自动播报进度/待拍板，且群友回复触发高显著观察信号', async () => {
  resetStores();
  const sentMessages: Array<{ text: string; rid?: string; tmid?: string }> = [];
  const origSend = useChat.getState().send;
  useChat.setState({
    send: (async (text: string, opts?: { rid?: string; tmid?: string }) => {
      sentMessages.push({ text, rid: opts?.rid, tmid: opts?.tmid });
    }) as never,
    subscriptions: {
      'room-eng': { rid: 'room-eng', name: 'eng', fname: '研发群', open: true, ls: { $date: 1000 }, userMentions: 0 } as never,
    },
    rooms: {
      'room-eng': { _id: 'room-eng', lm: { $date: 1000 }, lastMessage: { _id: 'm0', msg: 'init', ts: { $date: 1000 }, u: { _id: 'u-alice', username: 'alice' } } } as never,
    },
  });

  try {
    // Baseline scan
    useAcpAgents.setState({
      sessions: {
        'acp:claude:s1': {
          sessionKey: 'acp:claude:s1',
          agentId: 'claude',
          agentName: 'Claude',
          preset: 'claude',
          acpSessionId: 's1',
          title: 'Fix release gate',
          workspaceRoot: 'd:/Repos/rocketchatx',
          linkedTodoId: null,
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
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
    });
    syncProactiveSignalsSnapshot(1000);

    // Bind session to specific thread inside room-eng
    useButlerRoomBindings.getState().bindToRoom({
      targetKind: 'acp_session',
      targetId: 'acp:claude:s1',
      label: 'Claude: Fix release gate',
      rid: 'room-eng',
      roomName: '研发群',
      tmid: 'thread-root-99',
      autoPost: true,
    });

    // Simulate ACP waiting approval transition -> should auto-post once into thread-root-99
    useAcpAgents.setState({
      sessions: {
        'acp:claude:s1': {
          ...useAcpAgents.getState().sessions['acp:claude:s1'],
          status: 'waiting_approval',
          pendingPermissions: [
            {
              requestId: 'perm-1',
              sessionId: 's1',
              reason: 'Need git push',
              options: [],
              createdAt: 2000,
              toolCall: { toolCallId: 'tc-1', title: 'git push origin main', kind: 'execute', status: 'pending' },
            },
          ],
          updatedAt: 2000,
        },
      },
    });
    syncProactiveSignalsSnapshot(2000);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].rid, 'room-eng');
    assert.equal(sentMessages[0].tmid, 'thread-root-99');
    assert.ok(sentMessages[0].text.includes('git push origin main'));

    // Teammate replies inside the bound thread -> becomes high-salience bound_room_reply observation
    useChat.setState({
      rooms: {
        'room-eng': {
          _id: 'room-eng',
          lm: { $date: 3000 },
          lastMessage: {
            _id: 'm-reply-1',
            tmid: 'thread-root-99',
            msg: '先别 push，先把 changelog 补上',
            ts: { $date: 3000 },
            u: { _id: 'u-bob', username: 'bob' },
          },
        } as never,
      },
    });
    const highSalience = syncProactiveSignalsSnapshot(3000);
    assert.equal(highSalience, true);
    const boundObs = useButlerCognition.getState().observations.find((o) => o.kind === 'bound_room_reply');
    assert.ok(boundObs);
    assert.equal(boundObs.ref?.sessionKey, 'acp:claude:s1');
    assert.equal(boundObs.ref?.mid, 'm-reply-1');

    // Account switch resets watermarks without leaking
    useAuth.setState({ user: { _id: 'u-bob', username: 'bob', name: 'Bob' } as never });
    syncProactiveSignalsSnapshot(4000);
    assert.equal(useButlerCognition.getState().accountScope, 'u-bob@same-origin');
    assert.equal(useButlerRoomBindings.getState().bindings.length, 0);
  } finally {
    useChat.setState({ send: origSend });
  }
});

test('主动心智礼貌避让与通知静音、Daily Dream 可溯源与一键回滚', async () => {
  resetStores();

  // Notification DND etiquette check
  assert.equal(
    shouldFireProactiveDesktopNotification({
      desktopNotifications: 'none',
      muteFocusedConversations: false,
      isWindowFocused: false,
      isViewingButler: false,
    }),
    false,
  );
  assert.equal(
    shouldFireProactiveDesktopNotification({
      desktopNotifications: 'all',
      muteFocusedConversations: true,
      isWindowFocused: true,
      isViewingButler: true,
    }),
    false,
  );
  assert.equal(
    shouldFireProactiveDesktopNotification({
      desktopNotifications: 'all',
      muteFocusedConversations: true,
      isWindowFocused: false,
      isViewingButler: true,
    }),
    true,
  );

  // Foreground chat running defers background evaluatePulse
  let wakeCalls = 0;
  const restoreRunner = setButlerCognitionRunner(async ({ text }) => {
    wakeCalls += 1;
    if (text.includes('[Butler Daily Dream')) {
      await useButlerMemory.getState().upsertMemory({
        category: 'project_fact',
        title: 'Dream Temp Memory',
        content: 'New fact learned during dream cycle.',
        tags: ['dream-test'],
        sourceKind: 'assistant_review',
        enabled: true,
      });
      await useButlerSkills.getState().upsertSkill({
        slug: 'existing-ops',
        name: 'Existing Ops v2',
        description: 'Evolved instructions',
        category: 'ops',
        instructionsMd: 'Updated multi-step playbook v2',
      });
    }
    return { text: 'OK' };
  });

  try {
    useButlerCognition.getState().ingestObservation({
      source: 'acp',
      kind: 'acp_error',
      salience: 'high',
      summary: 'Sub-agent failed',
    });
    useCodexWorkspace.setState({ status: 'running' });
    const deferred = await useButlerCognition.getState().evaluatePulse(1_000_000);
    assert.equal(deferred, false);
    assert.equal(wakeCalls, 0);

    useCodexWorkspace.setState({ status: 'ready' });
    const woken = await useButlerCognition.getState().evaluatePulse(1_000_000);
    assert.equal(woken, true);
    assert.equal(wakeCalls, 1);

    // Seed pre-dream skill so we test restoring modified skills as well as deleting new dream memories
    await useButlerSkills.getState().upsertSkill({
      slug: 'existing-ops',
      name: 'Existing Ops v1',
      description: 'Original instructions',
      category: 'ops',
      instructionsMd: 'Original v1 steps',
    });

    const journal = await useButlerCognition.getState().runDreamNow(2_000_000, 'manual');
    assert.ok((journal.memoryArtifacts ?? []).some((a) => a.title === 'Dream Temp Memory' && a.action === 'created'));
    assert.ok((journal.skillSnapshots ?? []).some((s) => s.slug === 'existing-ops' && s.existedBefore));
    assert.equal(
      useButlerSkills.getState().skills.find((s) => s.slug === 'existing-ops')?.instructionsMd,
      'Updated multi-step playbook v2',
    );

    const rollbackRes = await useButlerCognition.getState().rollbackDreamEntry(journal.id);
    assert.ok(rollbackRes.restoredMemories >= 1);
    assert.equal(rollbackRes.restoredSkills, 1);
    assert.equal(
      useButlerSkills.getState().skills.find((s) => s.slug === 'existing-ops')?.instructionsMd,
      'Original v1 steps',
    );
    assert.equal(
      useButlerMemory.getState().memories.some((m) => m.title === 'Dream Temp Memory'),
      false,
    );
  } finally {
    restoreRunner();
  }
});

test('/pulse 与 /dream 斜杠指令已注册并正确排序', () => {
  const ids = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.id));
  assert.ok(ids.has('pulse'));
  assert.ok(ids.has('dream'));

  const pulseMatch = rankSlashCommands('pul', t, [
    { id: 's1', slug: 'deploy', name: 'Deploy', description: 'Deploy app', promptTemplate: '...', category: 'ops', runCount: 3 },
  ]);
  assert.equal(pulseMatch[0]?.command, 'pulse');

  const dreamMatch = rankSlashCommands('dr', t, []);
  assert.equal(dreamMatch[0]?.command, 'dream');
});
