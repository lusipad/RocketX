import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

const CJK_RE = /[\u4e00-\u9fff]/;

async function visibleUiTextWithoutSelfLabels(page: Page, rootSelector = 'body'): Promise<string> {
  const raw = await page.locator(rootSelector).innerText();
  // Exclude the intentional language self-name option/card ('简体中文') and mock sample names if any.
  return raw.replace(/简体中文/g, '');
}

test.describe('en-US unauthenticated LoginPage localization & switching', () => {
  test.use({ locale: 'en-US' });

  test('renders English LoginPage by default and switches immediately without reload', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.route('**/api/info', (route) => route.fulfill({ json: { version: '8.6.1' } }));
    await page.goto('/');

    // Unauthenticated web starts in localMode with English navigation & workspace.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    const connectBtn = page.getByRole('button', { name: 'Connect Rocket.Chat' });
    await expect(connectBtn).toBeVisible();
    expect(await visibleUiTextWithoutSelfLabels(page)).not.toMatch(CJK_RE);

    // Click "Connect Rocket.Chat" to open embedded LoginPage.
    await connectBtn.click();
    await expect(page.getByRole('button', { name: 'Connect & Sign In to Rocket.Chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open AI Butler' })).toBeVisible();
    expect(await visibleUiTextWithoutSelfLabels(page)).not.toMatch(CJK_RE);

    const enSelector = page.getByRole('combobox', { name: 'Select interface language' });
    await expect(enSelector).toHaveValue('system');

    await enSelector.selectOption('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('button', { name: '连接并登录 Rocket.Chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: '使用 AI 管家' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('rcx-locale'))).toBe('zh-CN');

    const zhSelector = page.getByRole('combobox', { name: '选择界面语言' });
    await zhSelector.selectOption('en-US');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('button', { name: 'Connect & Sign In to Rocket.Chat' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('rcx-locale'))).toBe('en-US');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    expect(await page.evaluate(() => localStorage.getItem('rcx-locale'))).toBe('en-US');
    await page.getByRole('button', { name: 'Connect Rocket.Chat' }).click();
    await expect(page.getByRole('button', { name: 'Connect & Sign In to Rocket.Chat' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Select interface language' })).toHaveValue('en-US');

    expect(pageErrors).toEqual([]);
  });
});

test.describe('en-US authenticated multi-module coverage', () => {
  test.use({ locale: 'en-US' });

  test('renders NavRail, Chat, Settings, To-Dos, Calendar, and Butler in English without stray CJK', async ({ page }) => {
    const { pageErrors } = await bootAuthenticated(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    const nav = page.getByRole('navigation', { name: 'RocketX Primary Navigation' });
    await expect(nav).toBeVisible();
    expect(await nav.innerText()).not.toMatch(CJK_RE);

    await page.getByText('General', { exact: true }).first().click();
    await expect(page.getByRole('textbox').first()).toBeVisible();

    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Account & Status' })).toBeVisible();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByText('Theme', { exact: true })).toBeVisible();
    await expect(page.getByText('Language', { exact: true })).toBeVisible();
    const langGroup = page.getByRole('radiogroup', { name: 'Select interface language' });
    await expect(langGroup).toBeVisible();
    await expect(langGroup.getByRole('radio', { name: /System/ })).toHaveAttribute('aria-checked', 'true');
    expect(await visibleUiTextWithoutSelfLabels(page)).not.toMatch(CJK_RE);

    await nav.getByRole('button', { name: /^To-Dos/ }).click();
    await expect(page.getByRole('heading', { name: 'Open' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New To-Do' })).toBeVisible();
    expect(await visibleUiTextWithoutSelfLabels(page)).not.toMatch(CJK_RE);

    await nav.getByRole('button', { name: /^Calendar/ }).click();
    await expect(page.getByRole('button', { name: 'Month', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Week', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Day', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Event' }).first()).toBeVisible();
    expect(await visibleUiTextWithoutSelfLabels(page)).not.toMatch(CJK_RE);

    await nav.getByRole('button', { name: /^Butler/ }).click();
    await expect(
      page.getByText(/Open unified board|Configure in Settings|Hand off tasks to Butler in Desktop|What can I take care of for you/).first(),
    ).toBeVisible();
    expect(await visibleUiTextWithoutSelfLabels(page)).not.toMatch(CJK_RE);

    expect(pageErrors).toEqual([]);
  });
});

test.describe('zh-CN authenticated instant switch and persistence', () => {
  test.use({ locale: 'zh-CN' });

  test('switches zh-CN -> en-US -> System immediately without reload and persists in localStorage', async ({ page }) => {
    const { pageErrors } = await bootAuthenticated(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const zhNav = page.getByRole('navigation', { name: 'RocketX 主导航' });
    await expect(zhNav).toBeVisible();

    await zhNav.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号与状态' })).toBeVisible();
    await page.getByRole('button', { name: '外观' }).click();
    const zhLangGroup = page.getByRole('radiogroup', { name: '选择界面语言' });
    await expect(zhLangGroup).toBeVisible();
    await expect(zhLangGroup.getByRole('radio', { name: /跟随系统/ })).toHaveAttribute('aria-checked', 'true');

    await zhLangGroup.getByRole('radio', { name: /English/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    const enNav = page.getByRole('navigation', { name: 'RocketX Primary Navigation' });
    await expect(enNav).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByText('Language', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('rcx-locale'))).toBe('en-US');

    await page.reload();
    await expect(enNav).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    expect(await page.evaluate(() => localStorage.getItem('rcx-locale'))).toBe('en-US');

    await enNav.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    const enLangGroup = page.getByRole('radiogroup', { name: 'Select interface language' });
    await expect(enLangGroup.getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');

    await enLangGroup.getByRole('radio', { name: /System/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('navigation', { name: 'RocketX 主导航' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('rcx-locale'))).toBe('system');

    expect(pageErrors).toEqual([]);
  });
});

test.describe('desktop cold-start @release-desktop en-US & C-locale gate', () => {
  test.use({ locale: 'en-US' });

  test(
    'cold-start desktop at 800x600 stays clean English without OCR error tokens',
    { tag: '@release-desktop' },
    async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.setViewportSize({ width: 800, height: 600 });
      await page.addInitScript(() => {
        let accountGeneration = 0;
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: {
            invoke: async (cmd: string, args?: Record<string, unknown>) => {
              if (cmd === 'read_desktop_preferences') {
                return { version: 1, autostart: false, trayClose: true };
              }
              if (cmd === 'desktop_distribution_profile') return 'slim';
              if (cmd === 'butler_db_select_account') {
                return {
                  accountScope: String(args?.accountScope ?? 'local'),
                  generation: ++accountGeneration,
                };
              }
              if (cmd === 'butler_todo_list') return [];
              if (cmd === 'butler_todo_migrate_from_json') return 0;
              if (cmd === 'acp_local_sessions_discover') return [];
              if (cmd === 'acp_agent_list') return [];
              if (cmd === 'pi_local_gateways_scan') return [];
              if (cmd === 'pi_runtime_probe') {
                return {
                  ready: true,
                  version: '1.5.0',
                  source: 'bundled',
                  configuredProvider: 'deepseek',
                  defaultModel: 'deepseek-v4-flash',
                  hasCredentials: false,
                };
              }
              if (cmd === 'pi_config_read') {
                return {
                  provider: 'deepseek',
                  apiProtocol: 'openai-completions',
                  baseUrl: 'https://api.deepseek.com',
                  defaultModel: 'deepseek-v4-flash',
                  hasApiKey: false,
                  extraModels: [],
                };
              }
              if (cmd === 'codex_runtime_probe') return { available: false, reason: '' };
              if (cmd === 'codex_workspace_list_projects') return [];
              if (cmd === 'butler_db_load') {
                return { version: 1, todos: [], events: [], summaries: [] };
              }
              if (cmd === 'butler_memory_list') return [];
              if (cmd === 'butler_skill_list') return [];
              if (cmd === 'butler_work_ledger_snapshot') {
                return { cards: [], links: [], sessions: [], evidences: [], events: [], actions: [] };
              }
              return null;
            },
            transformCallback: () => 0,
            unregisterCallback: () => {},
            metadata: {
              currentWindow: { label: 'main' },
              currentWebview: { windowLabel: 'main', label: 'main' },
            },
          },
        });
        Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
          configurable: true,
          value: { unregisterListener: () => {} },
        });
      });

      await page.goto('/');
      await expect(page.locator('.butler-workspace')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');

      const visible = await visibleUiTextWithoutSelfLabels(page);
      expect(visible.trim().length).toBeGreaterThan(20);
      expect(visible).not.toMatch(CJK_RE);
      expect(visible).not.toMatch(/\b(error|failed|failure|could not|cannot|unable to|not found)\b/i);
      expect(pageErrors).toEqual([]);
    },
  );
});
