import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function openButlerNow(page: Page): Promise<string[]> {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await page
    .getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: /^委托/ })
    .click();
  await expect(page.getByRole('region', { name: '管家委托' })).toBeVisible();
  return pageErrors;
}

test('委托卡片原位回答 request_user_input，并在提交后回到同一任务', async ({ page }) => {
  const pageErrors = await openButlerNow(page);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => { errands: Array<Record<string, unknown>> };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    const input = {
      id: 'input-release',
      method: 'item/tool/requestUserInput',
      policy: 'host-input',
      at: Date.now(),
      params: {
        threadId: 'thread-release',
        turnId: 'turn-release',
        itemId: 'item-release',
        autoResolutionMs: null,
        questions: [
          {
            id: 'release_mode',
            header: '发布方式',
            question: '这次按哪种方式发布？',
            isOther: false,
            isSecret: false,
            options: [
              { label: '候选版', description: '先做真实验证，再进入正式发布。' },
              { label: '正式版', description: '直接进入正式发布流程。' },
            ],
          },
          {
            id: 'temporary_token',
            header: '临时口令',
            question: '输入只用于本轮的临时口令。',
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
    };
    const errand = {
      id: 'input-run',
      title: '准备候选版本',
      threadId: 'thread-release',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: Date.now() - 60_000,
      status: 'awaiting-approval',
      approvals: [],
      inputs: [input],
      traces: [],
      plan: [],
    };
    (window as Window & { __butlerInputActions?: unknown[] }).__butlerInputActions = [];
    useButler.setState({
      errands: [errand],
      resolveErrandInput: async (runId: string, inputId: string, response: unknown) => {
        (window as Window & { __butlerInputActions?: unknown[] }).__butlerInputActions?.push({ runId, inputId, response });
        useButler.setState({
          errands: useButler.getState().errands.map((run) => run.id === runId
            ? { ...run, status: 'running', inputs: [] }
            : run),
        });
      },
    });
  });

  const waiting = page.getByRole('region', { name: '等你回应' });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText('准备候选版本');
  await waiting.getByRole('radio', { name: /候选版/ }).check();
  const secret = waiting.getByLabel('临时口令');
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill('ui-secret-42');
  await expect(waiting.getByRole('button', { name: '回答并继续' })).toBeEnabled();

  await page.screenshot({
    path: '.gstack/qa-reports/screenshots/butler-host-input-wide-20260808.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(waiting).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({
    path: '.gstack/qa-reports/screenshots/butler-host-input-mobile-20260808.png',
    fullPage: true,
  });

  await waiting.getByRole('button', { name: '回答并继续' }).click();
  expect(await page.evaluate(() => (
    (window as Window & { __butlerInputActions?: unknown[] }).__butlerInputActions
  ))).toEqual([{
    runId: 'input-run',
    inputId: 'input-release',
    response: {
      answers: {
        release_mode: { answers: ['候选版'] },
        temporary_token: { answers: ['ui-secret-42'] },
      },
    },
  }]);
  await expect(page.getByRole('region', { name: '等你回应' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '在办' })).toContainText('准备候选版本');
  expect(await page.evaluate(() => Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index);
    return key ? localStorage.getItem(key) ?? '' : '';
  }).join('\n').includes('ui-secret-42'))).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('MCP 标准表单在任务内提交结构化字段', async ({ page }) => {
  const pageErrors = await openButlerNow(page);
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await load();
    (window as Window & { __mcpInputActions?: unknown[] }).__mcpInputActions = [];
    useButler.setState({
      errands: [{
        id: 'mcp-run',
        title: '补充发布参数',
        threadId: 'thread-mcp',
        workspaceRoot: 'D:/Repos/rocketchatx',
        workspaceName: 'RocketX',
        readOnly: true,
        startedAt: Date.now(),
        status: 'awaiting-approval',
        approvals: [],
        inputs: [{
          id: 'input-mcp',
          method: 'mcpServer/elicitation/request',
          policy: 'host-input',
          at: Date.now(),
          params: {
            threadId: 'thread-mcp',
            turnId: 'turn-mcp',
            serverName: 'release-helper',
            mode: 'form',
            _meta: null,
            message: '请补充这次候选版的参数。',
            requestedSchema: {
              type: 'object',
              required: ['channel', 'retries'],
              properties: {
                channel: {
                  type: 'string',
                  title: '发布通道',
                  enum: ['canary', 'stable'],
                  enumNames: ['候选通道', '稳定通道'],
                },
                retries: {
                  type: 'integer',
                  title: '重试次数',
                  minimum: 0,
                  maximum: 3,
                },
                notify: {
                  type: 'boolean',
                  title: '通知负责人',
                  default: false,
                },
              },
            },
          },
        }],
        traces: [],
      }],
      resolveErrandInput: async (runId: string, inputId: string, response: unknown) => {
        (window as Window & { __mcpInputActions?: unknown[] }).__mcpInputActions?.push({ runId, inputId, response });
      },
    });
  });

  const form = page.getByTestId('butler-mcp-form-input');
  await expect(form).toContainText('请补充这次候选版的参数。');
  await form.getByRole('combobox').selectOption('canary');
  await form.getByRole('spinbutton').fill('2');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: '提交并继续' }).click();
  expect(await page.evaluate(() => (
    (window as Window & { __mcpInputActions?: unknown[] }).__mcpInputActions
  ))).toEqual([{
    runId: 'mcp-run',
    inputId: 'input-mcp',
    response: {
      action: 'accept',
      content: { channel: 'canary', retries: 2, notify: true },
      _meta: null,
    },
  }]);
  expect(pageErrors).toEqual([]);
});
