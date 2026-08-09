import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

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
      __appendExternalCodexTurn?: (threadId: string, text: string) => void;
    };
    testWindow.__codexMethods = [];
    testWindow.__codexTurns = [];
    testWindow.__codexControllerCount = 0;
    testWindow.__codexStopCount = 0;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          if (command === 'codex_agent_attachment_write') {
            return { path: 'D:/runtime/composer/image.png', root: 'D:/runtime' };
          }
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    const workspaceRoot = 'D:/Repos/rocketchatx';
    const now = Math.floor(Date.now() / 1_000);
    const makeThread = (id: string, name: string, preview: string) => ({
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
      cwd: workspaceRoot,
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
        connect: async () => {
          testWindow.__codexMethods!.push('model/list', 'permissionProfile/list', 'skills/list', 'app/list', 'plugin/list');
          return catalog;
        },
        refreshCatalog: async () => {
          testWindow.__codexMethods!.push('plugin/list');
          return catalog;
        },
        listThreads: async () => threads,
        readThread: async (threadId: string) => ({
          thread: threads.find((thread) => thread.id === threadId),
          turns: turns.get(threadId) ?? [],
        }),
        startThread: async (_selection: unknown, name?: string) => {
          const next = makeThread(`thread-${threads.length + 1}`, name || '新任务', '');
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
            options.onNotification?.('item/agentMessage/delta', { threadId, turnId, delta: `已处理：${text}` });
            turns.set(threadId, [{
              id: turnId,
              itemsView: 'full',
              status: 'completed',
              error: null,
              startedAt: now,
              completedAt: now,
              durationMs: 20,
              items: [{ type: 'userMessage', id: `${turnId}-u`, content: [{ type: 'text', text, text_elements: [] }] },
                { type: 'agentMessage', id: `${turnId}-a`, text: `已处理：${text}`, phase: null }],
            }]);
            options.onNotification?.('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
          }, 1_200);
          return turnId;
        },
        steerTurn: async (_threadId: string, _turnId: string, input: Array<{ text?: string }>) => {
          testWindow.__codexTurns!.push({ text: input[0]?.text ?? '', mode: 'steer' });
          return _turnId;
        },
        interruptTurn: async () => undefined,
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
  await expect(page.getByRole('navigation', { name: 'Codex 对话历史' })).toContainText('候选版本准备');
  await page.getByRole('navigation', { name: 'Codex 对话历史' }).getByRole('button', { name: /^候选版本准备/ }).click();
  await expect(page.getByRole('region', { name: 'Codex 任务' })).toContainText('我会先检查改动、测试与发布门禁。');
  await expect(page.getByLabel('模型', { exact: true })).toContainText('GPT-5.6 Sol');
  await expect(page.getByLabel('推理强度', { exact: true })).toContainText('中');
  await expect(page.getByLabel('权限', { exact: true })).toContainText('替我审批');
});

test('从 Codex 刷新会硬重连同一线程并加载外部新增 Turn', async ({ page }) => {
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
  })).toEqual({ controllers: 2, stops: 1 });
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
  await expect(page.getByRole('region', { name: '任务过程' }).getByText('已中断', { exact: true })).toBeVisible();
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

test('已安排在当前页面创建、启停、立即运行，并明确保存在此设备', async ({ page }) => {
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
  await expect(page.getByText('保存在此设备；执行时使用当前 Codex 工作区。')).toBeVisible();
  await page.getByRole('button', { name: '新建安排' }).click();
  await page.getByLabel('任务名称').fill('每日候选版检查');
  await page.getByLabel('执行 Skill').selectOption('release-check');
  await page.getByRole('button', { name: '创建并启用' }).click();
  const row = page.getByRole('article').filter({ hasText: '每日候选版检查' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '立即运行每日候选版检查' }).click();
  await expect(row).toContainText('候选版本门禁全部通过。');
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __routineRuns?: string[] }
  ).__routineRuns?.length)).toBe(1);
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
  await page.getByText('运行命令', { exact: true }).click();
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
