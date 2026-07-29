import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated, type RocketChatMockState } from './support/rocket-chat-mock';

const ANSWER = '发布前需要 Alice 确认检查清单。';

async function openButlerConversationView(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: '对话', exact: true })
    .click();
}

async function openButlerNowView(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: /^现在/ })
    .click();
}

async function openButlerFromGeneral(page: Page): Promise<RocketChatMockState> {
  const state = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { getState: () => { openStandaloneConversation: () => Promise<void> } };
    }>;
    await (await load()).useButler.getState().openStandaloneConversation();
  });
  await openButlerConversationView(page);
  await expect(page.getByText('多轮讨论留在这里，结论会写回今天的纸。', { exact: true })).toBeVisible();
  return state;
}

async function openRoomButlerFromGeneral(page: Page): Promise<RocketChatMockState> {
  const state = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开房间管家', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '房间管家' })).toBeVisible();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => {
          openRoomConversation: (room: { rid: string; roomName: string }) => Promise<void>;
        };
      };
    }>;
    await (await load()).useButler.getState().openRoomConversation({
      rid: 'room-general',
      roomName: 'General',
    });
  });
  return state;
}

async function seedButlerAnswer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      flushButlerPersist: () => Promise<void>;
      useButler: {
        getState: () => {
          openRoomConversation: (room: { rid: string; roomName: string }) => Promise<void>;
        };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { flushButlerPersist, useButler } = await load();
    await useButler.getState().openRoomConversation({ rid: 'room-general', roomName: 'General' });
    const roomSource = {
      kind: 'room',
      id: 'room-general',
      rid: 'room-general',
      label: 'General',
    };
    useButler.setState({
      lines: [
        { id: 'question', role: 'user', text: '发布前还缺什么？', sources: [roomSource] },
        {
          id: 'answer',
          role: 'assistant',
          text: '发布前需要 Alice 确认检查清单。',
          sources: [{
            kind: 'message',
            id: 'general-release',
            rid: 'room-general',
            mid: 'general-release',
            label: 'General · Release checklist ready',
          }],
        },
      ],
      context: {
        kind: 'room',
        label: 'General',
        detail: '当前 Rocket.Chat 房间',
        sources: [{ kind: 'room', id: 'room-general', rid: 'room-general', label: 'General' }],
      },
      actionDraft: null,
      running: false,
      error: null,
    });
    await flushButlerPersist();
  });
  await expect(page.getByText(ANSWER, { exact: false }).first()).toBeVisible();
}

async function seedStandaloneButlerAnswer(
  page: Page,
  question: string,
  answer: string,
): Promise<string> {
  return page.evaluate(async ({ question, answer }) => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      flushButlerPersist: () => Promise<void>;
      useButler: {
        getState: () => {
          activeSessionId: string;
          openStandaloneConversation: () => Promise<void>;
        };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { flushButlerPersist, useButler } = await load();
    await useButler.getState().openStandaloneConversation();
    useButler.setState({
      lines: [
        { id: 'standalone-question', role: 'user', text: question },
        { id: 'standalone-answer', role: 'assistant', text: answer },
      ],
      context: null,
      running: false,
      error: null,
    });
    await flushButlerPersist();
    return useButler.getState().activeSessionId;
  }, { question, answer });
}

async function seedButlerCitationList(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await load();
    const sourceUrl = (id: string) => `${window.location.origin}/channel/General?msg=${id}`;
    useButler.setState({
      lines: [
        { id: 'citation-question', role: 'user', text: '最近在讨论啥' },
        {
          id: 'citation-answer',
          role: 'assistant',
          text: [
            '## 最近讨论',
            `- 主要是在做 Rocket.Chat 冒烟测试。[来源](${sourceUrl('general-release')})[来源](${sourceUrl('citation-2')})`,
            `- 张三测试了“第二用户未读消息”和“实时推送”。[来源](${sourceUrl('citation-3')})`,
            `- Administrator 测试了消息编辑、引用回复，以及房间设置。[来源](${sourceUrl('citation-4')})[来源](${sourceUrl('citation-5')})`,
            `- 没有看到实际业务讨论内容。[来源](${sourceUrl('citation-6')})[来源](${sourceUrl('citation-7')})[来源](${sourceUrl('citation-8')})`,
          ].join('\n'),
          sources: Array.from({ length: 8 }, (_, index) => ({
            kind: 'message',
            id: index === 0 ? 'general-release' : `citation-${index + 1}`,
            rid: 'room-general',
            mid: index === 0 ? 'general-release' : `citation-${index + 1}`,
            webUrl: sourceUrl(index === 0 ? 'general-release' : `citation-${index + 1}`),
            label: index === 0
              ? 'General · Release checklist ready'
              : `General · 引用消息 ${index + 1}`,
          })),
        },
      ],
      context: {
        kind: 'room',
        label: 'General',
        detail: '当前 Rocket.Chat 房间',
        sources: [{ kind: 'room', id: 'room-general', rid: 'room-general', label: 'General' }],
      },
      actionDraft: null,
      running: false,
      error: null,
    });
  });
  await expect(page.getByRole('heading', { name: '最近讨论' })).toBeVisible();
}

async function captureButlerAsks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    const captured: unknown[] = [];
    (window as Window & { __capturedButlerAsks?: unknown[] }).__capturedButlerAsks = captured;
    useButler.setState({
      ask: async (text: string, context: unknown, images: unknown[]) => {
        captured.push({ text, context, images });
      },
    });
  });
}

