import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated, type RocketChatMockState } from './support/rocket-chat-mock';

const ANSWER = '发布前需要 Alice 确认检查清单。';

async function openButlerFromGeneral(page: Page): Promise<RocketChatMockState> {
  const state = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await expect(page.getByText('Release checklist ready', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '展开对话', exact: true }).click();
  await expect(page.getByText('当前工作面：General', { exact: true })).toBeVisible();
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
  await page.getByPlaceholder(/例如：搜索张三/).fill('分析这张发布截图');
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

test('房间管家侧栏可以仅发送图片并保留房间上下文', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
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

test('取消动作会在管家页留下可见审计记录', async ({ page }) => {
  const { pageErrors } = await openButlerFromGeneral(page);
  await seedButlerAnswer(page);

  await page.getByRole('button', { name: '转待办', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '收起对话', exact: true }).click();
  await page.getByText(/^工作日志 ·/).click();

  await expect(page.getByText('待办 · 已取消', { exact: true })).toBeVisible();
  await expect(page.getByText('待办 · 已提议', { exact: true })).toBeVisible();
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

test('房间 AI 侧栏与管家页共享同一份会话', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.locator('button[title*="右键更多操作"]').filter({ hasText: 'General' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await seedButlerAnswer(page);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '展开对话', exact: true }).click();

  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('可新建、重命名并切换独立的管家会话', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page.getByRole('button', { name: '展开对话', exact: true }).click();
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
  await expect.poll(() => page.evaluate(async () => {
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
      memoryWritten: Boolean(
        (window as Window & { __butlerWorkflowMemoryEntries?: Map<string, string> })
          .__butlerWorkflowMemoryEntries?.get('rcx-butler-v2:memory'),
      ),
    };
  })).toEqual({
    taskStatus: 'completed',
    engineStatus: 'ready',
    memoryWritten: true,
  });
  expect(pageErrors).toEqual([]);
});
