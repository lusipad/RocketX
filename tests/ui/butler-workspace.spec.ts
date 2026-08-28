import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated, TEST_SERVER } from './support/rocket-chat-mock';

async function bootWithAiRuntime(page: Page, provider: 'codex' | 'deepseek'): Promise<void> {
  await page.addInitScript((nextProvider) => {
    localStorage.setItem('rocketx.butler.task-provider', nextProvider);
  }, provider);
  await bootAuthenticated(page);
}

async function installCodexRuntime(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const loadAuth = new Function('return import("/src/stores/auth.ts")') as () => Promise<any>;
    const loadClient = new Function('return import("/src/lib/client.ts")') as () => Promise<any>;
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    const [{
      resetCodexWorkspaceForTests,
      setCodexWorkspaceControllerFactory,
      useCodexWorkspace,
    }, { useAuth }, { getServerBase }, { useUI }] = await Promise.all([
      loadWorkspace(),
      loadAuth(),
      loadClient(),
      loadUI(),
    ]);

    await resetCodexWorkspaceForTests();
    useUI.setState({
      aiRuntimeProvider: 'codex',
    });
    const testWindow = window as typeof window & {
      __codexMethods?: string[];
      __codexTurns?: Array<{ text: string; mode: string }>;
      __codexControllerOptions?: Record<string, (...args: any[]) => any>;
      __codexCatalog?: any;
      __codexControllerCount?: number;
      __codexStopCount?: number;
      __codexInterruptCount?: number;
      __codexListRoots?: string[][];
      __tauriInvocations?: Array<{ command: string; args?: Record<string, unknown> }>;
      __dialogOpenResponses?: Array<string | string[] | null>;
      __codexAdditionalThreadRoots?: string[];
      __codexAutomationFiles?: Record<string, string>;
      __appendExternalCodexTurn?: (threadId: string, text: string) => void;
    };
    testWindow.__codexMethods = [];
    testWindow.__codexTurns = [];
    testWindow.__codexControllerCount = 0;
    testWindow.__codexStopCount = 0;
    testWindow.__codexInterruptCount = 0;
    testWindow.__codexListRoots = [];
    testWindow.__tauriInvocations = [];
    testWindow.__codexAutomationFiles = {};
    const defaultWorkspaceRoot = 'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-projectless';
    const butlerWorkspaceRoot = 'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-butler';
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          testWindow.__tauriInvocations!.push({ command, args });
          if (command === 'codex_default_workspace') {
            return defaultWorkspaceRoot;
          }
          if (command === 'codex_butler_workspace') {
            return butlerWorkspaceRoot;
          }
          if (command === 'plugin:dialog|open') {
            const queue = testWindow.__dialogOpenResponses ?? [];
            return queue.length > 0 ? queue.shift() ?? null : null;
          }
          if (command === 'codex_agent_attachment_write') {
            return { path: 'D:/runtime/composer/image.png', root: 'D:/runtime' };
          }
          if (command === 'codex_artifact_read') {
            return btoa('<!doctype html><html><body><h1>WBS preview</h1><p>Artifact rendered inline.</p></body></html>');
          }
          if (command === 'codex_automation_list') {
            return Object.entries(testWindow.__codexAutomationFiles!).map(([id, content]) => ({ id, content }));
          }
          if (command === 'codex_automation_write') {
            testWindow.__codexAutomationFiles![String(args?.id)] = String(args?.content);
            return null;
          }
          if (command === 'codex_automation_delete') {
            delete testWindow.__codexAutomationFiles![String(args?.id)];
            return null;
          }
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    const workspaceRoot = 'D:/Repos/rocketchatx';
    const now = Math.floor(Date.now() / 1_000);
    const makeThread = (id: string, name: string, preview: string, cwd = workspaceRoot) => ({
      id,
      extra: null,
      sessionId: id,
      forkedFromId: null,
      parentThreadId: null,
      preview,
      ephemeral: false,
      historyMode: 'full',
      modelProvider: 'openai',
      createdAt: now - 3600,
      updatedAt: now,
      recencyAt: now,
      status: { type: 'idle' },
      path: null,
      cwd,
      cliVersion: 'test',
      source: 'appServer',
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name,
      turns: [],
    });
    let threads = [
      makeThread('thread-release', '候选版本准备', '检查候选版本发布条件'),
      makeThread('thread-plan', '迭代计划', '梳理当前迭代计划'),
      ...(testWindow.__codexAdditionalThreadRoots ?? []).map((cwd, index) => (
        makeThread(`thread-environment-${index}`, '环境项目历史', '来自托管项目的历史任务', cwd)
      )),
    ];
    const turns = new Map<string, any[]>();
    turns.set('thread-release', [{
      id: 'turn-seed',
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: now - 60,
      completedAt: now - 58,
      durationMs: 2000,
      items: [{
        type: 'userMessage',
        id: 'seed-user',
        content: [{ type: 'text', text: '检查候选版本发布条件', text_elements: [] }],
      }, {
        type: 'agentMessage',
        id: 'seed-agent',
        text: '我会先检查改动、测试与发布门禁。',
        phase: null,
      }],
    }]);
    testWindow.__appendExternalCodexTurn = (threadId, text) => {
      const current = turns.get(threadId) ?? [];
      const turnId = `turn-external-${current.length + 1}`;
      turns.set(threadId, [...current, {
        id: turnId,
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: now,
        completedAt: now + 1,
        durationMs: 1_000,
        items: [{
          type: 'userMessage',
          id: `${turnId}-user`,
          content: [{ type: 'text', text, text_elements: [] }],
        }, {
          type: 'agentMessage',
          id: `${turnId}-agent`,
          text: `Codex App 已处理：${text}`,
          phase: null,
        }],
      }]);
    };
    const catalog = {
      models: [{
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: 'GPT-5.6 Sol',
        description: 'Frontier coding model',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'high', description: 'Deep' },
        ],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      }],
      permissionProfiles: [
        { id: ':workspace', description: 'Workspace', allowed: true },
        { id: ':danger-full-access', description: 'Full', allowed: true },
      ],
      skills: [{
        name: 'release-check',
        description: '检查候选版本发布门禁。',
        shortDescription: '检查发布门禁',
        path: 'D:/Repos/rocketchatx/.agents/skills/release-check/SKILL.md',
        scope: 'repo',
        enabled: true,
      }, {
        name: 'room-digest',
        description: '汇总群消息并提取关键工作。',
        shortDescription: '汇总群消息',
        path: 'D:/Repos/rocketchatx/.agents/skills/room-digest/SKILL.md',
        scope: 'repo',
        enabled: false,
      }],
      apps: [{
        id: 'azure-devops',
        name: 'Azure DevOps',
        description: '查询工作项、迭代和构建。',
        logoUrl: null,
        logoUrlDark: null,
        iconAssets: null,
        iconDarkAssets: null,
        distributionChannel: null,
        branding: null,
        appMetadata: null,
        labels: null,
        installUrl: 'https://example.test/install-ado',
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ['ADO Tools'],
      }],
      plugins: {
        marketplaces: [{
          name: 'official',
          path: null,
          interface: { displayName: 'OpenAI 官方' },
          plugins: [{
            id: 'release-helper',
            remotePluginId: 'release-helper',
            version: '1.0.0',
            localVersion: null,
            name: 'release-helper',
            shareContext: null,
            source: { type: 'remote' },
            installed: false,
            enabled: false,
            installPolicy: 'AVAILABLE',
            installPolicySource: null,
            authPolicy: 'ON_USE',
            availability: 'AVAILABLE',
            interface: {
              displayName: 'Release Helper',
              shortDescription: '检查发布风险与候选版门禁。',
              longDescription: null,
              developerName: 'OpenAI',
            },
            keywords: ['release'],
          }],
        }],
        marketplaceLoadErrors: [],
        featuredPluginIds: ['release-helper'],
      },
    };
    testWindow.__codexCatalog = catalog;

    setCodexWorkspaceControllerFactory((options: any) => {
      testWindow.__codexControllerCount! += 1;
      testWindow.__codexControllerOptions = options;
      return {
        currentSessionId: 'workspace-ui-session',
        switchWorkspaceRoot: () => true,
        connect: async () => {
          testWindow.__codexMethods!.push('model/list', 'permissionProfile/list', 'skills/list', 'app/list', 'plugin/list');
          return catalog;
        },
        refreshCatalog: async () => {
          testWindow.__codexMethods!.push('plugin/list');
          return catalog;
        },
        listThreads: async (roots?: readonly string[]) => {
          const requested = roots?.length ? [...roots] : [useCodexWorkspace.getState().workspaceRoot];
          testWindow.__codexListRoots!.push(requested);
          return threads.filter((thread) => requested.includes(thread.cwd));
        },
        readThread: async (threadId: string) => ({
          thread: threads.find((thread) => thread.id === threadId),
          turns: turns.get(threadId) ?? [],
        }),
        startThread: async (_selection: unknown, name?: string) => {
          const next = makeThread(
            `thread-${threads.length + 1}`,
            name || '新任务',
            '',
            useCodexWorkspace.getState().workspaceRoot,
          );
          threads = [next, ...threads];
          return next;
        },
        resumeThread: async (threadId: string) => threads.find((thread) => thread.id === threadId),
        renameThread: async (threadId: string, name: string) => {
          threads = threads.map((thread) => thread.id === threadId ? { ...thread, name } : thread);
        },
        archiveThread: async (threadId: string) => {
          threads = threads.filter((thread) => thread.id !== threadId);
        },
        updateSettings: async () => { testWindow.__codexMethods!.push('thread/settings/update'); },
        startTurn: async (threadId: string, input: Array<{ text?: string }>) => {
          const text = input[0]?.text ?? '';
          const roomQuestion = text.includes('<<<ROCKETX_ROOM_MESSAGE>>>')
            ? text.split('<<<ROCKETX_ROOM_MESSAGE>>>').at(-1)?.trim() || text
            : null;
          const sourceUrl = 'https://chat.example.test/channel/general?msg=general-release';
          const answerText = roomQuestion
            ? `已处理：${roomQuestion}。[来源](${sourceUrl})`
            : `已处理：${text}`;
          testWindow.__codexTurns!.push({ text, mode: 'start' });
          const turnId = `turn-${testWindow.__codexTurns!.length}`;
          setTimeout(() => {
            options.onNotification?.('turn/started', { threadId, turn: { id: turnId } });
            options.onNotification?.('item/started', {
              threadId,
              turnId,
              item: { type: 'reasoning', id: `${turnId}-reasoning`, summary: [], content: [] },
            });
            options.onNotification?.('item/reasoning/summaryTextDelta', {
              threadId,
              turnId,
              itemId: `${turnId}-reasoning`,
              delta: '检查工作区状态与发布门禁。',
              summaryIndex: 0,
            });
            options.onNotification?.('item/started', {
              threadId,
              turnId,
              item: {
                type: 'commandExecution',
                id: `${turnId}-command`,
                command: 'pnpm test:regression',
                cwd: workspaceRoot,
                processId: null,
                source: 'agent',
                status: 'inProgress',
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            });
            options.onNotification?.('item/commandExecution/outputDelta', {
              threadId,
              turnId,
              itemId: `${turnId}-command`,
              delta: '530 tests passed\n',
            });
            options.onNotification?.('turn/diff/updated', {
              threadId,
              turnId,
              diff: 'diff --git a/src/task.ts b/src/task.ts\n+export const ready = true;',
            });
            options.onNotification?.('item/agentMessage/delta', { threadId, turnId, delta: answerText });
            const sourceItems = roomQuestion ? [{
              type: 'dynamicToolCall',
              id: `${turnId}-room-source`,
              namespace: 'rocketx',
              tool: 'list_mentions',
              arguments: {},
              status: 'completed',
              contentItems: [{
                type: 'inputText',
                text: JSON.stringify([{
                  id: 'general-release',
                  rid: 'room-general',
                  roomName: 'General',
                  sender: 'alice',
                  text: 'Release checklist ready',
                  link: sourceUrl,
                }]),
              }],
              success: true,
              durationMs: 4,
            }] : [];
            turns.set(threadId, [{
              id: turnId,
              itemsView: 'full',
              status: 'completed',
              error: null,
              startedAt: now,
              completedAt: now,
              durationMs: 20,
              items: [
                { type: 'userMessage', id: `${turnId}-u`, content: [{ type: 'text', text, text_elements: [] }] },
                ...sourceItems,
                { type: 'agentMessage', id: `${turnId}-a`, text: answerText, phase: 'final_answer' },
              ],
            }]);
            options.onNotification?.('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
          }, 1_200);
          return turnId;
        },
        steerTurn: async (_threadId: string, _turnId: string, input: Array<{ text?: string }>) => {
          testWindow.__codexTurns!.push({ text: input[0]?.text ?? '', mode: 'steer' });
          return _turnId;
        },
        interruptTurn: async () => { testWindow.__codexInterruptCount! += 1; },
        installPlugin: async (_marketplace: string, pluginName: string) => {
          testWindow.__codexMethods!.push('plugin/install');
          const plugin = catalog.plugins.marketplaces[0].plugins.find((item: any) => item.name === pluginName);
          if (plugin) { plugin.installed = true; plugin.enabled = true; plugin.localVersion = plugin.version; }
          return { authPolicy: 'ON_USE', appsNeedingAuth: [] };
        },
        uninstallPlugin: async (pluginId: string) => {
          testWindow.__codexMethods!.push('plugin/uninstall');
          const plugin = catalog.plugins.marketplaces[0].plugins.find((item: any) => item.id === pluginId);
          if (plugin) { plugin.installed = false; plugin.enabled = false; plugin.localVersion = null; }
        },
        setSkillEnabled: async (path: string, enabled: boolean) => {
          testWindow.__codexMethods!.push('skills/config/write');
          const skill = catalog.skills.find((item: any) => item.path === path);
          if (skill) skill.enabled = enabled;
          return enabled;
        },
        stop: async () => { testWindow.__codexStopCount! += 1; },
      } as any;
    });

    const userId = useAuth.getState().user?._id;
    if (!userId) throw new Error('test user missing');
    useCodexWorkspace.getState().hydrate(`${getServerBase() || 'same-origin'}:${userId}`);
    await useCodexWorkspace.getState().ensureDefaultWorkspace();
    await useCodexWorkspace.getState().setWorkspaceRoot(workspaceRoot);
    await useCodexWorkspace.getState().connect();
  });
}