async function seedMemoryApproval(page: Page): Promise<{ status: string; checkpointId: string | null }> {
  return page.evaluate(async () => {
    const loadTools = new Function('return import("/src/lib/butlerTools.ts")') as () => Promise<{
      createButlerTools: () => Array<{
        name: string;
        invoke: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<{
          status: string;
          checkpoint?: { id: string };
        }>;
      }>;
    }>;
    const loadProfile = new Function('return import("/src/lib/butlerProfile.ts")') as () => Promise<{
      setButlerProfileStorage: (storage: { get: (key: string) => string | null; set: (key: string, value: string) => void }) => void;
    }>;
    const loadStore = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;

    const { createButlerTools } = await loadTools();
    const { setButlerProfileStorage } = await loadProfile();
    const { useButler } = await loadStore();

    const entries = new Map<string, string>();
    const storage = {
      get: (key: string) => entries.get(key) ?? null,
      set: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    setButlerProfileStorage(storage);
    (window as Window & { __butlerMemoryEntries?: Map<string, string> }).__butlerMemoryEntries = entries;

    const checkpoints = new Map<string, unknown>();
    const sync = () => useButler.setState({ runtimeCheckpoints: [...checkpoints.values()] });
    const remember = createButlerTools().find((tool) => tool.name === 'remember');
    if (!remember) throw new Error('remember tool not found');
    const invoked = await remember.invoke({
      kind: 'preference',
      scope: 'room',
      subject: 'reply-style',
      value: '默认简短回复',
    }, {
      scope: {
        server: 'https://chat.example',
        account: 'alice',
        room: 'general',
      },
      loadCheckpoint: (id: string) => checkpoints.get(id),
      saveCheckpoint: (checkpoint: { id: string }) => {
        checkpoints.set(checkpoint.id, checkpoint);
        sync();
      },
      requestApproval: (checkpoint: { id: string }) => {
        checkpoints.set(checkpoint.id, checkpoint);
        sync();
      },
    });
    return {
      status: invoked.status,
      checkpointId: invoked.checkpoint?.id ?? null,
    };
  });
}

async function seedWorkflowMemoryApproval(
  page: Page,
): Promise<{ status: string; hidden: boolean; sessionId: string }> {
  return page.evaluate(async () => {
    const loadTools = new Function('return import("/src/lib/butlerTools.ts")') as () => Promise<{
      createButlerTools: () => Array<{
        name: string;
        invoke: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<{
          status: string;
        }>;
      }>;
    }>;
    const loadProfile = new Function('return import("/src/lib/butlerProfile.ts")') as () => Promise<{
      setButlerProfileStorage: (
        storage: { get: (key: string) => string | null; set: (key: string, value: string) => void },
      ) => void;
    }>;
    const loadStore = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      runButlerWorkflowTask: (options: Record<string, unknown>) => Promise<unknown>;
      listButlerWorkflowSnapshots: () => Array<{
        key: string;
        hidden: boolean;
        sessionId: string;
      }>;
      useButler: { getState: () => { hydrate: () => Promise<void> } };
    }>;

    const { createButlerTools } = await loadTools();
    const { setButlerProfileStorage } = await loadProfile();
    const { listButlerWorkflowSnapshots, runButlerWorkflowTask, useButler } = await loadStore();
    const entries = new Map<string, string>();
    setButlerProfileStorage({
      get: (key) => entries.get(key) ?? null,
      set: (key, value) => entries.set(key, value),
    });
    (window as Window & { __butlerWorkflowMemoryEntries?: Map<string, string> })
      .__butlerWorkflowMemoryEntries = entries;
    await useButler.getState().hydrate();

    let status = '';
    await runButlerWorkflowTask({
      key: 'routine:ui-memory',
      kind: 'routine',
      goal: '验证主动任务的长期记忆审批',
      triggerReason: 'ui-test',
      context: {
        kind: 'room',
        label: 'General',
        detail: 'UI workflow approval test',
        sources: [{ kind: 'room', id: 'general', rid: 'general', label: 'General' }],
      },
      execute: async (workflow: {
        taskState: { id: string };
        toolRuntimeContext: (callId: string) => Record<string, unknown>;
      }) => {
        const remember = createButlerTools().find((tool) => tool.name === 'remember');
        if (!remember) throw new Error('remember tool not found');
        const invoked = await remember.invoke({
          kind: 'preference',
          scope: 'room',
          subject: 'workflow-style',
          value: '主动任务也先审批',
        }, {
          ...workflow.toolRuntimeContext('workflow-memory-ui'),
          taskId: workflow.taskState.id,
        });
        status = invoked.status;
        return {
          value: null,
          summary: '主动任务已生成待审批记忆。',
        };
      },
    });
    const snapshot = listButlerWorkflowSnapshots()
      .find((item) => item.key === 'routine:ui-memory');
    if (!snapshot) throw new Error('workflow snapshot not found');
    return {
      status,
      hidden: snapshot.hidden,
      sessionId: snapshot.sessionId,
    };
  });
}

async function seedErrandSurface(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => Record<string, unknown>;
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await loadStore();
    const current = useButler.getState() as Record<string, unknown>;
    const sharedErrand = {
      id: 'errand-release-checklist',
      title: '发布前核对清单',
      threadId: 'thread-errand-release-checklist',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: '主仓',
      readOnly: false,
      startedAt: 1,
      roomContext: { rid: 'room-general', roomName: 'General' },
      reply: 'Alice 已确认发布检查清单。',
      status: 'replied',
      approvals: [],
      traces: [],
    };

    useButler.setState({
      ...(Array.isArray(current.errands) ? { errands: [sharedErrand] } : {}),
    });
  });
}

async function seedPaperSections(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const loadButler = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { errands: Array<Record<string, unknown>>; lines: Array<Record<string, unknown>> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const loadRounds = new Function('return import("/src/lib/butlerRoundsRunner.ts")') as () => Promise<{
      useButlerRoundsRunner: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await loadButler();
    const { useButlerRoundsRunner } = await loadRounds();
    const now = Date.now();
    const errands = [
      {
        id: 'approval-run',
        title: '批准发布检查',
        threadId: 'thread-approval',
        workspaceRoot: 'D:/Repos/rocketchatx',
        workspaceName: '主仓',
        readOnly: false,
        startedAt: now - 60_000,
        status: 'awaiting-approval',
        approvals: [{
          id: 'approval-command',
          method: 'item/commandExecution/requestApproval',
          policy: 'actionable',
          params: { command: 'pnpm test' },
          at: now,
        }],
        traces: [],
      },
      {
        id: 'running-run',
        title: '实现纸面进度',
        threadId: 'thread-running',
        workspaceRoot: 'D:/Repos/rocketchatx',
        workspaceName: '主仓',
        readOnly: false,
        startedAt: now - 3 * 60_000,
        status: 'running',
        activity: '正在核对组件',
        approvals: [],
        plan: [
          { step: '锁定回归', status: 'completed' },
          { step: '补齐行内进度', status: 'inProgress' },
        ],
        traces: [
          { id: 'trace-1', at: now - 1_000, kind: 'tool', text: '开始：fileChange' },
          { id: 'trace-2', at: now, kind: 'tool', text: '完成：fileChange' },
        ],
      },
      {
        id: 'replied-run',
        title: '汇总回归结论',
        threadId: 'thread-replied',
        workspaceRoot: 'D:/Repos/rocketchatx',
        workspaceName: '主仓',
        readOnly: true,
        startedAt: now - 5 * 60_000,
        status: 'replied',
        reply: '三层回归均已通过。',
        approvals: [],
        traces: [],
      },
    ];
    (window as Window & { __paperApprovalActions?: unknown[] }).__paperApprovalActions = [];
    (window as Window & { __paperStopActions?: unknown[] }).__paperStopActions = [];
    useButler.setState({
      errands,
      running: false,
      activity: null,
      resolveErrandApproval: async (runId: string, approvalId: string, approved: boolean) => {
        (window as Window & { __paperApprovalActions?: unknown[] }).__paperApprovalActions?.push({
          runId,
          approvalId,
          approved,
        });
        const state = useButler.getState();
        useButler.setState({
          errands: state.errands.map((run) => run.id === runId
            ? { ...run, status: 'running', approvals: [] }
            : run),
        });
      },
      archiveErrand: async (runId: string) => {
        const state = useButler.getState();
        useButler.setState({ errands: state.errands.filter((run) => run.id !== runId) });
      },
      stopErrand: async (runId: string) => {
        (window as Window & { __paperStopActions?: unknown[] }).__paperStopActions?.push(runId);
      },
      ask: async (text: string) => {
        const state = useButler.getState();
        useButler.setState({
          lines: [
            ...state.lines,
            { id: `paper-user-${Date.now()}`, role: 'user', text },
            { id: `paper-answer-${Date.now()}`, role: 'assistant', text: '先核对请求来源与影响范围。' },
          ],
        });
      },
    });
    useButlerRoundsRunner.setState({
      lastRoundsAt: new Date().toISOString(),
      lastResult: {
        generatedAt: new Date().toISOString(),
        checkedCount: 1,
        refTitles: { 'todo:brief': '今天的简报条目' },
        result: {
          headline: '今天',
          summary: '摘要',
          items: [{
            ref: 'todo:brief',
            why: '这件事今天需要你知道。',
            suggestedAction: '先看结论。',
          }],
          proposals: [],
          suppressed: [],
        },
      },
    });
  });
}

