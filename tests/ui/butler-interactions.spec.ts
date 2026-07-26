import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated, type RocketChatMockState } from './support/rocket-chat-mock';

const ANSWER = '发布前需要 Alice 确认检查清单。';

async function openButlerFromGeneral(page: Page): Promise<RocketChatMockState> {
  const state = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '查看完整对话', exact: true }).click();
  await expect(page.getByText('当前工作面：General', { exact: true })).toBeVisible();
  return state;
}

async function openRoomButlerFromGeneral(page: Page): Promise<RocketChatMockState> {
  const state = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开房间管家', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '房间管家' })).toBeVisible();
  return state;
}

async function seedButlerAnswer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButler } = await load();
    useButler.setState({
      lines: [
        { id: 'question', role: 'user', text: '发布前还缺什么？' },
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
  });
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
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

test('来源标签可返回原消息且不会发送消息', async ({ page }) => {
  const { sentMessages, pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

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
  await page.getByPlaceholder('继续说……').fill('分析这张发布截图');
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

  const input = page.getByPlaceholder('继续说……');
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
  await page.getByRole('button', { name: '回到纸', exact: true }).click();
  await expect(page.getByRole('region', { name: '在办' })).toHaveCount(0);
  await expect(page.getByLabel('管家空状态')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('带待确认动作开启新对话时按原会话保留 checkpoint', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '转待办', exact: true }).click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByLabel('待办草案')).toHaveCount(0);

  await page.getByLabel('管家会话').selectOption('default');
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

test('房间管家浮层与管家页共享同一份会话', async ({ page }) => {
  const { pageErrors } = await openRoomButlerFromGeneral(page);
  await seedButlerAnswer(page);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '查看完整对话', exact: true }).click();

  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
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

test('可新建、重命名并切换独立的管家会话', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '查看完整对话', exact: true }).click();
  await seedButlerAnswer(page);

  const sessionSelect = page.getByLabel('管家会话');
  await expect(sessionSelect).toHaveValue('default');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '重命名会话', exact: true }).click();
  await page.getByRole('textbox', { name: '会话名称', exact: true }).fill('构建调查');
  await page.getByRole('button', { name: '保存会话名称', exact: true }).click();
  await expect(sessionSelect.locator('option:checked')).toHaveText('构建调查');

  await sessionSelect.selectOption('default');
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await sessionSelect.selectOption({ label: '构建调查' });
  await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(0);
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

test('主动 workflow 的写审批可见，但隐藏 session 不进入会话选择器', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  const seeded = await seedWorkflowMemoryApproval(page);

  expect(seeded.status).toBe('approval-required');
  expect(seeded.hidden).toBe(true);
  const approvals = page.getByLabel('待批准的管家操作');
  await expect(approvals).toContainText('写入长期记忆');
  const sessionOptions = await page.getByLabel('管家会话').locator('option').evaluateAll(
    (options) => options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      text: option.textContent ?? '',
    })),
  );
  expect(sessionOptions.some((option) => (
    option.value === seeded.sessionId || option.text.includes('workflow:')
  ))).toBe(false);
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

  await page.getByRole('button', { name: '查看完整对话', exact: true }).click();
  await page.getByText('1 件在办', { exact: true }).click();
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByText('发布前核对清单', { exact: true })).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('纸的三区按数据渲染，空区不占位置，审批原文与动作可用', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedPaperSections(page);

  await expect(page.getByRole('region', { name: '等你点头' })).toBeVisible();
  await expect(page.getByRole('region', { name: '在办' })).toBeVisible();
  await expect(page.getByRole('region', { name: '今天' })).toBeVisible();
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
  await expect(page.getByRole('region', { name: '今天' })).toBeVisible();
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
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByLabel('纸上问答')).toContainText(`答：${question}`);
  }
  await input.fill('第三轮');
  await page.getByRole('button', { name: '发送', exact: true }).click();

  await expect(page.getByRole('button', { name: '回到纸', exact: true })).toBeVisible();
  await expect(page.getByText('第一轮', { exact: true })).toBeVisible();
  await expect(page.getByText('第二轮', { exact: true })).toBeVisible();
  await expect(page.getByText('第三轮', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('规格卡派出后回到纸就在在办区出现新行', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await seedDispatchDraft(page);
  await page.getByRole('button', { name: '查看完整对话', exact: true }).click();

  await expect(page.getByText('任务规格', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '派出去', exact: true }).click();
  await page.getByRole('button', { name: '回到纸', exact: true }).click();

  await expect(page.getByRole('region', { name: '在办' })).toContainText('派出后回到纸');
  expect(pageErrors).toEqual([]);
});