async function installHostedSession(
  page: Page,
  provider: 'codex' | 'deepseek',
  status: 'ready' | 'running' | 'interrupted' | 'ended' = 'interrupted',
): Promise<void> {
  await page.evaluate(async ({ nextProvider, nextStatus, server }) => {
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    const loadAuth = new Function('return import("/src/stores/auth.ts")') as () => Promise<any>;
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    const [{ useSharedAgent }, { useAuth }, { useUI }] = await Promise.all([
      loadSharedAgent(),
      loadAuth(),
      loadUI(),
    ]);
    const me = useAuth.getState().user;
    if (!me) throw new Error('test user missing');
    const now = Date.now();
    const deviceId = 'device-ui-hosting';
    const tmid = 'room:room-general';
    localStorage.setItem('rcx-agent-device-id', deviceId);
    useUI.setState({ aiRuntimeProvider: nextProvider });
    useSharedAgent.setState({
      sessions: {
        [tmid]: {
          sessionId: 'session-room-general',
          serverId: server,
          ownerUserId: me._id,
          rid: 'room-general',
          tmid,
          roomNameSnapshot: 'General',
          host: {
            userId: me._id,
            deviceId,
            heartbeatAt: now,
            expiresAt: now + 90_000,
          },
          access: 'room-members',
          approvedMemberIds: [],
          status: nextStatus,
          backend: nextProvider,
          ...(nextProvider === 'codex'
            ? { codexThreadId: 'thread-room-general' }
            : { dshSessionId: 'dsh-room-general' }),
          activeTurnId: nextStatus === 'running' ? 'turn-room-general' : undefined,
          workspaceRoots: ['D:/Repos/rocketchatx'],
          environmentId: 'environment-rocketx',
          environmentName: 'RocketX',
          currentTaskLabel: '整理 Release checklist',
          updatedAt: now,
        },
      },
      traces: {
        [tmid]: [{
          id: 'trace-room-general',
          at: now,
          type: 'status',
          text: '正在检查发布门禁',
        }],
      },
      approvals: [],
      inputs: [],
      dshQuestions: [],
      memberRequests: [],
      error: null,
      readTranscript: async () => ([
        { id: 'harness-user', role: 'user', text: '请总结 Release checklist' },
        { id: 'harness-assistant', role: 'assistant', text: '## 托管结果\n\n已检查 **发布门禁**。' },
      ]),
    });
  }, { nextProvider: provider, nextStatus: status, server: TEST_SERVER });
}

async function openWorkspace(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-08-09T14:30:00+08:00'));
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: /^管家$/, exact: true })
    .click();
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
}

async function openScheduled(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Codex 工作区' })
    .getByRole('button', { name: '已安排', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '已安排', exact: true })).toBeVisible();
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Codex 工作区' })
    .getByRole('button', { name: '插件', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '插件', exact: true })).toBeVisible();
}

test('桌面壳锁住根视口，只允许内容面板自己滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  expect(await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overflow,
    body: getComputedStyle(document.body).overflow,
    root: getComputedStyle(document.querySelector('#root')!).overflow,
    scrollY: window.scrollY,
  }))).toEqual({ html: 'hidden', body: 'hidden', root: 'hidden', scrollY: 0 });
});

test('管家输出保持稳定文本流且输入区不常驻 AI 托管横幅（issue #282）', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await openWorkspace(page);
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    useCodexWorkspace.setState({
      status: 'running',
      messages: Array.from({ length: 24 }, (_, index) => ({
        id: `issue-282-history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `历史消息 ${index} `.repeat(8),
      })),
      streamingText: '## 尚未完成的标题\n\n- 正在输出的条目',
    });
  });

  const transcript = page.locator('.codex-native-transcript');
  const streaming = transcript.locator('.codex-native-message.is-streaming');
  await expect(streaming.getByRole('heading', { name: '尚未完成的标题', level: 2 })).toBeVisible();
  await expect(streaming.locator('.markdown-list-item')).toContainText('正在输出的条目');
  await expect.poll(() => transcript.evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe('none');
  await expect(page.getByRole('region', { name: 'AI 托管设置' })).toHaveCount(0);
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThan(2);
});

test('主管家高频回答与任务过程只合并界面刷新', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await openWorkspace(page);
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    useCodexWorkspace.setState({
      status: 'running',
      activeTurnId: 'turn-high-frequency',
      messages: Array.from({ length: 24 }, (_, index) => ({
        id: `high-frequency-history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `历史消息 ${index} `.repeat(8),
      })),
      streamingText: '开始',
      events: [{
        id: 'reasoning-high-frequency',
        type: 'reasoning',
        title: '思考',
        detail: '开始',
        status: 'running',
      }],
    });
  });

  const transcript = page.locator('.codex-native-transcript');
  await expect(transcript.locator('.codex-native-message.is-streaming')).toContainText('开始');
  const result = await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const transcriptElement = document.querySelector<HTMLElement>('.codex-native-transcript')!;
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.filter((record) => record.type === 'characterData' || record.type === 'childList').length;
    });
    observer.observe(transcriptElement, { subtree: true, characterData: true, childList: true });

    for (let index = 0; index < 60; index += 1) {
      useCodexWorkspace.setState((state: any) => ({
        streamingText: `${state.streamingText} 分片 ${index}`,
        events: state.events.map((event: any) => event.id === 'reasoning-high-frequency'
          ? { ...event, detail: `${event.detail} 分片 ${index}` }
          : event),
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 2));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    observer.disconnect();
    const state = useCodexWorkspace.getState();
    return {
      mutations,
      storeText: state.streamingText,
      renderedText: transcriptElement.querySelector<HTMLElement>('.is-streaming .butler-conversation-markdown')?.textContent ?? '',
      renderedDetail: transcriptElement.querySelector<HTMLElement>('.codex-native-activity pre')?.textContent ?? '',
      bottomGap: transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight,
    };
  });

  expect(result.mutations).toBeLessThanOrEqual(32);
  expect(result.storeText).toContain('分片 59');
  expect(result.renderedText).toContain('分片 59');
  expect(result.renderedDetail).toContain('分片 59');
  expect(result.bottomGap).toBeLessThan(2);
});