async function seedAutomationPaper(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const load = new Function('return import("/src/stores/routines.ts")') as () => Promise<{
      useRoutines: {
        getState: () => { hydrated: boolean };
      };
    }>;
    const { useRoutines } = await load();
    return useRoutines.getState().hydrated;
  })).toBe(true);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/routines.ts")') as () => Promise<{
      useRoutines: {
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useRoutines } = await load();
    const now = Date.now();
    useRoutines.setState({
      routines: [{
        id: 'builtin-morning-brief',
        name: '晨报',
        templateId: 'morning-brief',
        precheck: 'none',
        trigger: { kind: 'daily', time: '08:30' },
        prompt: '测试晨报',
        delivery: 'today',
        enabled: true,
        createdAt: now - 60_000,
        runs: [{
          id: 'morning-run',
          at: now,
          status: 'ok',
          text: '**先回应**\n- Alice 的发布检查清单。',
        }],
      }],
      eventCards: [{
        id: 'event:mention:room-general',
        kind: 'mention-stale',
        rid: 'room-general',
        title: '@我未回应：General（3小时前）',
        detail: '当前仍有 2 条 @我 未处理。',
        at: now,
      }],
      runningIds: [],
      hydrated: true,
    });
  });
}

async function seedYesterdayPaper(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const loadButler = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const loadRounds = new Function('return import("/src/lib/butlerRoundsRunner.ts")') as () => Promise<{
      useButlerRoundsRunner: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await loadButler();
    const { useButlerRoundsRunner } = await loadRounds();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    useButler.setState({
      errands: [{
        id: 'archived-yesterday',
        title: '昨天收下的活',
        threadId: 'thread-yesterday',
        workspaceRoot: 'D:/Repos/rocketchatx',
        workspaceName: '主仓',
        readOnly: false,
        startedAt: yesterday.getTime() - 60_000,
        status: 'replied',
        reply: '昨天已经收好。',
        approvals: [],
        traces: [],
        archivedAt: yesterday.getTime(),
      }],
    });
    useButlerRoundsRunner.setState({
      lastRoundsAt: yesterday.toISOString(),
      lastResult: {
        generatedAt: yesterday.toISOString(),
        checkedCount: 1,
        refTitles: { 'todo:yesterday': '昨天的简报' },
        result: {
          headline: '昨天',
          summary: '摘要',
          items: [{ ref: 'todo:yesterday', why: '这是昨天留下的记录。' }],
          proposals: [],
          suppressed: [],
        },
      },
    });
  });
}

async function seedDispatchDraft(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const loadButler = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { errands: Array<Record<string, unknown>> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const loadEnvironments = new Function('return import("/src/stores/agentEnvironments.ts")') as () => Promise<{
      useAgentEnvironments: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await loadButler();
    const { useAgentEnvironments } = await loadEnvironments();
    useAgentEnvironments.setState({
      environments: [{
        id: 'paper-workspace',
        name: '主仓',
        path: 'D:/Repos/rocketchatx',
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'codex/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      lastDispatchEnvironmentId: 'paper-workspace',
    });
    useButler.setState({
      errandDraft: {
        spec: {
          title: '派出后回到纸',
          goal: '验证同一份 store',
          acceptance: ['纸上出现新行'],
          boundaries: [],
          evidence: [],
        },
        checkpointId: 'dispatch-paper',
      },
      confirmErrandDraft: async () => {
        const state = useButler.getState();
        useButler.setState({
          errandDraft: null,
          errands: [...state.errands, {
            id: 'dispatched-paper',
            title: '派出后回到纸',
            threadId: 'thread-dispatched',
            workspaceRoot: 'D:/Repos/rocketchatx',
            workspaceName: '主仓',
            readOnly: false,
            startedAt: Date.now(),
            status: 'running',
            activity: '正在建立会话',
            approvals: [],
            traces: [],
          }],
        });
      },
    });
  });
}

test('回答引用默认折叠，角标可展开来源并返回原消息', async ({ page }) => {
  const { sentMessages, pageErrors } = await openRoomButlerFromGeneral(page);
  await seedButlerCitationList(page);

  const references = page.getByRole('group', { name: '回答引用' });
  await expect(references.getByText('参考来源（8）', { exact: true })).toBeVisible();
  await expect(page.getByTitle('打开来源：General · Release checklist ready')).toBeHidden();
  const citationMarkers = references.getByRole('button', { name: /^查看参考来源 \d+$/ });
  await expect(citationMarkers).toHaveCount(8);
  await expect(references.getByRole('button', { name: '查看参考来源 1' })).toBeVisible();
  await expect(references.getByRole('button', { name: '查看参考来源 8' })).toBeVisible();
  await expect(references.getByText('1–8', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '房间管家' })).toHaveScreenshot(
    'butler-room-citation-collapsed.png',
    { animations: 'disabled', caret: 'hide' },
  );

  await references.getByRole('button', { name: '查看参考来源 3' }).click();
  await expect(page.getByTitle('打开来源：General · Release checklist ready')).toBeVisible();
  await expect(page.getByTitle('打开来源：General · 引用消息 3')).toBeFocused();
  await expect(references.getByTitle(/^打开来源：/)).toHaveCount(8);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(page.getByRole('dialog', { name: '房间管家' })).toHaveScreenshot(
    'butler-room-citation-expanded-dark.png',
    { animations: 'disabled', caret: 'hide' },
  );
  await page.getByTitle('打开来源：General · Release checklist ready').click();

  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  expect(sentMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('完整管家页可以发送图片和文字', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await captureButlerAsks(page);

  await page.getByLabel('选择管家图片').setInputFiles({
    name: 'release.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image-bytes'),
  });
  await expect(page.getByAltText('release.png')).toBeVisible();
  await page.getByRole('textbox', { name: '给管家发消息' }).fill('分析这张发布截图');
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const captured = await page.evaluate(() => (
    (window as Window & { __capturedButlerAsks?: unknown[] }).__capturedButlerAsks
  ));
  expect(captured).toEqual([{
    text: '分析这张发布截图',
    context: undefined,
    images: [{
      name: 'release.png',
      type: 'image/png',
      size: 11,
      dataUrl: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
    }],
  }]);
  expect(pageErrors).toEqual([]);
});

test('完整管家页可以粘贴图片并发送', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await captureButlerAsks(page);

  const input = page.getByRole('textbox', { name: '给管家发消息' });
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['pasted-image'], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });
  await expect(page.getByAltText('pasted.png')).toBeVisible();
  await input.fill('分析粘贴的截图');
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const captured = await page.evaluate(() => (
    (window as Window & { __capturedButlerAsks?: unknown[] }).__capturedButlerAsks
  ));
  expect(captured).toEqual([{
    text: '分析粘贴的截图',
    context: undefined,
    images: [{
      name: 'pasted.png',
      type: 'image/png',
      size: 12,
      dataUrl: 'data:image/png;base64,cGFzdGVkLWltYWdl',
    }],
  }]);
  expect(pageErrors).toEqual([]);
});

