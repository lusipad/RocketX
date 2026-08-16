import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function openNativeTask(page: Page): Promise<string[]> {
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.evaluate(async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async () => null,
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
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
      __nativeControllerOptions?: Record<string, (...args: any[]) => any>;
      __nativeRequestResults?: unknown[];
    };
    testWindow.__nativeRequestResults = [];
    const workspaceRoot = 'D:/Repos/rocketchatx';
    const thread = {
      id: 'native-thread',
      name: '候选版本准备',
      preview: '准备候选版本',
      cwd: workspaceRoot,
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    setCodexWorkspaceControllerFactory((options: any) => {
      testWindow.__nativeControllerOptions = options;
      return {
        connect: async () => ({
          models: [{
            id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', hidden: false, isDefault: true,
            defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
          }],
          permissionProfiles: [
            { id: ':workspace', description: null, allowed: true },
            { id: ':danger-full-access', description: null, allowed: true },
          ],
          skills: [], apps: [],
          plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
        }),
        listThreads: async () => [thread],
        startThread: async () => thread,
        resumeThread: async () => thread,
        readThread: async () => ({ thread, turns: [] }),
        stop: async () => undefined,
      } as any;
    });
    const userId = useAuth.getState().user?._id;
    useCodexWorkspace.getState().hydrate(`${getServerBase() || 'same-origin'}:${userId}`);
    await useCodexWorkspace.getState().setWorkspaceRoot(workspaceRoot);
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread('native-thread');
  });
  await page.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: /^管家$/ }).click();
  await expect(page.getByRole('region', { name: 'Codex 任务' })).toBeVisible();
  return pageErrors;
}

async function requestResult(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (
    window as typeof window & { __nativeRequestResults?: unknown[] }
  ).__nativeRequestResults ?? []);
}

test('原生 request_user_input 在所属任务原位回答', async ({ page }) => {
  const pageErrors = await openNativeTask(page);
  await page.evaluate(() => {
    const target = window as typeof window & {
      __nativeControllerOptions?: Record<string, (...args: any[]) => any>;
      __nativeRequestResults?: unknown[];
    };
    void target.__nativeControllerOptions!.onServerRequest({
      method: 'item/tool/requestUserInput',
      policy: 'host-input',
      params: {
        threadId: 'native-thread',
        turnId: 'turn-release',
        itemId: 'item-release',
        autoResolutionMs: null,
        questions: [{
          id: 'release_mode', header: '发布方式', question: '这次按哪种方式发布？',
          isOther: false, isSecret: false,
          options: [
            { label: '候选版', description: '先做真实验证。' },
            { label: '正式版', description: '进入正式发布流程。' },
          ],
        }, {
          id: 'temporary_token', header: '临时口令', question: '输入只用于本轮的临时口令。',
          isOther: true, isSecret: true, options: null,
        }],
      },
    }).then((result: unknown) => target.__nativeRequestResults!.push(result));
  });

  const card = page.getByTestId('butler-request-user-input');
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: /候选版/ }).check();
  const secret = card.getByLabel('临时口令');
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill('ui-secret-42');
  await card.getByRole('button', { name: '回答并继续' }).click();
  await expect.poll(() => requestResult(page)).toEqual([{
    answers: {
      release_mode: { answers: ['候选版'] },
      temporary_token: { answers: ['ui-secret-42'] },
    },
  }]);
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).join('\n').includes('ui-secret-42'))).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('原生 MCP elicitation 在任务内提交结构化字段', async ({ page }) => {
  const pageErrors = await openNativeTask(page);
  await page.evaluate(() => {
    const target = window as typeof window & {
      __nativeControllerOptions?: Record<string, (...args: any[]) => any>;
      __nativeRequestResults?: unknown[];
    };
    void target.__nativeControllerOptions!.onServerRequest({
      method: 'mcpServer/elicitation/request',
      policy: 'host-input',
      params: {
        threadId: 'native-thread', turnId: 'turn-mcp', serverName: 'release-helper',
        mode: 'form', _meta: null, message: '请补充候选版参数。',
        requestedSchema: {
          type: 'object', required: ['channel', 'retries'],
          properties: {
            channel: { type: 'string', title: '发布通道', enum: ['canary', 'stable'], enumNames: ['候选通道', '稳定通道'] },
            retries: { type: 'integer', title: '重试次数', minimum: 0, maximum: 3 },
            notify: { type: 'boolean', title: '通知负责人', default: false },
          },
        },
      },
    }).then((result: unknown) => target.__nativeRequestResults!.push(result));
  });
  const form = page.getByTestId('butler-mcp-form-input');
  await form.getByRole('combobox').selectOption('canary');
  await form.getByRole('spinbutton').fill('2');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: '提交并继续' }).click();
  await expect.poll(() => requestResult(page)).toEqual([{
    action: 'accept',
    content: { channel: 'canary', retries: 2, notify: true },
    _meta: null,
  }]);
  expect(pageErrors).toEqual([]);
});

test('原生命令审批支持允许一次、本任务允许与拒绝', async ({ page }) => {
  const pageErrors = await openNativeTask(page);
  await page.evaluate(() => {
    const target = window as typeof window & {
      __nativeControllerOptions?: Record<string, (...args: any[]) => any>;
      __nativeRequestResults?: unknown[];
    };
    void target.__nativeControllerOptions!.onServerRequest({
      method: 'item/commandExecution/requestApproval',
      policy: 'host-approval',
      params: {
        threadId: 'native-thread', turnId: 'turn-command', itemId: 'item-command',
        command: 'pnpm test', cwd: 'D:/Repos/rocketchatx', reason: '运行回归测试',
      },
    }).then((result: unknown) => target.__nativeRequestResults!.push(result));
  });
  const approval = page.getByRole('region', { name: 'Codex 请求审批' });
  await expect(approval).toContainText('pnpm test');
  await expect(approval.getByRole('button', { name: '允许一次' })).toBeVisible();
  await expect(approval.getByRole('button', { name: '本次任务允许' })).toBeVisible();
  await approval.getByRole('button', { name: '允许一次' }).click();
  await expect.poll(() => requestResult(page)).toEqual([{ decision: 'accept' }]);
  expect(pageErrors).toEqual([]);
});

test('其他线程的宿主请求不会串进当前任务', async ({ page }) => {
  await openNativeTask(page);
  const error = await page.evaluate(async () => {
    const target = window as typeof window & {
      __nativeControllerOptions?: Record<string, (...args: any[]) => any>;
    };
    try {
      await target.__nativeControllerOptions!.onServerRequest({
        method: 'item/commandExecution/requestApproval',
        policy: 'host-approval',
        params: { threadId: 'other-thread', turnId: 'turn', command: 'echo no' },
      });
      return '';
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
  });
  expect(error).toContain('不属于当前 Codex 任务');
  await expect(page.getByRole('region', { name: 'Codex 请求审批' })).toHaveCount(0);
});