test('主管家流式 Markdown 完成时复用同一条消息和已封口块', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await openWorkspace(page);
  const result = await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const answer = '## 渐进标题\n\n第一段已经完成。\n\n- 最后一项';
    useCodexWorkspace.setState({
      status: 'running',
      activeTurnId: 'turn-stable-markdown',
      messages: [{ id: 'stable-user', role: 'user', text: '请给出结构化结果' }],
      streamingText: answer,
      events: [{
        id: 'stable-reasoning',
        type: 'reasoning',
        title: '思考',
        status: 'running',
      }],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const transcript = document.querySelector<HTMLElement>('.codex-native-transcript')!;
    const article = transcript.querySelector<HTMLElement>('.codex-native-message.is-streaming')!;
    const firstBlock = article.querySelector<HTMLElement>('.rocketx-streaming-markdown-block')!;
    let removedActiveMessage = false;
    const observer = new MutationObserver((records) => {
      removedActiveMessage ||= records.some((record) => (
        [...record.removedNodes].some((node) => node === article || (node instanceof Element && node.contains(article)))
      ));
    });
    observer.observe(transcript, { childList: true, subtree: true });

    useCodexWorkspace.setState({
      status: 'ready',
      activeTurnId: undefined,
      messages: [
        { id: 'stable-user', role: 'user', text: '请给出结构化结果' },
        { id: 'stable-assistant', role: 'assistant', text: answer },
      ],
      streamingText: '',
      events: [{
        id: 'stable-reasoning',
        type: 'reasoning',
        title: '思考',
        status: 'completed',
      }],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    observer.disconnect();

    const finalArticle = [...transcript.querySelectorAll<HTMLElement>('.codex-native-message[data-speaker="assistant"]')].at(-1)!;
    const finalFirstBlock = finalArticle.querySelector<HTMLElement>('.rocketx-streaming-markdown-block')!;
    return {
      sameArticle: article === finalArticle,
      sameFirstBlock: firstBlock === finalFirstBlock,
      removedActiveMessage,
      stillStreaming: finalArticle.classList.contains('is-streaming'),
      heading: finalArticle.querySelector('h2')?.textContent,
      list: finalArticle.querySelector('.markdown-list-item')?.textContent,
      bottomGap: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
    };
  });

  expect(result).toEqual({
    sameArticle: true,
    sameFirstBlock: true,
    removedActiveMessage: false,
    stillStreaming: false,
    heading: '渐进标题',
    list: '•最后一项',
    bottomGap: expect.any(Number),
  });
  expect(result.bottomGap).toBeLessThan(2);
});

test('主管家宽屏对话为 Markdown 表格保留完整阅读宽度', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 900 });
  await openWorkspace(page);
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    useCodexWorkspace.setState({
      status: 'ready',
      messages: [{
        id: 'wide-markdown-table',
        role: 'assistant',
        text: [
          '## 跨平台发布矩阵',
          '',
          '| 门禁 | Windows | macOS | Linux | 发布产物 | 校验 |',
          '| --- | --- | --- | --- | --- | --- |',
          '| 桌面构建 | x64 slim + full installer | universal application bundle | AppImage + deb + rpm | signed update archives | SHA256SUMS |',
        ].join('\n'),
      }],
      streamingText: '',
    });
  });

  const transcript = page.locator('.codex-native-transcript');
  const inner = transcript.locator('.codex-native-transcript-inner');
  const tableWrap = inner.locator('.markdown-table-wrap');
  await expect(tableWrap.getByRole('table')).toContainText('signed update archives');
  const layout = await transcript.evaluate((element) => {
    const inner = element.querySelector<HTMLElement>('.codex-native-transcript-inner')!;
    const tableWrap = element.querySelector<HTMLElement>('.markdown-table-wrap')!;
    return {
      transcriptWidth: element.clientWidth,
      innerWidth: inner.getBoundingClientRect().width,
      tableOverflowX: getComputedStyle(tableWrap).overflowX,
      tableViewportWidth: tableWrap.clientWidth,
      tableScrollWidth: tableWrap.scrollWidth,
    };
  });

  expect(layout.innerWidth).toBeGreaterThan(layout.transcriptWidth - 80);
  expect(layout.innerWidth).toBeLessThanOrEqual(layout.transcriptWidth);
  expect(layout.tableOverflowX).toBe('auto');
  expect(layout.tableViewportWidth).toBeGreaterThan(layout.transcriptWidth - 80);
  expect(layout.tableScrollWidth).toBeGreaterThanOrEqual(layout.tableViewportWidth);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLayout = await tableWrap.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX,
    viewportWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pageWidth: document.documentElement.scrollWidth,
    windowWidth: window.innerWidth,
  }));
  expect(narrowLayout.overflowX).toBe('auto');
  expect(narrowLayout.scrollWidth).toBeGreaterThan(narrowLayout.viewportWidth);
  expect(narrowLayout.pageWidth).toBeLessThanOrEqual(narrowLayout.windowWidth);
});

test('私人房间 AI 不读取或展示共享托管 transcript', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await installHostedSession(page, 'codex', 'running');
  await page.evaluate(async () => {
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    const { useSharedAgent } = await loadSharedAgent();
    (window as any).__sharedTranscriptReads = 0;
    useSharedAgent.setState({
      readTranscript: async () => {
        (window as any).__sharedTranscriptReads += 1;
        return [{ id: 'hosted-only', role: 'assistant', text: '这条内容只属于共享托管' }];
      },
    });
  });

  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('私人会话', { exact: true })).toBeVisible();
  await expect(panel.getByText('仅你可见，不会向当前房间发送消息。', { exact: true })).toBeVisible();
  await expect(panel.getByText('GPT-5.6 Sol', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '设置 Codex 模型与权限' })).toBeVisible();
  await expect(panel.getByText('这条内容只属于共享托管', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__sharedTranscriptReads)).toBe(0);
  expect(await page.evaluate(async () => {
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    return Object.keys((await loadSharedAgent()).useSharedAgent.getState().sessions);
  })).toEqual(['room:room-general']);
});

test('私人房间 Codex 的流式 Markdown 完成时不替换消息节点', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel.getByLabel('发送给私人房间 AI')).toBeVisible();

  const result = await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const answer = '## 房间结论\n\n第一段。\n\n- 私人结果';
    const current = useCodexWorkspace.getState();
    const threadId = current.activeThreadId as string;
    const baseThread = current.threadStates[threadId];
    const updateThread = (patch: Record<string, unknown>) => {
      useCodexWorkspace.setState((state: any) => ({
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...state.threadStates[threadId], ...patch },
        },
      }));
    };
    updateThread({
      ...baseThread,
      status: 'running',
      activeTurnId: 'room-turn-stable',
      messages: [{ id: 'room-stable-user', role: 'user', text: '只在房间里回答' }],
      streamingText: answer,
      events: [],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="私人房间 AI 对话"]')!;
    const article = dialog.querySelector<HTMLElement>('.codex-native-message.is-streaming')!;
    const firstBlock = article.querySelector<HTMLElement>('.rocketx-streaming-markdown-block')!;
    updateThread({
      status: 'ready',
      activeTurnId: undefined,
      messages: [
        { id: 'room-stable-user', role: 'user', text: '只在房间里回答' },
        { id: 'room-stable-assistant', role: 'assistant', text: answer },
      ],
      streamingText: '',
    });
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const finalArticle = [...dialog.querySelectorAll<HTMLElement>('.codex-native-message[data-speaker="assistant"]')].at(-1)!;
    return {
      sameArticle: article === finalArticle,
      sameFirstBlock: firstBlock === finalArticle.querySelector('.rocketx-streaming-markdown-block'),
      heading: finalArticle.querySelector('h2')?.textContent,
      list: finalArticle.querySelector('.markdown-list-item')?.textContent,
    };
  });

  expect(result).toEqual({
    sameArticle: true,
    sameFirstBlock: true,
    heading: '房间结论',
    list: '•私人结果',
  });
});

test('私人房间 AI 面板切换房间时不会短暂显示上一房间的会话', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel.getByLabel('发送给私人房间 AI')).toBeVisible();

  const oldSecret = '只属于 General 的私人内容';
  await page.evaluate(async (secret) => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const current = useCodexWorkspace.getState();
    const threadId = current.activeThreadId as string;
    useCodexWorkspace.setState((state: any) => ({
      messages: [
        { id: 'general-private-user', role: 'user', text: 'General 私人问题' },
        { id: 'general-private-answer', role: 'assistant', text: secret },
      ],
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          ...state.threadStates[threadId],
          status: 'ready',
          messages: [
            { id: 'general-private-user', role: 'user', text: 'General 私人问题' },
            { id: 'general-private-answer', role: 'assistant', text: secret },
          ],
          streamingText: '',
        },
      },
    }));
  }, oldSecret);
  await expect(panel.getByText(oldSecret, { exact: true })).toBeVisible();

  const result = await page.evaluate(async (secret) => {
    const loadChat = new Function('return import("/src/stores/chat.ts")') as () => Promise<any>;
    const { useChat } = await loadChat();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="私人房间 AI 对话"]')!;
    let leakedAfterRoomSwitch = false;
    const inspect = () => {
      const text = dialog.textContent ?? '';
      if (text.includes('房间 AI · Second') && text.includes(secret)) leakedAfterRoomSwitch = true;
    };
    const observer = new MutationObserver(inspect);
    observer.observe(dialog, { childList: true, subtree: true, characterData: true });
    useChat.setState((state: any) => {
      const generalRoom = state.rooms['room-general'];
      const generalSubscription = state.subscriptions['room-general'];
      return {
        activeRid: 'room-second',
        rooms: {
          ...state.rooms,
          'room-second': { ...generalRoom, _id: 'room-second', rid: 'room-second', name: 'second', fname: 'Second' },
        },
        subscriptions: {
          ...state.subscriptions,
          'room-second': { ...generalSubscription, rid: 'room-second', name: 'second', fname: 'Second' },
        },
      };
    });
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    inspect();
    observer.disconnect();
    return { leakedAfterRoomSwitch, text: dialog.textContent ?? '' };
  }, oldSecret);

  expect(result.leakedAfterRoomSwitch).toBe(false);
  expect(result.text).toContain('房间 AI · Second');
  expect(result.text).not.toContain(oldSecret);
});