test('房间管家浮层可以仅发送图片并保留房间上下文', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await captureButlerAsks(page);

  await page.getByLabel('选择管家图片').setInputFiles({
    name: 'room.webp',
    mimeType: 'image/webp',
    buffer: Buffer.from('room-image'),
  });
  await page.locator('form').filter({ has: page.getByPlaceholder('问问这个房间的讨论…') })
    .getByRole('button', { name: '发送', exact: true })
    .click();

  const captured = await page.evaluate(() => (
    (window as Window & { __capturedButlerAsks?: unknown[] }).__capturedButlerAsks
  ));
  expect(captured).toEqual([{
    text: '',
    context: { rid: 'room-general', roomName: 'General' },
    images: [{
      name: 'room.webp',
      type: 'image/webp',
      size: 10,
      dataUrl: 'data:image/webp;base64,cm9vbS1pbWFnZQ==',
    }],
  }]);
  expect(pageErrors).toEqual([]);
});

test('房间管家浮层可以粘贴图片并保留房间上下文', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await captureButlerAsks(page);

  const input = page.getByPlaceholder('问问这个房间的讨论…');
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['room-paste'], 'room-paste.webp', { type: 'image/webp' }));
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });
  await expect(page.getByAltText('room-paste.webp')).toBeVisible();
  await page.locator('form').filter({ has: input })
    .getByRole('button', { name: '发送', exact: true })
    .click();

  const captured = await page.evaluate(() => (
    (window as Window & { __capturedButlerAsks?: unknown[] }).__capturedButlerAsks
  ));
  expect(captured).toEqual([{
    text: '',
    context: { rid: 'room-general', roomName: 'General' },
    images: [{
      name: 'room-paste.webp',
      type: 'image/webp',
      size: 10,
      dataUrl: 'data:image/webp;base64,cm9vbS1wYXN0ZQ==',
    }],
  }]);
  expect(pageErrors).toEqual([]);
});

test('取消待办草案不会产生本地副作用', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '转待办', exact: true }).click();
  await expect(page.getByLabel('待办草案')).toContainText('等待确认');
  await page.getByLabel('动作标题').fill('确认发布清单');
  expect(await page.evaluate(() => localStorage.getItem('rcx-todos'))).toBeNull();
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await expect(page.getByLabel('待办草案')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('rcx-todos'))).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('取消动作后回到纸不会伪造在办项', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '转待办', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await openButlerNowView(page);
  await expect(page.getByRole('region', { name: '在办' })).toHaveCount(0);
  await expect(
    page.getByLabel('管家空状态').or(page.getByRole('region', { name: '今日整理状态' })),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('带待确认动作开启新对话时按原会话保留 checkpoint', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '转待办', exact: true }).click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByLabel('待办草案')).toHaveCount(0);

  await page
    .getByRole('navigation', { name: '管家对话历史' })
    .getByRole('button')
    .filter({ hasText: '发布前还缺什么？' })
    .click();
  await expect(page.getByLabel('待办草案')).toContainText('等待确认');
  expect(pageErrors).toEqual([]);
});

test('确认待办会保存编辑内容与截止日期', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '转待办', exact: true }).click();
  await page.getByLabel('动作标题').fill('确认发布清单');
  await page.getByLabel('动作内容').fill('请 Alice 在发布前确认完整清单');
  await page.getByLabel('截止日期').fill('2026-07-25');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();

  await expect(page.getByText(/✅ 已创建待办/)).toBeVisible();
  const [todo] = await page.evaluate(() => JSON.parse(localStorage.getItem('rcx-todos') ?? '[]'));
  expect(todo).toMatchObject({
    source: 'manual',
    title: '确认发布清单',
    note: '请 Alice 在发布前确认完整清单',
    due: '2026-07-25',
    done: false,
  });
  expect(pageErrors).toEqual([]);
});

test('承诺缺少对象时阻止执行，补齐后才保存', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '记承诺', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByText('请填写“我答应给谁”', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('rcx-todos'))).toBeNull();

  await page.getByLabel('我答应给谁').fill('Alice');
  await page.getByLabel('截止日期').fill('2026-07-24');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();

  await expect(page.getByText(/✅ 已记录承诺/)).toBeVisible();
  const [todo] = await page.evaluate(() => JSON.parse(localStorage.getItem('rcx-todos') ?? '[]'));
  expect(todo).toMatchObject({ committedTo: 'Alice', due: '2026-07-24', done: false });
  expect(pageErrors).toEqual([]);
});

test('确认回复只回填原会话草稿，不调用发送接口', async ({ page }) => {
  const { sentMessages, pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '拟回复', exact: true }).click();
  await page.getByLabel('动作内容').fill('Alice，发布清单我已确认。');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();

  await expect(page.getByPlaceholder(/输入消息/)).toHaveValue('Alice，发布清单我已确认。');
  expect(sentMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('ADO 未配置时在进入执行态和打开创建表单前完成能力预检', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '建 ADO', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '创建工作项' })).toHaveCount(0);
  await expect(page.getByLabel('ADO 工作项草案')).toContainText('等待确认');
  await page.getByRole('button', { name: '继续填写', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '创建工作项' });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('请先在设置中配置 ADO 直连', { exact: true })).toBeVisible();
  await expect(page.getByLabel('ADO 工作项草案')).toContainText('等待确认');
  expect(pageErrors).toEqual([]);
});

