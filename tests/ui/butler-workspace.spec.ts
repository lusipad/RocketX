import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated, TEST_SERVER } from './support/rocket-chat-mock';

async function installCodexRuntime(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const loadAuth = new Function('return import("/src/stores/auth.ts")') as () => Promise<any>;
    const loadClient = new Function('return import("/src/lib/client.ts")') as () => Promise<any>;
    const [{
      resetCodexWorkspaceForTests,
      setCodexWorkspaceControllerFactory,
      useCodexWorkspace,
    }, { useAuth }, { getServerBase }] = await Promise.all([loadWorkspace(), loadAuth(), loadClient()]);

    await resetCodexWorkspaceForTests();
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

async function openWorkspace(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-08-09T14:30:00+08:00'));
  await bootAuthenticated(page);
  await installCodexRuntime(page);
  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: /^管家$/, exact: true })
    .click();
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
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
  await expect(streaming).toContainText('## 尚未完成的标题');
  await expect(streaming.getByRole('heading')).toHaveCount(0);
  await expect.poll(() => transcript.evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe('none');
  await expect(page.getByRole('region', { name: 'AI 托管设置' })).toHaveCount(0);
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThan(2);
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
  await expect(page.getByRole('complementary', { name: 'Codex 对话列表' })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByText('临时会话', { exact: true })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByText('管家会话', { exact: true })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByLabel('托管项目')).toBeVisible();
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

test('房间 Codex 浮层可持续对话、重新打开回到最新，并能显式新建会话', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await bootAuthenticated(page);
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await page.getByRole('button', { name: '打开房间 Codex' }).click();

  let panel = page.getByRole('dialog', { name: '房间 Codex 会话' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '新建房间会话' })).toBeVisible();
  await expect(panel.getByText(/临时工作区：.*codex-projectless/)).toBeVisible();
  expect(await page.evaluate(() => ({
    controllers: (window as typeof window & { __codexControllerCount?: number }).__codexControllerCount,
    stops: (window as typeof window & { __codexStopCount?: number }).__codexStopCount,
  }))).toEqual({ controllers: 1, stops: 0 });

  const separator = panel.getByRole('separator', { name: '调整房间 Codex 会话宽度' });
  const initialWidth = (await panel.boundingBox())!.width;
  const separatorBox = (await separator.boundingBox())!;
  await page.mouse.move(separatorBox.x + 1, separatorBox.y + separatorBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(separatorBox.x - 79, separatorBox.y + separatorBox.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(initialWidth + 60);
  const resizedWidth = (await panel.boundingBox())!.width;

  const question = Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 项请提取本群关键工作`).join('，');
  await panel.getByPlaceholder('在这个会话里继续提问').fill(question);
  await panel.getByRole('button', { name: '发送到房间 Codex 会话' }).click();
  await expect(panel.getByText(question, { exact: true })).toBeVisible();

  await panel.getByRole('button', { name: '关闭房间会话' }).click();
  await page.getByRole('button', { name: '打开房间 Codex' }).click();
  panel = page.getByRole('dialog', { name: '房间 Codex 会话' });
  await expect(panel.getByText('正在接回房间会话', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __codexInterruptCount?: number }).__codexInterruptCount ?? -1
  ))).toBe(0);
  await expect(panel.getByText(/已处理：/).last()).toBeVisible({ timeout: 5_000 });
  const transcript = panel.locator('div.min-h-0.flex-1.overflow-y-auto');
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThan(3);
  const citation = panel.getByRole('button', { name: '查看参考来源 1' });
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(panel.getByText('参考来源（1）', { exact: true })).toBeVisible();
  const source = panel.getByTitle('打开来源：General · alice：Release checklist ready');
  await expect(source).toBeVisible();
  const composer = panel.getByPlaceholder('在这个会话里继续提问');
  const composerCard = composer.locator('..');
  const borderBeforeFocus = await composerCard.evaluate((element) => getComputedStyle(element).borderColor);
  await composer.focus();
  await expect.poll(() => composerCard.evaluate((element) => getComputedStyle(element).borderColor))
    .toBe(borderBeforeFocus);
  await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');
  await panel.screenshot({ path: testInfo.outputPath('room-codex-conversation.png') });
  await source.click();
  await expect.poll(() => page.evaluate(async () => {
    const loadChat = new Function('return import("/src/stores/chat.ts")') as () => Promise<any>;
    const { useChat } = await loadChat();
    return useChat.getState().highlightMid;
  })).toBe('general-release');

  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '打开房间 Codex' }).click();
  panel = page.getByRole('dialog', { name: '房间 Codex 会话' });
  await panel.getByRole('button', { name: '新建房间会话' }).click();
  await expect(panel.getByText('直接在这里继续', { exact: true })).toBeVisible();
  await expect(panel.getByText(question, { exact: true })).toHaveCount(0);
});

test('管家任务运行时仍可并行打开房间 Codex，且不会抢占管家线程', async ({ page }) => {
  await bootAuthenticated(page);
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
  await page.getByRole('button', { name: '打开房间 Codex' }).click();
  const panel = page.getByRole('dialog', { name: '房间 Codex 会话' });
  const composer = panel.getByPlaceholder('在这个会话里继续提问');
  await expect(composer).toBeEnabled();
  await composer.fill('并行检查房间消息');
  await panel.getByRole('button', { name: '发送到房间 Codex 会话' }).click();
  await expect(panel.getByText(/已处理：并行检查房间消息/)).toBeVisible({ timeout: 5_000 });
  expect(await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    const state = useCodexWorkspace.getState();
    return {
      activeThreadId: state.activeThreadId,
      butlerStatus: state.threadStates['thread-release']?.status,
      butlerTurnId: state.threadStates['thread-release']?.activeTurnId,
      butlerMessage: state.threadStates['thread-release']?.messages.at(-1)?.text,
      interrupts: (window as typeof window & { __codexInterruptCount?: number }).__codexInterruptCount,
      stops: (window as typeof window & { __codexStopCount?: number }).__codexStopCount,
    };
  })).toEqual({
    activeThreadId: expect.not.stringMatching(/^thread-release$/),
    butlerStatus: 'running',
    butlerTurnId: 'turn-running-elsewhere',
    butlerMessage: '管家任务仍在运行',
    interrupts: 0,
    stops: 0,
  });
});

test('房间 Codex 在首段回复到达前持续显示思考反馈', async ({ page }) => {
  await bootAuthenticated(page);
  await installCodexRuntime(page);
  await page.getByText('General', { exact: true }).first().click();
  await page.getByRole('button', { name: '打开房间 Codex' }).click();
  const panel = page.getByRole('dialog', { name: '房间 Codex 会话' });
  await expect(panel.getByText('直接在这里继续', { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const loadWorkspace = new Function('return import("/src/stores/codexWorkspace.ts")') as () => Promise<any>;
    const { useCodexWorkspace } = await loadWorkspace();
    useCodexWorkspace.setState({ status: 'running', activeTurnId: 'turn-thinking', streamingText: '' });
  });

  await expect(panel.getByRole('status')).toContainText('Codex 正在思考');
  await expect(panel.getByText('直接在这里继续', { exact: true })).toHaveCount(0);
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
  await expect(page.getByRole('complementary', { name: 'Codex 对话列表' })).toBeHidden();
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
  await expect(page.getByRole('complementary', { name: 'Codex 对话列表' })).toBeVisible();
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
  if (mobileDrawerPath) {
    await page.getByRole('button', { name: '打开任务列表' }).click();
    await page.screenshot({ path: mobileDrawerPath, animations: 'disabled' });
  }
});