test('私人房间 AI 直接续聊、逐条复制且不会向房间发送 @ai', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await page.evaluate(async () => {
    const loadChat = new Function('return import("/src/stores/chat.ts")') as () => Promise<any>;
    const { useChat } = await loadChat();
    (window as any).__roomSends = [];
    (window as any).__copiedRoomAiText = null;
    useChat.setState({
      send: async (text: string, options?: unknown) => {
        (window as any).__roomSends.push({ text, options });
        return undefined;
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => { (window as any).__copiedRoomAiText = text; },
      },
    });
  });

  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  const composer = panel.getByLabel('发送给私人房间 AI');
  await composer.fill('只私下总结发布计划');
  await panel.getByRole('button', { name: '发送到私人房间 AI' }).click();
  await expect(panel.getByText(/已处理：只私下总结发布计划/)).toBeVisible();
  const copyButton = panel.getByRole('button', { name: '复制Codex消息' });
  await copyButton.hover();
  await panel.screenshot({ path: testInfo.outputPath('private-room-ai-copy.png') });
  await copyButton.click();

  expect(await page.evaluate(() => (window as any).__roomSends)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__copiedRoomAiText)).toContain('已处理：只私下总结发布计划');
  expect(await page.evaluate(() => (window as any).__codexTurns.at(-1)?.text)).not.toContain('@ai');
});

test('RocketX 保留外层导航，内层使用 Codex 的新对话、拉取请求、已安排、插件和项目结构', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);
  const rocketX = page.getByRole('navigation', { name: 'RocketX 主导航' });
  await expect(rocketX.getByRole('button', { name: '管家', exact: true })).toBeVisible();
  await expect(rocketX.getByRole('button', { name: '已安排', exact: true })).toHaveCount(0);
  const codex = page.getByRole('navigation', { name: 'Codex 工作区' });
  for (const label of ['拉取请求', '已安排', '插件']) {
    await expect(codex.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeVisible();
  await expect(codex.getByRole('button', { name: '任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'AI 管家导航' })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByText('临时会话', { exact: true })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByText('管家会话', { exact: true })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByLabel('工作项目')).toBeVisible();
  await expect(page.getByRole('button', { name: '移除项目：临时会话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移除项目：管家会话' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Codex 对话历史' })).toContainText('候选版本准备');
  await page.getByRole('navigation', { name: 'Codex 对话历史' }).getByRole('button', { name: /^候选版本准备/ }).click();
  await expect(page.getByRole('region', { name: 'Codex 任务' })).toContainText('我会先检查改动、测试与发布门禁。');
  await expect(page.getByLabel('模型', { exact: true })).toContainText('GPT-5.6 Sol');
  await expect(page.getByLabel('推理强度', { exact: true })).toContainText('中');
  await expect(page.getByLabel('权限', { exact: true })).toContainText('替我审批');
});

test('项目树按三类工作区嵌套会话，普通新对话固定进入管家会话', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);

  const projects = page.getByLabel('项目目录');
  const project = projects.getByRole('region', { name: '项目：rocketchatx' });
  await expect(project.getByRole('navigation', { name: 'Codex 对话历史' })).toContainText('候选版本准备');
  await expect(project.getByRole('button', { name: 'rocketchatx 2', exact: true })).toContainText('2');
  await expect(project.getByText('还没有对话', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '新对话', exact: true }).click();

  const butler = projects.getByRole('region', { name: '项目：管家会话' });
  await expect(butler.getByRole('navigation', { name: 'Codex 对话历史' })).toContainText('新任务');
  await expect(butler.getByRole('button', { name: '管家会话 1', exact: true })).toContainText('1');
  expect(await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const state = useCodexWorkspace.getState();
    const active = state.threads.find((thread: { id: string }) => thread.id === state.activeThreadId);
    return {
      workspaceRoot: state.workspaceRoot,
      threadRoot: active?.cwd,
      listRoots: (window as typeof window & { __codexListRoots?: string[][] }).__codexListRoots?.at(-1),
    };
  })).toEqual({
    workspaceRoot: 'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-butler',
    threadRoot: 'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-butler',
    listRoots: [
      'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-projectless',
      'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-butler',
      'D:/Repos/rocketchatx',
    ],
  });
});

test('旧 workspaceRoots 会在 Butler 中导入为托管项目，并保留为 environment 真源', async ({ page }) => {
  await page.addInitScript(({ server }) => {
    localStorage.setItem(`rcx-codex-workspace-v1:${server}:user-me`, JSON.stringify({
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceRoots: ['D:/Repos/legacy-root', 'D:/Repos/rocketchatx'],
    }));
  }, { server: TEST_SERVER });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);

  await expect(page.getByLabel('项目目录').getByRole('region', { name: '项目：legacy-root' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const stored = JSON.parse(localStorage.getItem('rcx-agent-environments') ?? '{}');
    return {
      environmentPaths: stored.environments?.map((environment: { path: string }) => environment.path) ?? [],
      runtimeRoots: useCodexWorkspace.getState().workspaceRoots,
    };
  })).toEqual({
    environmentPaths: expect.arrayContaining(['D:/Repos/legacy-root', 'D:/Repos/rocketchatx']),
    runtimeRoots: [
      'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-projectless',
      'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-butler',
    ],
  });
});

test('environment-only 项目会显示在 Butler 中，并可通过项目配置更新元数据', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __codexAdditionalThreadRoots?: string[] }).__codexAdditionalThreadRoots = ['D:/Repos/env-only'];
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-only',
        name: 'Env Only',
        path: 'D:/Repos/env-only',
        adoProjects: ['Alpha'],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);

  const project = page.getByLabel('项目目录').getByRole('region', { name: '项目：Env Only' });
  await expect(project).toBeVisible();
  await expect(project.getByRole('button', { name: 'Env Only 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (
    (window as Window & { __codexListRoots?: string[][] }).__codexListRoots?.at(-1)
  ))).toContain('D:/Repos/env-only');
  await project.getByRole('button', { name: 'Env Only 1', exact: true }).click();
  await expect(project.getByRole('navigation', { name: 'Codex 对话历史' })).toContainText('环境项目历史');
  await page.getByRole('button', { name: '项目配置：Env Only' }).click();
  const dialog = page.getByRole('dialog', { name: '项目配置' });
  await dialog.getByLabel('项目名称').fill('Env Only Renamed');
  await dialog.getByLabel('ADO 项目').fill('Alpha, Beta');
  await dialog.getByLabel('基础分支').fill('release/2026.08');
  await dialog.getByLabel('任务分支前缀').fill('feature/');
  await dialog.getByLabel('启用').uncheck();
  await dialog.getByRole('button', { name: '保存' }).click();

  await expect(page.getByRole('button', { name: /项目配置：Env Only Renamed/ })).toBeVisible();
  expect(await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('rcx-agent-environments') ?? '{}');
    return stored.environments?.find((environment: { id: string }) => environment.id === 'environment-only');
  })).toMatchObject({
    name: 'Env Only Renamed',
    enabled: false,
    adoProjects: ['Alpha', 'Beta'],
    defaultBaseBranch: 'release/2026.08',
    branchPrefix: 'feature/',
  });
});

test('Butler 添加托管项目时会同时注册 environment 并选中运行目录', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __dialogOpenResponses?: Array<string | string[] | null> }).__dialogOpenResponses = ['D:/Repos/added-project'];
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);

  await page.getByRole('button', { name: '添加托管项目' }).click();
  await expect(page.getByLabel('项目目录').getByRole('region', { name: '项目：added-project' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const stored = JSON.parse(localStorage.getItem('rcx-agent-environments') ?? '{}');
    return {
      workspaceRoot: useCodexWorkspace.getState().workspaceRoot,
      environmentPaths: stored.environments?.map((environment: { path: string }) => environment.path) ?? [],
    };
  })).toEqual({
    workspaceRoot: 'D:/Repos/added-project',
    environmentPaths: expect.arrayContaining(['D:/Repos/added-project']),
  });
});

test('房间顶部共享托管与私人房间 AI 是两个独立入口', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await installHostedSession(page, 'codex');
  const hostingEntry = page.getByRole('button', { name: '打开 AI 托管控制面' });
  const privateEntry = page.getByRole('button', { name: '打开房间 AI', exact: true });
  await expect(hostingEntry).toBeVisible();
  await expect(privateEntry).toBeVisible();

  await hostingEntry.click();
  await expect(page.locator('aside').filter({ hasText: 'AI 托管配置' }).last()).toBeVisible();
  await expect(page.getByRole('dialog', { name: '私人房间 AI 对话' })).toHaveCount(0);

  await privateEntry.click();
  const privatePanel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(privatePanel).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭私人房间 AI 浮层' })).toHaveCount(0);
  await expect(page.locator('#room-butler-launcher')).toHaveCount(0);
  await expect(privatePanel.getByText('仅你可见，不会向当前房间发送消息。', { exact: true })).toBeVisible();
  await expect(privatePanel.getByText('请总结 Release checklist', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    return Object.keys((await loadSharedAgent()).useSharedAgent.getState().sessions);
  })).toEqual(['room:room-general']);
});