test('从房间进入管家恢复普通会话，房间问答留在独立历史', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await openButlerConversationView(page);
  await seedStandaloneButlerAnswer(page, '整理我的本周工作', '这是普通管家会话。');
  await expect(page.getByText('这是普通管家会话。', { exact: true })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
  await page.getByRole('button', { name: '打开房间管家', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '房间管家' })).toBeVisible();
  await seedButlerAnswer(page);
  await expect(page.getByText(ANSWER, { exact: false }).first()).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await openButlerConversationView(page);

  const conversationPane = page.locator('.butler-conversation-pane');
  await expect(conversationPane.getByText('这是普通管家会话。', { exact: true })).toBeVisible();
  await expect(conversationPane.getByText(ANSWER, { exact: false })).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: '管家对话历史' })
      .getByRole('button')
      .filter({ hasText: 'General · 发布前还缺什么' }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('普通管家运行中打开房间浮层不会停止或切换当前会话', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  const activeSessionId = await seedStandaloneButlerAnswer(
    page,
    '继续整理发布计划',
    '普通管家任务还在进行。',
  );
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { stop: () => Promise<void> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    const testWindow = window as Window & {
      __butlerOriginalStop?: () => Promise<void>;
      __butlerStopCalls?: number;
    };
    testWindow.__butlerOriginalStop = useButler.getState().stop;
    testWindow.__butlerStopCalls = 0;
    useButler.setState({
      running: true,
      stop: async () => {
        testWindow.__butlerStopCalls = (testWindow.__butlerStopCalls ?? 0) + 1;
      },
    });
  });

  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
  await page.getByRole('button', { name: '打开房间管家', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '房间管家' })).toBeVisible();
  await expect(page.getByRole('button', { name: '管家正在处理其他内容' })).toBeDisabled();

  const state = await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { activeSessionId: string; running: boolean };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    const testWindow = window as Window & {
      __butlerOriginalStop?: () => Promise<void>;
      __butlerStopCalls?: number;
    };
    const result = {
      activeSessionId: useButler.getState().activeSessionId,
      running: useButler.getState().running,
      stopCalls: testWindow.__butlerStopCalls ?? 0,
    };
    useButler.setState({
      running: false,
      ...(testWindow.__butlerOriginalStop ? { stop: testWindow.__butlerOriginalStop } : {}),
    });
    return result;
  });

  expect(state).toEqual({ activeSessionId, running: true, stopCalls: 0 });
  expect(pageErrors).toEqual([]);
});

test('AI 托管记录出现在管家历史，查看时不抢走普通会话', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  const activeSessionId = await seedStandaloneButlerAnswer(
    page,
    '我当前有哪些工作',
    '普通管家对话仍在这里。',
  );
  await expect(page.getByText('普通管家对话仍在这里。', { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const loadAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<{
      useSharedAgent: { setState: (state: Record<string, unknown>) => void };
    }>;
    const loadChat = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        setState: (
          update: (state: { messages: Record<string, unknown[]> }) => Record<string, unknown>,
        ) => void;
      };
    }>;
    const { useSharedAgent } = await loadAgent();
    const { useChat } = await loadChat();
    useSharedAgent.setState({
      sessions: {
        'room:room-general': {
          sessionId: 'hosted-general',
          serverId: window.location.origin,
          ownerUserId: 'user-me',
          rid: 'room-general',
          tmid: 'room:room-general',
          host: {
            userId: 'user-me',
            deviceId: 'device-test',
            heartbeatAt: Date.now(),
            expiresAt: Date.now() + 90_000,
          },
          access: 'room-members',
          approvedMemberIds: [],
          status: 'ready',
          workspaceRoots: ['D:/Repos/demo'],
          sandboxMode: 'read-only',
          updatedAt: Date.now(),
        },
      },
    });
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'room-general': [
          ...(state.messages['room-general'] ?? []),
          {
            _id: 'hosted-question',
            rid: 'room-general',
            msg: '@ai 检查发布失败原因',
            ts: '2026-07-21T08:01:00.000Z',
            u: { _id: 'user-me', username: 'tester', name: 'Test User' },
          },
          {
            _id: 'hosted-answer',
            rid: 'room-general',
            msg: '🤖 Codex\n已经定位到签名步骤。',
            ts: '2026-07-21T08:02:00.000Z',
            u: { _id: 'ai', username: 'ai', name: 'RocketX AI' },
          },
        ],
      },
    }));
  });

  const hostedHistory = page
    .getByRole('navigation', { name: '管家对话历史' })
    .getByRole('button')
    .filter({ hasText: 'General · 检查发布失败原因' });
  await expect(hostedHistory).toBeVisible();
  await hostedHistory.click();

  await expect(page.getByText('AI 托管记录', { exact: true })).toBeVisible();
  await expect(page.getByText('已经定位到签名步骤。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '给管家发消息' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重命名会话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除会话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '回到「General」' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { getState: () => { activeSessionId: string } };
    }>;
    return (await load()).useButler.getState().activeSessionId;
  })).toBe(activeSessionId);
  expect(pageErrors).toEqual([]);
});

test('房间管家全屏后直接进入同一段完整对话', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '全屏打开完整对话', exact: true }).click();

  await expect(page.getByRole('region', { name: '完整对话' })).toBeVisible();
  await expect(page.getByText(ANSWER, { exact: false }).first()).toBeVisible();
  await expect(page.getByText('当前工作面：General', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: '管家对话历史' })
      .getByRole('button')
      .filter({ hasText: 'General · 发布前还缺什么' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: '完整对话' })).toHaveScreenshot(
    'butler-room-conversation-auto-title.png',
    { animations: 'disabled', caret: 'hide' },
  );
  expect(pageErrors).toEqual([]);
});

test('房间管家全屏即使还没问过也保留当前房间上下文', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await load();
    useButler.setState({ context: null });
  });

  await page.getByRole('button', { name: '全屏打开完整对话', exact: true }).click();

  await expect(page.getByRole('region', { name: '完整对话' })).toBeVisible();
  await expect(page.getByText('当前工作面：General', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('房间管家可以拖动调宽并在重新打开后保留宽度', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  const panel = page.getByRole('dialog', { name: '房间管家' });
  const resizer = page.getByRole('separator', { name: '调整房间管家宽度' });
  const before = await panel.boundingBox();
  const handle = await resizer.boundingBox();
  expect(before).not.toBeNull();
  expect(handle).not.toBeNull();

  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x - 80, handle!.y + handle!.height / 2, { steps: 4 });
  await page.mouse.up();

  const resized = await panel.boundingBox();
  expect(resized).not.toBeNull();
  expect(resized!.width).toBeGreaterThan(before!.width + 60);

  await page.getByRole('button', { name: '关闭房间管家', exact: true }).click();
  await page.getByRole('button', { name: '打开房间管家', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '房间管家' })).toBeVisible();
  const reopened = await panel.boundingBox();
  expect(reopened).not.toBeNull();
  expect(Math.abs(reopened!.width - resized!.width)).toBeLessThanOrEqual(1);
  expect(pageErrors).toEqual([]);
});

test('房间管家宽度支持键盘调整与 Home 恢复默认', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  const panel = page.getByRole('dialog', { name: '房间管家' });
  const resizer = page.getByRole('separator', { name: '调整房间管家宽度' });
  const initial = await panel.boundingBox();
  expect(initial).not.toBeNull();

  await resizer.focus();
  await resizer.press('ArrowLeft');
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initial!.width);

  await resizer.press('Home');
  await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0))
    .toBe(Math.round(initial!.width));
  expect(pageErrors).toEqual([]);
});

test('房间管家浮层不会带入后续无房间来源的全局回执', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await load();
    const roomSource = {
      kind: 'room',
      id: 'room-general',
      rid: 'room-general',
      label: 'General',
    };
    useButler.setState({
      lines: [
        { id: 'room-question', role: 'user', text: 'General 这轮问答', sources: [roomSource] },
        { id: 'global-receipt', role: 'assistant', text: '📌 全局记忆已经写入' },
      ],
      running: false,
      error: null,
    });
  });
  const panel = page.getByRole('dialog', { name: '房间管家' });
  await expect(panel).toContainText('General 这轮问答');
  await expect(panel.getByText('📌 全局记忆已经写入', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('房间管家浮层保留本房间全部问答并隔离其他房间', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await load();
    const generalSource = {
      kind: 'room',
      id: 'room-general',
      rid: 'room-general',
      label: 'General',
    };
    const alphaSource = {
      kind: 'room',
      id: 'room-alpha',
      rid: 'room-alpha',
      label: 'Project Alpha',
    };
    useButler.setState({
      lines: [
        { id: 'general-question-1', role: 'user', text: 'General 第一问', sources: [generalSource] },
        { id: 'general-answer-1', role: 'assistant', text: 'General 第一答', sources: [generalSource] },
        { id: 'alpha-question', role: 'user', text: 'Alpha 的问题', sources: [alphaSource] },
        { id: 'alpha-answer', role: 'assistant', text: 'Alpha 的回答', sources: [alphaSource] },
        { id: 'general-question-2', role: 'user', text: 'General 第二问', sources: [generalSource] },
        { id: 'general-answer-2', role: 'assistant', text: 'General 第二答', sources: [generalSource] },
      ],
      running: false,
      error: null,
    });
  });
  const panel = page.getByRole('dialog', { name: '房间管家' });
  await expect(panel.getByText('你：General 第一问', { exact: true })).toBeVisible();
  await expect(panel.getByText('General 第一答', { exact: false }).first()).toBeVisible();
  await expect(panel.getByText('你：General 第二问', { exact: true })).toBeVisible();
  await expect(panel.getByText('General 第二答', { exact: false }).first()).toBeVisible();
  await expect(panel.getByText('你：Alpha 的问题', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Alpha 的回答', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('可新建、重命名并切换独立的管家会话', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await openButlerConversationView(page);
  await seedButlerAnswer(page);

  const history = page.getByRole('navigation', { name: '管家对话历史' });
  await expect(history).toBeVisible();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByText(ANSWER, { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: '重命名会话', exact: true }).click();
  await page.getByRole('textbox', { name: '会话名称', exact: true }).fill('构建调查');
  await page.getByRole('button', { name: '保存会话名称', exact: true }).click();
  await expect(page.getByRole('heading', { name: '构建调查', exact: true })).toBeVisible();
  await expect(history).toContainText('构建调查');

  await history.getByRole('button').filter({ hasText: '发布前还缺什么？' }).click();
  await expect(page.getByText(ANSWER, { exact: false }).first()).toBeVisible();
  await history.getByRole('button').filter({ hasText: '构建调查' }).click();
  await expect(page.getByText(ANSWER, { exact: false })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('memory.write 需要显式审批，确认后才写入 v2 记忆', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  const seeded = await seedMemoryApproval(page);

  expect(seeded.status).toBe('approval-required');
  await expect(page.getByLabel('待批准的管家操作')).toContainText('写入长期记忆');
  expect(await page.evaluate(() => (window as Window & { __butlerMemoryEntries?: Map<string, string> }).__butlerMemoryEntries?.get('rcx-butler-v2:memory') ?? null)).toBeNull();

  await page.getByRole('button', { name: '确认执行', exact: true }).click();

  await expect(page.getByLabel('待批准的管家操作')).toHaveCount(0);
  await expect(page.getByText('📌 已记录 preference 记忆（room:general）：reply-style = 默认简短回复', { exact: true })).toBeVisible();
  const records = await page.evaluate(async () => {
    const loadMemory = new Function('return import("/src/lib/butlerMemory.ts")') as () => Promise<{
      parseButlerMemoryState: (raw: string) => {
        records: Array<{
          kind: string;
          status: string;
          subject: string;
          value: string;
          scope: Record<string, string>;
        }>;
      };
    }>;
    const { parseButlerMemoryState } = await loadMemory();
    const raw = (window as Window & { __butlerMemoryEntries?: Map<string, string> }).__butlerMemoryEntries?.get('rcx-butler-v2:memory') ?? '';
    return parseButlerMemoryState(raw).records.map((record) => ({
      kind: record.kind,
      status: record.status,
      subject: record.subject,
      value: record.value,
      scope: record.scope,
    }));
  });
  expect(records).toEqual([{
    kind: 'preference',
    status: 'active',
    subject: 'reply-style',
    value: '默认简短回复',
    scope: {
      server: 'https://chat.example',
      account: 'alice',
      room: 'general',
    },
  }]);
  expect(pageErrors).toEqual([]);
});

test('主动 workflow 的写审批可见，但隐藏 session 不进入对话历史', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  const seeded = await seedWorkflowMemoryApproval(page);

  expect(seeded.status).toBe('approval-required');
  expect(seeded.hidden).toBe(true);
  const approvals = page.getByLabel('待批准的管家操作');
  await expect(approvals).toContainText('写入长期记忆');
  const visibleSessionIds = await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { getState: () => { sessions: Array<{ id: string }> } };
    }>;
    return (await loadStore()).useButler.getState().sessions.map((session) => session.id);
  });
  expect(visibleSessionIds).not.toContain(seeded.sessionId);
  await expect(page.getByRole('navigation', { name: '管家对话历史' })).not.toContainText('workflow:');
  expect(await page.evaluate(() => (
    (window as Window & { __butlerWorkflowMemoryEntries?: Map<string, string> })
      .__butlerWorkflowMemoryEntries?.get('rcx-butler-v2:memory') ?? null
  ))).toBeNull();

  await approvals.getByRole('button', { name: '确认执行', exact: true }).click();

  await expect(approvals).toHaveCount(0);
  const completed = await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      listButlerWorkflowSnapshots: () => Array<{
        key: string;
        taskState: { status: string } | null;
        engineState: { status: string };
      }>;
    }>;
    const { listButlerWorkflowSnapshots } = await loadStore();
    const snapshot = listButlerWorkflowSnapshots()
      .find((item) => item.key === 'routine:ui-memory');
    return {
      taskStatus: snapshot?.taskState?.status,
      engineStatus: snapshot?.engineState.status,
      memory: (window as Window & { __butlerWorkflowMemoryEntries?: Map<string, string> })
        .__butlerWorkflowMemoryEntries?.get('rcx-butler-v2:memory') ?? null,
    };
  });
  expect(completed).toMatchObject({
    taskStatus: 'completed',
    engineStatus: 'ready',
  });
  expect(completed.memory).not.toBeNull();
  expect(pageErrors).toEqual([]);
});