test('私人房间 AI 关闭重开仍使用同一条个人 thread，模型设置聚焦该会话', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();

  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel.getByLabel('发送给私人房间 AI')).toBeEnabled();
  const firstThreadId = await page.evaluate(() => (
    Object.values(JSON.parse(localStorage.getItem('rcx-room-codex-threads-v1') ?? '{}'))[0]
  ));
  expect(firstThreadId).toMatch(/^thread-/);

  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开房间 AI', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(reopened).toBeVisible();
  expect(await page.evaluate(() => (
    Object.values(JSON.parse(localStorage.getItem('rcx-room-codex-threads-v1') ?? '{}'))[0]
  ))).toBe(firstThreadId);

  await reopened.getByRole('button', { name: '设置 Codex 模型与权限' }).click();
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    return (await loadWorkspace()).useCodexWorkspace.getState().activeThreadId;
  })).toBe(firstThreadId);
});

test('房间 AI 侧栏不会超过外层对话框', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await installHostedSession(page, 'codex');
  await page.evaluate(async () => {
    const loadImLayout = new Function('return import("/src/stores/imLayout.ts")') as () => Promise<any>;
    const { useImLayout } = await loadImLayout();
    useImLayout.getState().setButlerPanelWidth(960);
  });
  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();

  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('room-butler-width.png') });
  const bounds = await panel.evaluate((element) => {
    const shell = element.querySelector('aside');
    if (!shell) throw new Error('room Butler shell not found');
    const panelRect = element.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      panelWidth: panelRect.width,
      shellLeft: shellRect.left,
      shellRight: shellRect.right,
      shellWidth: shellRect.width,
    };
  });

  expect(bounds.shellWidth).toBeLessThanOrEqual(bounds.panelWidth);
  expect(bounds.shellLeft).toBeGreaterThanOrEqual(bounds.panelLeft - 1);
  expect(bounds.shellRight).toBeLessThanOrEqual(bounds.panelRight + 1);
});

test('从管家选择话题托管会聚焦原 Harness session', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await installHostedSession(page, 'codex', 'ready');
  await page.evaluate(async () => {
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    const { useSharedAgent } = await loadSharedAgent();
    const roomKey = 'room:room-general';
    const topicKey = 'topic-hosted-root';
    const state = useSharedAgent.getState();
    useSharedAgent.setState({
      sessions: {
        [topicKey]: {
          ...state.sessions[roomKey],
          sessionId: 'session-topic-hosted-root',
          tmid: topicKey,
          replyTmid: topicKey,
          codexThreadId: 'thread-release',
        },
      },
      traces: { [topicKey]: state.traces[roomKey] ?? [] },
    });
  });

  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: /^管家$/, exact: true })
    .click();
  await page.getByRole('region', { name: '共享 AI 托管' })
    .getByRole('button', { name: /AI 托管，/ })
    .click();
  await page.getByRole('navigation', { name: 'AI 托管会话' })
    .getByRole('button', { name: /RocketX，/ })
    .click();
  await page.getByRole('navigation', { name: 'AI 托管会话' })
    .locator('button[data-session-key="topic-hosted-root"]')
    .click();

  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    const [{ useUI }, { useSharedAgent }] = await Promise.all([loadUI(), loadSharedAgent()]);
    return {
      selectedHostedSessionKey: useUI.getState().selectedHostedSessionKey,
      sessionKeys: Object.keys(useSharedAgent.getState().sessions),
    };
  })).toEqual({
    selectedHostedSessionKey: 'topic-hosted-root',
    sessionKeys: ['topic-hosted-root'],
  });
});

test('管家 AI 托管项直接聚焦同一条 Codex 原生会话，不再复制 transcript', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await installHostedSession(page, 'codex', 'ready');
  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: /^管家$/, exact: true })
    .click();
  const hostingToggle = page.getByRole('region', { name: '共享 AI 托管' })
    .getByRole('button', { name: /AI 托管，/ });
  await hostingToggle.click();
  await page.getByRole('navigation', { name: 'AI 托管会话' })
    .getByRole('button', { name: /RocketX，/ })
    .click();
  await page.getByRole('navigation', { name: 'AI 托管会话' })
    .getByRole('button', { name: /General，Codex/ })
    .click();

  await expect(page.getByRole('region', { name: 'AI 托管总览' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    return (await loadUI()).useUI.getState().selectedHostedSessionKey;
  })).toBe('room:room-general');
});

test('AI 托管按项目折叠分组，项目历史不再重复同一条共享会话', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rcx-theme', 'dark'));
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await installHostedSession(page, 'codex', 'running');
  await page.evaluate(async () => {
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    const { useSharedAgent } = await loadSharedAgent();
    const current = useSharedAgent.getState();
    const general = current.sessions['room:room-general'];
    useSharedAgent.setState({
      sessions: {
        'room:room-general': {
          ...general,
          codexThreadId: 'thread-release',
          status: 'running',
          currentTaskLabel: '整理 Release checklist',
        },
        'room:room-release': {
          ...general,
          sessionId: 'session-room-release',
          rid: 'room-release',
          tmid: 'room:room-release',
          roomNameSnapshot: 'Release',
          codexThreadId: 'thread-hosted-release',
          status: 'ended',
          currentTaskLabel: '核对发布产物',
          updatedAt: general.updatedAt - 1_000,
        },
        'room:room-cat': {
          ...general,
          sessionId: 'session-room-cat',
          rid: 'room-cat',
          tmid: 'room:room-cat',
          roomNameSnapshot: 'Rocket.Cat',
          codexThreadId: 'thread-hosted-cat',
          status: 'ended',
          workspaceRoots: ['D:/Repos/tmp'],
          environmentId: 'environment-tmp',
          environmentName: 'tmp',
          currentTaskLabel: '托管已结束',
          updatedAt: general.updatedAt - 2_000,
        },
      },
      traces: current.traces,
    });
  });

  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: /^管家$/, exact: true })
    .click();

  const hosting = page.getByRole('region', { name: '共享 AI 托管' });
  const hostingToggle = hosting.getByRole('button', { name: /AI 托管，/ });
  await expect(hostingToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(hosting.getByRole('navigation', { name: 'AI 托管会话' })).toBeHidden();
  await hostingToggle.click();
  await expect(hostingToggle).toHaveAttribute('aria-expanded', 'true');

  const navigation = hosting.getByRole('navigation', { name: 'AI 托管会话' });
  const rocketx = navigation.getByRole('region', { name: '托管项目：RocketX' });
  const tmp = navigation.getByRole('region', { name: '托管项目：tmp' });
  await expect(rocketx.getByRole('button', { name: /RocketX，/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(tmp.getByRole('button', { name: /tmp，/ })).toHaveAttribute('aria-expanded', 'false');

  if (process.env.BUTLER_HOSTING_VISUAL) {
    await page.screenshot({ path: process.env.BUTLER_HOSTING_VISUAL, animations: 'disabled' });
  }

  await rocketx.getByRole('button', { name: /RocketX，/ }).click();
  await expect(rocketx.getByRole('button', { name: /RocketX，/ })).toHaveAttribute('aria-expanded', 'true');
  const general = rocketx.locator('button[data-session-key="room:room-general"]');
  await expect(general).toContainText('General');
  await expect(general).toContainText('整理 Release checklist');
  await expect(general).not.toContainText('RocketX');
  await expect(navigation.locator('button[data-session-key="room:room-cat"]')).toBeHidden();
  await tmp.getByRole('button', { name: /tmp，/ }).click();
  await expect(navigation.locator('button[data-session-key="room:room-cat"]')).toBeVisible();

  const projectHistory = page.getByLabel('项目目录')
    .getByRole('region', { name: '项目：rocketchatx' })
    .getByRole('navigation', { name: 'Codex 对话历史' });
  await expect(projectHistory).not.toContainText('候选版本准备');
  await expect(projectHistory).toContainText('迭代计划');

  await hostingToggle.click();
  await expect(hostingToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(hosting.getByRole('navigation', { name: 'AI 托管会话' })).toBeHidden();
});

test('DSH 私人房间会话与共享托管隔离，模型配置回到同一条 DSH 原生会话', async ({ page }) => {
  const dshWebUrl = 'http://127.0.0.1:43123/';
  await page.route(dshWebUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
<html>
  <body>
    <script>
      window.__focusRequests = [];
      window.__openRequests = [];
      window.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'rocketx:dsh-ready-request') {
          event.source?.postMessage({ type: 'rocketx:dsh-ready' }, event.origin);
          return;
        }
        if (data.type === 'rocketx:dsh-focus-session') window.__focusRequests.push(data.sessionId);
        if (data.type === 'rocketx:dsh-open-new-session') window.__openRequests.push(data.workspacePath);
        event.source?.postMessage({ requestId: data.requestId, type: 'rocketx:dsh-ack' }, event.origin);
      });
    </script>
  </body>
</html>`,
    });
  });
  await bootWithAiRuntime(page, 'deepseek');
  await installCodexRuntime(page);
  await page.evaluate((readyUrl) => {
    const runtime = (window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, eventId: number) => void };
    }).__TAURI_INTERNALS__;
    const baseInvoke = runtime.invoke.bind(runtime);
    let nextEventId = 1;
    runtime.invoke = async (command, args) => {
      if (command === 'plugin:event|listen') return nextEventId++;
      if (command === 'plugin:event|unlisten') return null;
      if (command === 'dsh_bridge_start') {
        return {
          processId: 'dsh-process-private-room',
          leaseId: 'dsh-lease-private-room',
          readyUrl,
        };
      }
      if (command === 'dsh_bridge_stop') return null;
      return baseInvoke(command, args);
    };
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  }, dshWebUrl);
  await page.getByText('General', { exact: true }).first().click();
  await installHostedSession(page, 'deepseek');
  await page.evaluate(async () => {
    const loadAuth = new Function('return import("/src/stores/auth.ts")') as () => Promise<any>;
    const loadClient = new Function('return import("/src/lib/client.ts")') as () => Promise<any>;
    const loadPrivateDsh = new Function('return import("/src/stores/privateRoomDsh.ts")') as () => Promise<any>;
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    const [{ useAuth }, { getServerBase }, { privateRoomDshKey, usePrivateRoomDsh }, { useUI }] = await Promise.all([
      loadAuth(),
      loadClient(),
      loadPrivateDsh(),
      loadUI(),
    ]);
    useUI.setState({ aiRuntimeProvider: 'deepseek' });
    const scope = `${getServerBase() || 'same-origin'}:${useAuth.getState().user._id}`;
    const key = privateRoomDshKey(scope, 'room-general');
    usePrivateRoomDsh.setState({
      openRoom: async () => 'private-dsh-general',
      sessions: {
        [key]: {
          key,
          scope,
          rid: 'room-general',
          workspaceRoot: 'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-butler',
          dshSessionId: 'private-dsh-general',
          transcript: {
            messages: [
              { id: 'private-user', role: 'user', text: '只在我的 DSH 会话里讨论' },
              { id: 'private-assistant', role: 'assistant', text: '这是仅你可见的私人答复。' },
            ],
            activities: [],
          },
          status: 'ready',
          approvals: [],
          questions: [],
        },
      },
    });
  });
  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();

  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('DSH', { exact: true }).first()).toBeVisible();
  await expect(panel.getByText('只在我的 DSH 会话里讨论', { exact: true })).toBeVisible();
  await expect(panel.getByText('这是仅你可见的私人答复。', { exact: true })).toBeVisible();
  await expect(panel.getByText('请总结 Release checklist', { exact: true })).toHaveCount(0);

  const streamingContinuity = await page.evaluate(async () => {
    const loadAuth = new Function('return import("/src/stores/auth.ts")') as () => Promise<any>;
    const loadClient = new Function('return import("/src/lib/client.ts")') as () => Promise<any>;
    const loadPrivateDsh = new Function('return import("/src/stores/privateRoomDsh.ts")') as () => Promise<any>;
    const [{ useAuth }, { getServerBase }, { privateRoomDshKey, usePrivateRoomDsh }] = await Promise.all([
      loadAuth(),
      loadClient(),
      loadPrivateDsh(),
    ]);
    const scope = `${getServerBase() || 'same-origin'}:${useAuth.getState().user._id}`;
    const key = privateRoomDshKey(scope, 'room-general');
    const answer = '## DeepSeek 结论\n\n已完成段落。\n\n- 私人结果';
    const updateSession = (messages: any[], status: string) => {
      usePrivateRoomDsh.setState((state: any) => ({
        sessions: {
          ...state.sessions,
          [key]: {
            ...state.sessions[key],
            status,
            transcript: { ...state.sessions[key].transcript, messages },
          },
        },
      }));
    };
    const history = [
      { id: 'private-user', role: 'user', text: '只在我的 DSH 会话里讨论' },
      { id: 'private-assistant', role: 'assistant', text: '这是仅你可见的私人答复。' },
      { id: 'private-follow-up', role: 'user', text: '继续输出 Markdown' },
    ];
    updateSession([
      ...history,
      { id: 'private-dsh-general:draft:2:1', role: 'assistant', text: answer, streaming: true },
    ], 'running');
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="私人房间 AI 对话"]')!;
    const article = dialog.querySelector<HTMLElement>('.codex-native-message.is-streaming')!;
    const firstBlock = article.querySelector<HTMLElement>('.rocketx-streaming-markdown-block')!;
    updateSession([
      ...history,
      { id: 'private-dsh-completed-2-1', role: 'assistant', text: answer },
    ], 'ready');
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const finalArticle = [...dialog.querySelectorAll<HTMLElement>('.codex-native-message[data-speaker="assistant"]')].at(-1)!;
    return {
      sameArticle: article === finalArticle,
      sameFirstBlock: firstBlock === finalArticle.querySelector('.rocketx-streaming-markdown-block'),
      heading: finalArticle.querySelector('h2')?.textContent,
      list: finalArticle.querySelector('.markdown-list-item')?.textContent,
    };
  });
  expect(streamingContinuity).toEqual({
    sameArticle: true,
    sameFirstBlock: true,
    heading: 'DeepSeek 结论',
    list: '•私人结果',
  });

  await panel.getByRole('button', { name: '设置 DSH 模型与 Agent' }).click();
  await expect(page.getByRole('region', { name: 'DSH 原生会话' })).toBeVisible();
  await expect.poll(async () => {
    const frame = page.frame({ url: dshWebUrl });
    if (!frame) return 0;
    return frame.evaluate(() => (window as typeof window & { __focusRequests?: string[] }).__focusRequests?.length ?? 0);
  }).toBe(1);
  expect(await page.evaluate(async () => {
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    const state = (await loadUI()).useUI.getState();
    return {
      personalSessionId: state.selectedPersonalDshSessionId,
      hostedSessionKey: state.selectedHostedSessionKey,
    };
  })).toEqual({
    personalSessionId: 'private-dsh-general',
    hostedSessionKey: null,
  });
  await page.evaluate(async () => {
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    (await loadUI()).useUI.getState().openPersonalDshConversation('private-dsh-general');
  });
  await expect.poll(async () => {
    const frame = page.frame({ url: dshWebUrl });
    if (!frame) return [];
    return frame.evaluate(() => (window as typeof window & { __focusRequests?: string[] }).__focusRequests ?? []);
  }).toEqual(['private-dsh-general', 'private-dsh-general']);
});

test('普通对话运行时打开私人房间 AI 不会中断原有对话线程', async ({ page }) => {
  await bootWithAiRuntime(page, 'codex');
  await installCodexRuntime(page);
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const state = useCodexWorkspace.getState();
    const butlerThread = {
      workspaceRoot: state.butlerWorkspaceRoot,
      runtimeSelection: {
        model: state.model,
        effort: state.effort,
        permissionPreset: state.permissionPreset,
      },
      status: 'running',
      error: null,
      activeTurnId: 'turn-running-elsewhere',
      turns: [],
      messages: [{ id: 'message-running-elsewhere', role: 'assistant', text: '管家任务仍在运行' }],
      events: [],
      streamingText: '',
      pendingRequests: [],
      queuedMessages: [],
    };
    useCodexWorkspace.setState({
      status: 'running',
      workspaceRoot: state.butlerWorkspaceRoot,
      activeThreadId: 'thread-release',
      activeTurnId: 'turn-running-elsewhere',
      messages: butlerThread.messages,
      threadStates: {
        ...state.threadStates,
        'thread-release': butlerThread,
      },
    });
  });

  await page.getByText('General', { exact: true }).first().click();
  await installHostedSession(page, 'codex', 'running');
  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const loadSharedAgent = new Function('return import("/src/stores/sharedAgent.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const { useSharedAgent } = await loadSharedAgent();
    const state = useCodexWorkspace.getState();
    return {
      activeThreadId: state.activeThreadId,
      butlerStatus: state.threadStates['thread-release']?.status,
      butlerTurnId: state.threadStates['thread-release']?.activeTurnId,
      butlerMessage: state.threadStates['thread-release']?.messages.at(-1)?.text,
      interrupts: (window as typeof window & { __codexInterruptCount?: number }).__codexInterruptCount,
      stops: (window as typeof window & { __codexStopCount?: number }).__codexStopCount,
      hostedSessions: Object.keys(useSharedAgent.getState().sessions),
    };
  })).toEqual({
    activeThreadId: expect.stringMatching(/^thread-/),
    butlerStatus: 'running',
    butlerTurnId: 'turn-running-elsewhere',
    butlerMessage: '管家任务仍在运行',
    interrupts: 0,
    stops: 0,
    hostedSessions: ['room:room-general'],
  });
});

test('本地 HTML 以 Claude 式 Artifact 面板呈现，预览时收起项目栏并支持右键浏览器打开', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openWorkspace(page);
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    useCodexWorkspace.setState({
      messages: [{
        id: 'artifact-message',
        role: 'assistant',
        text: 'WBS 已生成：[D:\\Repos\\rocketchatx\\ado_wbs.html](/D:/Repos/rocketchatx/ado_wbs.html)。',
      }],
    });
  });

  const artifact = page.getByRole('complementary', { name: 'Artifact ado_wbs.html' });
  await expect(artifact).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'AI 管家导航' })).toBeHidden();
  await expect(page.getByRole('button', { name: '打开任务列表' })).toBeVisible();
  await expect(artifact.getByRole('button', { name: '预览' })).toHaveAttribute('aria-current', 'page');
  await expect(page.frameLocator('iframe[title="预览 ado_wbs.html"]').getByRole('heading', { name: 'WBS preview' })).toBeVisible();

  const artifactLink = page.getByRole('button', { name: 'D:\\Repos\\rocketchatx\\ado_wbs.html' });
  await artifactLink.click({ button: 'right' });
  await page.getByRole('button', { name: '在浏览器中打开', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __tauriInvocations?: Array<{ command: string }> })
      .__tauriInvocations?.some((entry) => entry.command === 'codex_artifact_open') ?? false
  ))).toBe(true);

  if (process.env.CODEX_VISUAL_ARTIFACT) {
    await page.screenshot({ path: process.env.CODEX_VISUAL_ARTIFACT, fullPage: true });
  }

  await artifact.getByRole('button', { name: '源码' }).click();
  await expect(artifact).toContainText('Artifact rendered inline.');
  await artifact.getByRole('button', { name: '关闭 Artifact' }).click();
  await expect(artifact).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'AI 管家导航' })).toBeVisible();
});

test('从 Codex 刷新会复用 Runtime 并加载外部新增 Turn', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('navigation', { name: 'Codex 对话历史' })
    .getByRole('button', { name: /^候选版本准备/ })
    .click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __appendExternalCodexTurn?: (threadId: string, text: string) => void;
    };
    testWindow.__appendExternalCodexTurn?.('thread-release', '继续检查候选版签名');
  });

  await page.getByRole('button', { name: '从 Codex 刷新', exact: true }).click();

  await expect(page.getByRole('region', { name: 'Codex 任务' }))
    .toContainText('Codex App 已处理：继续检查候选版签名');
  await expect(page.getByText('已从 Codex 同步 1 个新步骤')).toBeVisible();
  expect(await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __codexControllerCount?: number;
      __codexStopCount?: number;
    };
    return {
      controllers: testWindow.__codexControllerCount,
      stops: testWindow.__codexStopCount,
    };
  })).toEqual({ controllers: 1, stops: 0 });
});

test('app-server 运行中退出会保留部分输出，并从原线程显式刷新恢复', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('navigation', { name: 'Codex 对话历史' })
    .getByRole('button', { name: /^候选版本准备/ })
    .click();

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __codexControllerOptions?: {
        onNotification?: (method: string, params: unknown) => void;
        onInterrupted?: (error: Error) => void;
      };
    };
    const options = testWindow.__codexControllerOptions;
    options?.onNotification?.('turn/started', {
      threadId: 'thread-release',
      turn: { id: 'turn-crashed' },
    });
    options?.onNotification?.('item/started', {
      threadId: 'thread-release',
      turnId: 'turn-crashed',
      item: {
        type: 'commandExecution',
        id: 'command-crashed',
        command: 'pnpm test:regression',
        cwd: 'D:/Repos/rocketchatx',
        processId: null,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    options?.onNotification?.('item/agentMessage/delta', {
      threadId: 'thread-release',
      turnId: 'turn-crashed',
      itemId: 'message-crashed',
      delta: '已完成前半段真实验证',
    });
    options?.onInterrupted?.(new Error('Codex app-server 已退出（1）'));
  });

  await expect(page.getByRole('heading', { name: 'Codex 本轮已中断' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Codex 任务' })).toContainText('已完成前半段真实验证');
  await expect(page.getByRole('group', { name: '任务过程' }).getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByLabel('给 Codex 的任务')).toBeDisabled();

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __appendExternalCodexTurn?: (threadId: string, text: string) => void;
    };
    testWindow.__appendExternalCodexTurn?.('thread-release', '恢复后继续验证候选版本');
  });
  await page.locator('.codex-native-interruption')
    .getByRole('button', { name: '从 Codex 刷新', exact: true })
    .click();

  await expect(page.getByRole('region', { name: 'Codex 任务' }))
    .toContainText('Codex App 已处理：恢复后继续验证候选版本');
  await expect(page.getByRole('heading', { name: 'Codex 本轮已中断' })).toHaveCount(0);
  await expect(page.getByLabel('给 Codex 的任务')).toBeEnabled();
});

test('运行中默认 Steer，也可切为 Queue，停止按钮独立可达', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('navigation', { name: 'Codex 对话历史' }).getByRole('button', { name: /^候选版本准备/ }).click();
  const composer = page.getByLabel('给 Codex 的任务');
  await composer.fill('先检查测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '从 Codex 刷新', exact: true })).toBeDisabled();
  await expect(page.getByLabel('后续消息处理方式', { exact: true })).toContainText('立即调整');
  await composer.fill('优先检查权限问题');
  await page.getByRole('button', { name: '发送后续消息' }).click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __codexTurns?: Array<{ mode: string }> }
  ).__codexTurns?.some((turn) => turn.mode === 'steer'))).toBe(true);

  await page.getByLabel('后续消息处理方式', { exact: true }).click();
  await page.getByRole('menu', { name: '后续消息处理方式选项' })
    .getByRole('menuitemradio', { name: /^排队/ })
    .click();
  await composer.fill('然后检查发布门禁');
  await page.getByRole('button', { name: '发送后续消息' }).click();
  await expect(page.getByText('已排队 1 条')).toBeVisible();
  await expect(page.getByText(/已处理：先检查测试/)).toBeVisible();
});

test('对话列表可在原位重命名和归档原生 Thread', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: '更多对话操作：候选版本准备' }).click();
  const menu = page.getByRole('menu', { name: '对话操作' });
  await menu.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByLabel('对话名称').fill('候选版本 RC 验证');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('navigation', { name: 'Codex 对话历史' })).toContainText('候选版本 RC 验证');

  await page.getByRole('button', { name: '更多对话操作：迭代计划' }).click();
  await page.getByRole('menu', { name: '对话操作' }).getByRole('menuitem', { name: '归档' }).click();
  await expect(page.getByRole('navigation', { name: 'Codex 对话历史' })).not.toContainText('迭代计划');
});

test('已安排在当前页面创建、启停和运行，并同步 Codex 原生计划文件', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    const { setRoutineCodexRunner } = await import('/src/stores/routines.ts');
    (window as typeof window & { __routineRuns?: string[] }).__routineRuns = [];
    setRoutineCodexRunner(async (options) => {
      options.onAdmitted?.();
      (window as typeof window & { __routineRuns?: string[] }).__routineRuns!.push(options.text);
      return { text: '候选版本门禁全部通过。' };
    });
  });
  await openScheduled(page);
  await expect(page.getByRole('region', { name: '建议' })).toContainText('晨报');
  await expect(page.getByRole('region', { name: '建议' })).toContainText('晚间回顾');
  await page.getByRole('button', { name: '选择创建方式' }).click();
  await page.getByRole('menuitem', { name: '手动设置' }).click();
  const editor = page.getByRole('region', { name: '新建已安排任务' });
  await editor.getByLabel('名称').fill('每日候选版检查');
  await editor.getByLabel('任务说明').fill('检查候选版本门禁，并汇总失败项与下一步。');
  await editor.getByLabel('重复').selectOption('interval');
  await editor.getByLabel('每隔（分钟）').fill('15');
  await editor.getByText('只在指定时段运行', { exact: true }).click();
  await editor.getByLabel('开始时间').fill('09:00');
  await editor.getByLabel('结束时间').fill('20:00');
  await editor.getByRole('button', { name: '创建', exact: true }).click();
  const row = page.getByRole('button', { name: '打开每日候选版检查详情' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('每天 09:00–20:00，每 15 分钟');
  const nativeFile = await page.evaluate(() => Object.values((
    window as typeof window & { __codexAutomationFiles?: Record<string, string> }
  ).__codexAutomationFiles ?? {})[0]);
  expect(nativeFile).toContain('name = "每日候选版检查"');
  expect(nativeFile).toContain('status = "ACTIVE"');
  expect(nativeFile).toContain('rrule = "RRULE:FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16,17,18,19;BYMINUTE=0,15,30,45"');

  await row.click();
  const detail = page.getByRole('complementary', { name: '已安排任务详情' });
  await detail.getByRole('button', { name: '立即运行每日候选版检查' }).click();
  await expect(detail).toContainText('候选版本门禁全部通过。');
  await detail.getByRole('button', { name: '立即运行每日候选版检查' }).click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __routineRuns?: string[] }
  ).__routineRuns?.length)).toBe(2);
  await expect(page.getByRole('button', { name: '打开每日候选版检查详情' })).toHaveCount(1);
  await expect(detail.locator('.butler-scheduled-run-history details')).toHaveCount(2);

  await detail.getByRole('button', { name: '管理每日候选版检查' }).click();
  await detail.getByRole('menuitem', { name: '暂停' }).click();
  await expect(detail).toContainText('已暂停');
  expect(await page.evaluate(() => Object.values((
    window as typeof window & { __codexAutomationFiles?: Record<string, string> }
  ).__codexAutomationFiles ?? {})[0])).toContain('status = "PAUSED"');
});

test('输出已安排功能视觉门禁截图', async ({ page }) => {
  const pagePath = process.env.CODEX_VISUAL_SCHEDULE;
  const editorPath = process.env.CODEX_VISUAL_SCHEDULE_EDITOR;
  test.skip(!pagePath, '仅在已安排视觉门禁任务中输出截图');

  await page.setViewportSize({ width: 1800, height: 1014 });
  await page.addInitScript(() => localStorage.setItem('rcx-theme', 'dark'));
  await openWorkspace(page);
  await page.evaluate(() => {
    const testWindow = window as typeof window & { __codexAutomationFiles?: Record<string, string> };
    testWindow.__codexAutomationFiles!['rocketx-issue'] = [
      'version = 1',
      'id = "rocketx-issue"',
      'kind = "cron"',
      'name = "每小时处理 RocketX 新 Issue"',
      'prompt = "每小时检查 RocketX 的新 Issue，先判断是否重复、是否可复现，再给出处理建议。"',
      'status = "PAUSED"',
      'rrule = "RRULE:FREQ=HOURLY;INTERVAL=2"',
      'model = "gpt-5.6-sol"',
      'reasoning_effort = "medium"',
      'execution_environment = "local"',
      'cwds = ["D:/Repos/rocketchatx"]',
      'created_at = 1786233600000',
      'updated_at = 1786233600000',
      '',
    ].join('\n');
  });
  await openScheduled(page);
  await page.getByRole('button', { name: '打开每小时处理 RocketX 新 Issue详情' }).click();
  await page.screenshot({ path: pagePath, animations: 'disabled' });

  if (editorPath) {
    await page.getByRole('button', { name: '关闭已安排任务详情' }).click();
    await page.getByRole('button', { name: '选择创建方式' }).click();
    await page.getByRole('menuitem', { name: '手动设置' }).click();
    await page.screenshot({ path: editorPath, animations: 'disabled' });
  }
});

test('插件、Skills 与 Apps 使用真实目录和安装/启停动作', async ({ page }) => {
  await openWorkspace(page);
  await openPlugins(page);
  await expect(page.getByRole('tab', { name: '插件' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Release Helper')).toBeVisible();
  await page.getByRole('button', { name: '安装插件 release-helper' }).click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __codexMethods?: string[] }
  ).__codexMethods)).toContain('plugin/install');

  await page.getByRole('tab', { name: 'Skills' }).click();
  const skill = page.getByRole('article').filter({ hasText: 'room-digest' });
  await skill.getByRole('switch').click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __codexMethods?: string[] }
  ).__codexMethods)).toContain('skills/config/write');

  await page.getByRole('tab', { name: 'Apps' }).click();
  await expect(page.getByText('Azure DevOps')).toBeVisible();
  expect(await page.evaluate(() => (
    window as typeof window & { __codexMethods?: string[] }
  ).__codexMethods)).toEqual(expect.arrayContaining(['plugin/list', 'skills/list', 'app/list']));
});

test('390px 下任务列表用抽屉打开，输入区没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await expect(page.getByRole('button', { name: '打开任务列表' })).toBeVisible();
  await page.getByRole('button', { name: '打开任务列表' }).click();
  await expect(page.getByRole('dialog', { name: '任务列表' })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回 RocketX' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '关闭任务列表' }).last().click();
  await expect(page.getByLabel('给 Codex 的任务')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('私人房间 DSH provider 错误时可直接打开 DSH 配置', async ({ page }) => {
  const dshWebUrl = 'http://127.0.0.1:43124/';
  await page.route(dshWebUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
<html>
  <body>
    <script>
      window.__openRequests = [];
      window.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'rocketx:dsh-ready-request') {
          event.source?.postMessage({ type: 'rocketx:dsh-ready' }, event.origin);
          return;
        }
        if (data.type === 'rocketx:dsh-open-new-session') window.__openRequests.push(data.workspacePath);
        event.source?.postMessage({ requestId: data.requestId, type: 'rocketx:dsh-ack' }, event.origin);
      });
    </script>
  </body>
</html>`,
    });
  });
  await bootWithAiRuntime(page, 'deepseek');
  await installCodexRuntime(page);
  await page.evaluate((readyUrl) => {
    const testWindow = window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, eventId: number) => void };
      __dshBridgeWorkspaces?: string[];
    };
    testWindow.__dshBridgeWorkspaces = [];
    const runtime = testWindow.__TAURI_INTERNALS__;
    const baseInvoke = runtime.invoke.bind(runtime);
    let nextEventId = 1;
    runtime.invoke = async (command, args) => {
      if (command === 'plugin:event|listen') return nextEventId++;
      if (command === 'plugin:event|unlisten') return null;
      if (command === 'dsh_bridge_start') {
        testWindow.__dshBridgeWorkspaces!.push(String(args?.workspaceRoot ?? ''));
        return {
          processId: 'dsh-process-private-setup',
          leaseId: 'dsh-lease-private-setup',
          readyUrl,
        };
      }
      if (command === 'dsh_bridge_stop') return null;
      return baseInvoke(command, args);
    };
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  }, dshWebUrl);
  await page.getByText('General', { exact: true }).first().click();
  await page.evaluate(async () => {
    const loadAuth = new Function('return import("/src/stores/auth.ts")') as () => Promise<any>;
    const loadClient = new Function('return import("/src/lib/client.ts")') as () => Promise<any>;
    const loadPrivateDsh = new Function('return import("/src/stores/privateRoomDsh.ts")') as () => Promise<any>;
    const loadUI = new Function('return import("/src/stores/ui.ts")') as () => Promise<any>;
    const [{ useAuth }, { getServerBase }, { privateRoomDshKey, usePrivateRoomDsh }, { useUI }] = await Promise.all([
      loadAuth(),
      loadClient(),
      loadPrivateDsh(),
      loadUI(),
    ]);
    useUI.setState({ aiRuntimeProvider: 'deepseek' });
    const scope = `${getServerBase() || 'same-origin'}:${useAuth.getState().user._id}`;
    const key = privateRoomDshKey(scope, 'room-general');
    const error = '当前模型提供商不可用，请在 DSH 中检查 provider 与凭据';
    usePrivateRoomDsh.setState({
      openRoom: async () => { throw new Error(error); },
      sessions: {
        [key]: {
          key,
          scope,
          rid: 'room-general',
          workspaceRoot: 'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-projectless',
          transcript: { messages: [], activities: [] },
          status: 'error',
          error,
          approvals: [],
          questions: [],
        },
      },
    });
  });

  await page.getByRole('button', { name: '打开房间 AI', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '私人房间 AI 对话' });
  await expect(panel.getByText('当前模型提供商不可用，请在 DSH 中检查 provider 与凭据', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '在 DSH 中配置' }).click();

  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'DSH 原生会话' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { useUI } = await import('/src/stores/ui.ts');
    const state = useUI.getState();
    return {
      module: state.module,
      sessionId: state.selectedPersonalDshSessionId,
      personalRequest: state.selectedPersonalDshFocusNonce > 0,
    };
  })).toEqual({
    module: 'butler-view',
    sessionId: null,
    personalRequest: true,
  });
  expect(await page.evaluate(() => (
    window as typeof window & { __dshBridgeWorkspaces?: string[] }
  ).__dshBridgeWorkspaces)).toEqual([
    'C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-projectless',
  ]);
  await expect.poll(async () => {
    const frame = page.frame({ url: dshWebUrl });
    if (!frame) return [];
    return frame.evaluate(() => (window as typeof window & { __openRequests?: string[] }).__openRequests ?? []);
  }).toEqual(['C:/Users/tester/AppData/Local/com.lusipad.rocketx/codex-projectless']);
});