test('在办活在纸、完整对话和房间浮层共享同一份可见状态', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await seedErrandSurface(page);
  await expect(page.getByLabel('管家活状态')).toHaveText('0 件等你 · 1 在办');
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByText('发布前核对清单', { exact: true })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByText('发布前核对清单', { exact: true })).toBeVisible();

  await openButlerConversationView(page);
  await page.getByText('1 件在办', { exact: true }).click();
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByText('发布前核对清单', { exact: true })).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('纸按审批和在办责任渲染，审批原文与动作可用', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedPaperSections(page);

  await expect(page.getByRole('region', { name: '等你点头' })).toBeVisible();
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByRole('button', { name: '展开汇总回归结论' })).toBeVisible();
  await expect(page.getByText(/pnpm test/)).toBeVisible();

  await page.getByRole('button', {
    name: '追问批准发布检查为什么需要审批',
    exact: true,
  }).click();
  await expect(page.getByLabel('纸上问答')).toContainText('pnpm test');
  await page.getByRole('button', { name: '允许批准发布检查', exact: true }).click();
  expect(await page.evaluate(() => (
    (window as Window & { __paperApprovalActions?: unknown[] }).__paperApprovalActions
  ))).toEqual([{ runId: 'approval-run', approvalId: 'approval-command', approved: true }]);
  await expect(page.getByRole('region', { name: '等你点头' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByRole('button', { name: '展开汇总回归结论' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('每日整理失败或运行时不会被画成空纸', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();

  await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/butlerRoundsRunner.ts")') as () => Promise<{
      useButlerRoundsRunner: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButlerRoundsRunner } = await load();
    useButlerRoundsRunner.setState({
      lastResult: null,
      running: false,
      error: '测试整理失败',
    });
  });

  await expect(page.getByRole('region', { name: '今日整理状态' }))
    .toContainText('今天的整理没有完成');
  await expect(page.getByRole('region', { name: '今日整理状态' })
    .getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.getByLabel('管家空状态')).toHaveCount(0);

  await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/butlerRoundsRunner.ts")') as () => Promise<{
      useButlerRoundsRunner: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButlerRoundsRunner } = await load();
    useButlerRoundsRunner.setState({ running: true, error: null });
  });

  await expect(page.getByRole('region', { name: '今日整理状态' }))
    .toContainText('正在整理今天');
  await expect(page.getByLabel('管家空状态')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('自动整理结果和超时提醒直接回到纸面，提醒能跳回对应房间', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedAutomationPaper(page);

  const automation = page.getByRole('region', { name: '消息与提醒' });
  await expect(automation).toContainText('晨报');
  await expect(automation).toContainText('@我未回应：General（3小时前）');
  await expect(page.getByLabel('晨报摘要')).toBeVisible();
  await expect(page.getByLabel('晨报摘要')).toContainText('Alice 的发布检查清单');
  await expect(page.getByLabel('管家空状态')).toHaveCount(0);

  await page.getByRole('button', { name: '展开晨报报告', exact: true }).click();
  await expect(automation).toContainText('Alice 的发布检查清单');

  await page.getByRole('button', { name: '查看 General 的 @我', exact: true }).click();
  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('未开启的自动整理在纸底可发现，消息能力有真实装载与选房入口', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();

  await page.getByRole('button', { name: '自动整理未开启，打开设置', exact: true }).click();
  const routines = page.getByRole('region', { name: '正在照看' });
  await expect(routines).toContainText('晨报');
  await expect(routines).toContainText('晚间回顾');
  await expect(routines).toContainText('有人 @ 我，先帮我看');
  await expect(routines).toContainText('群里聊了什么，晚上给我一份');

  await page.getByRole('button', {
    name: '开启有人 @ 我，先帮我看',
    exact: true,
  }).click();
  await expect(page.getByRole('checkbox', {
    name: '启用有人 @ 我，先帮我看',
    exact: true,
  })).toBeChecked();

  await page.getByRole('button', {
    name: '选择房间以开启群里聊了什么，晚上给我一份',
    exact: true,
  }).click();
  await expect(page.getByText('至少选择一个房间', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '汇总 General', exact: true }).check();
  await page.getByRole('button', { name: '开启房间汇总', exact: true }).click();
  await expect(page.getByRole('checkbox', {
    name: '启用群里聊了什么，晚上给我一份',
    exact: true,
  })).toBeChecked();

  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page
    .getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: /^例行照看/ })
    .click();
  await page.getByText('管理例行事务', { exact: true }).click();
  await expect(page.getByRole('checkbox', {
    name: '启用有人 @ 我，先帮我看',
    exact: true,
  })).toBeChecked();
  await expect(page.getByRole('checkbox', {
    name: '启用群里聊了什么，晚上给我一份',
    exact: true,
  })).toBeChecked();
  await expect.poll(() => page.evaluate(async () => {
    const load = new Function('return import("/src/stores/routines.ts")') as () => Promise<{
      useRoutines: {
        getState: () => {
          routines: Array<{ templateId?: string; params?: { rooms?: string[] } }>;
        };
      };
    }>;
    const { useRoutines } = await load();
    return useRoutines.getState().routines
      .find((routine) => routine.templateId === 'room-digest')
      ?.params?.rooms ?? [];
  })).toContain('General');
  expect(pageErrors).toEqual([]);
});

test('纸上临时问答失败时原位解释并可重新发送', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { lines: Array<Record<string, unknown>> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    let attempts = 0;
    useButler.setState({
      activeSessionId: '',
      errands: [],
      error: null,
      running: false,
      hydrate: async () => {
        useButler.setState({ activeSessionId: 'hydrated-session' });
      },
      ask: async (text: string) => {
        attempts += 1;
        const state = useButler.getState();
        useButler.setState(attempts === 1 ? {
          lines: [...state.lines, { id: 'failed-question', role: 'user', text }],
          error: 'Codex 暂时不可用，请检查登录状态。',
          running: false,
        } : {
          lines: [
            ...state.lines,
            { id: 'retry-question', role: 'user', text },
            { id: 'retry-answer', role: 'assistant', text: `已恢复：${text}` },
          ],
          error: null,
          running: false,
        });
      },
    });
  });

  await page.getByRole('textbox', { name: '跟管家说件事' }).fill('帮我看看今天');
  await page.getByRole('button', { name: '交给管家', exact: true }).click();
  const exchange = page.getByRole('region', { name: '临时问答' });
  await expect(exchange).toContainText('Codex 暂时不可用，请检查登录状态。');
  await expect.poll(() => page.evaluate(async () => {
    const load = new Function('return import("/src/stores/ui.ts")') as () => Promise<{
      useUI: {
        getState: () => {
          butlerPaperConversation: { sessionId: string } | null;
        };
      };
    }>;
    const { useUI } = await load();
    return useUI.getState().butlerPaperConversation?.sessionId ?? null;
  })).toBe('hydrated-session');

  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { lines: Array<Record<string, unknown>> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    useButler.setState({
      lines: [
        ...useButler.getState().lines,
        { id: 'later-question', role: 'user', text: '完整对话里的后续问题' },
        { id: 'later-answer', role: 'assistant', text: '后续回答' },
      ],
      error: null,
    });
  });
  await expect(exchange).toContainText('Codex 暂时不可用，请检查登录状态。');

  await page.getByRole('button', { name: '重新发送临时问答', exact: true }).click();
  await expect(exchange).toContainText('已恢复：帮我看看今天');
  await expect.poll(() => page.evaluate(async () => {
    const load = new Function('return import("/src/stores/ui.ts")') as () => Promise<{
      useUI: {
        getState: () => {
          butlerPaperConversation: { rounds: number } | null;
        };
      };
    }>;
    const { useUI } = await load();
    return useUI.getState().butlerPaperConversation?.rounds ?? 0;
  })).toBe(1);
  expect(pageErrors).toEqual([]);
});

test('纸上临时问答只属于发起当天，不会跨日期串到新纸', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();

  await page.getByRole('textbox', { name: '跟管家说件事' }).fill('只留在今天');
  await page.getByRole('button', { name: '交给管家', exact: true }).click();
  await expect(page.getByRole('region', { name: '临时问答' })).toContainText('只留在今天');

  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await expect(page.getByRole('region', { name: '临时问答' })).toHaveCount(0);
  await page.getByRole('button', { name: '后一天', exact: true }).click();
  await expect(page.getByRole('region', { name: '临时问答' })).toContainText('只留在今天');
  expect(pageErrors).toEqual([]);
});

test('在办行内展开当前进度，回话结论展开后可以收下', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedPaperSections(page);

  const runningRow = page.getByRole('button', { name: '展开实现纸面进度', exact: true });
  await runningRow.click();
  await expect(page.getByRole('button', {
    name: '折叠实现纸面进度',
    exact: true,
  })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('实现纸面进度 的 TODO')).toContainText('锁定回归');
  await expect(page.getByLabel('实现纸面进度 的 TODO')).toContainText('补齐行内进度');
  const processTail = page.getByLabel('实现纸面进度 的过程尾巴');
  await expect(processTail).toContainText('过程尾巴');
  await expect(processTail).toContainText('完成：fileChange');
  await expect(page.getByRole('button', {
    name: '复制 codex resume thread-running',
    exact: true,
  })).toBeVisible();
  await page.getByRole('button', { name: '叫停实现纸面进度', exact: true }).click();
  expect(await page.evaluate(() => (
    (window as Window & { __paperStopActions?: unknown[] }).__paperStopActions
  ))).toEqual(['running-run']);

  await page.getByRole('button', { name: '展开汇总回归结论', exact: true }).click();
  await expect(page.getByText('三层回归均已通过。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收下汇总回归结论', exact: true }).click();
  await expect(page.getByText('汇总回归结论', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('翻到昨天只读显示当天简报与收下的活，再往前为空时诚实说明', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedYesterdayPaper(page);

  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await expect(page.getByRole('region', { name: '收下的活' })).toContainText('昨天收下的活');
  await expect(page.getByRole('region', { name: '那天' })).toContainText('昨天的简报');
  await expect(page.getByRole('textbox', { name: '跟管家说件事' })).toHaveCount(0);

  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await expect(page.getByText('这天没有留下记录', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('纸上连续第 3 轮自动升级完整对话并保留前两轮', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedPaperSections(page);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { lines: Array<Record<string, unknown>> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    useButler.setState({
      errands: [],
      ask: async (text: string) => {
        const state = useButler.getState();
        useButler.setState({
          lines: [
            ...state.lines,
            { id: `user-${text}`, role: 'user', text },
            { id: `assistant-${text}`, role: 'assistant', text: `答：${text}` },
          ],
        });
      },
    });
  });

  const input = page.getByRole('textbox', { name: '跟管家说件事' });
  for (const question of ['第一轮', '第二轮']) {
    await input.fill(question);
    await page.getByRole('button', { name: '交给管家', exact: true }).click();
    await expect(page.getByLabel('纸上问答')).toContainText(`答：${question}`);
  }
  await input.fill('第三轮');
  await page.getByRole('button', { name: '交给管家', exact: true }).click();

  await expect(
    page
      .getByRole('navigation', { name: '管家工作视图' })
      .getByRole('button', { name: /^现在/ }),
  ).toBeVisible();
  const userMessages = page.getByLabel('你说');
  await expect(userMessages.getByText('第一轮', { exact: true })).toBeVisible();
  await expect(userMessages.getByText('第二轮', { exact: true })).toBeVisible();
  await expect(userMessages.getByText('第三轮', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('规格卡派出后回到纸就在在办区出现新行', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedDispatchDraft(page);
  await openButlerConversationView(page);

  await expect(page.getByText('任务规格', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '派出去', exact: true }).click();
  await openButlerNowView(page);

  await expect(page.getByRole('region', { name: '在办' })).toContainText('派出后回到纸');
  expect(pageErrors).toEqual([]);
});