test('输出流式 Markdown 完成前后视觉门禁截图', async ({ page }) => {
  const streamingPath = process.env.STREAMING_MARKDOWN_VISUAL;
  const completedPath = process.env.COMPLETED_MARKDOWN_VISUAL;
  test.skip(!streamingPath || !completedPath, '仅在流式 Markdown 视觉门禁任务中输出截图');

  await page.setViewportSize({ width: 1200, height: 760 });
  await page.addInitScript(() => localStorage.setItem('rcx-theme', 'dark'));
  await openWorkspace(page);
  const answer = [
    '## 发布检查结论',
    '',
    '当前输出会按段落逐步稳定，不再在完成时重建整篇内容。',
    '',
    '- [x] 已完成段落保持格式',
    '- [x] 代码与数学块闭合后局部定型',
    '- [ ] 等待最后一项完成',
  ].join('\n');
  await page.evaluate((text) => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    void loadWorkspace().then(({ useCodexWorkspace }) => {
      useCodexWorkspace.setState({
        status: 'running',
        activeTurnId: 'turn-streaming-visual',
        messages: [{ id: 'streaming-visual-user', role: 'user', text: '检查输出稳定性' }],
        streamingText: text,
        events: [{ id: 'streaming-visual-event', type: 'reasoning', title: '思考', status: 'running' }],
      });
    });
  }, answer);
  const article = page.locator('.codex-native-message.is-streaming');
  await expect(article.getByRole('heading', { name: '发布检查结论' })).toBeVisible();
  await article.screenshot({ path: streamingPath!, animations: 'disabled' });

  await page.evaluate((text) => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    void loadWorkspace().then(({ useCodexWorkspace }) => {
      useCodexWorkspace.setState({
        status: 'ready',
        activeTurnId: undefined,
        messages: [
          { id: 'streaming-visual-user', role: 'user', text: '检查输出稳定性' },
          { id: 'streaming-visual-answer', role: 'assistant', text },
        ],
        streamingText: '',
        events: [{ id: 'streaming-visual-event', type: 'reasoning', title: '思考', status: 'completed' }],
      });
    });
  }, answer);
  const completed = page.locator('.codex-native-message[data-speaker="assistant"]').last();
  await expect(completed).not.toHaveClass(/is-streaming/);
  await completed.screenshot({ path: completedPath!, animations: 'disabled' });
});

test('输出 Codex 工作区视觉门禁截图', async ({ page }) => {
  const desktopPath = process.env.CODEX_VISUAL_DESKTOP;
  const mobilePath = process.env.CODEX_VISUAL_MOBILE;
  const mobileDrawerPath = process.env.CODEX_VISUAL_MOBILE_DRAWER;
  test.skip(!desktopPath || !mobilePath, '仅在视觉门禁任务中输出截图');

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => localStorage.setItem('rcx-theme', 'dark'));
  await openWorkspace(page);
  await page.getByRole('navigation', { name: 'Codex 对话历史' })
    .getByRole('button', { name: /^候选版本准备/ })
    .click();
  await page.getByLabel('给 Codex 的任务').fill('检查候选版本发布条件');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Codex 任务' })).toContainText('530 tests passed');
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    useCodexWorkspace.setState({
      messages: [{
        id: 'markdown-visual-answer',
        role: 'assistant',
        text: [
          '# 发布检查结论',
          '',
          '**可以继续，但需要先处理一个风险。** 当前测试与类型检查已经通过，发布门禁保持完整。',
          '',
          '## 验证结果',
          '',
          '- [x] 530 tests passed',
          '- [x] TypeScript 类型检查通过',
          '- [ ] 确认正式包签名',
          '',
          '> 建议先完成签名验证，再生成最终发布产物。',
          '',
          '| 检查项 | 状态 | 说明 |',
          '| --- | --- | --- |',
          '| 自动化测试 | 通过 | 无失败用例 |',
          '| 版本一致性 | 待确认 | 核对 `package.json` 与 tag |',
          '',
          '```ts',
          'const releaseReady = testsPassed && signatureVerified;',
          '```',
          '',
          '详情见 [发布检查文档](https://example.test/release-checklist)。',
        ].join('\n'),
      }],
      streamingText: '',
    });
  });
  await expect(page.getByRole('heading', { name: '发布检查结论' })).toBeVisible();
  await page.getByLabel('权限', { exact: true }).click();
  await page.screenshot({ path: desktopPath, animations: 'disabled' });

  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('给 Codex 的任务')).toBeVisible();
  await page.screenshot({ path: mobilePath, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (mobileDrawerPath) {
    await page.getByRole('button', { name: '打开任务列表' }).click();
    await page.screenshot({ path: mobileDrawerPath, animations: 'disabled' });
  }
});
