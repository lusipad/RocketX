import { expect, test, type Page } from '@playwright/test';

const RELEASE_DESKTOP_E2E = process.env.PLAYWRIGHT_RELEASE_MODE === '1';
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const APPIMAGE_HARD_ERROR_RE =
  /\b(traceback|exception|segmentation fault|fatal|error while loading|glibc|not installed|cannot open display|permission denied|no such file|could not (load|find|open|start|initiali)|failed to (load|start|open|initiali|create)|cannot (load|find|open|execute|configure)|unable to (load|find|open|start)|command not found|core dumped)\b/i;
const APPIMAGE_SOFT_ERROR_RE =
  /\b(error|failed|failure|could not|cannot|unable to|not found)\b/i;

test.use({ locale: 'en-US' });

async function installOfflineTauriMock(page: Page) {
  await page.addInitScript(() => {
    let accountGeneration = 0;
    let autostartEnabled = false;
    let notificationPermission: NotificationPermission = 'default';

    Object.defineProperty(window.Notification, 'permission', {
      configurable: true,
      get: () => notificationPermission,
    });
    Object.defineProperty(window.Notification, 'requestPermission', {
      configurable: true,
      value: async () => {
        notificationPermission = 'granted';
        return notificationPermission;
      },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main' },
        },
        invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === 'butler_db_select_account') {
            return { accountScope: args?.accountScope, generation: ++accountGeneration };
          }
          if (command === 'butler_todo_list') return [];
          if (command === 'butler_work_ledger_snapshot') {
            return { cards: [], links: [], sessions: [], evidences: [], events: [], actions: [] };
          }
          if (
            command === 'acp_agent_list'
            || command === 'acp_agent_discover'
            || command === 'acp_local_sessions_discover'
            || command === 'acp_process_list'
            || command === 'butler_memory_list'
            || command === 'butler_assistant_digest_list'
          ) {
            return [];
          }
          if (command === 'pi_runtime_probe') {
            return {
              ready: true,
              available: true,
              runtimeAvailable: true,
              hasCredentials: false,
              source: 'bundled',
              version: '0.1.0',
            };
          }
          if (command === 'pi_list_models') return [];
          if (command === 'codex_runtime_probe') {
            return {
              ready: false,
              available: false,
              version: null,
              executablePath: null,
              source: 'none',
            };
          }
          if (command === 'image_ocr_runtime_probe') {
            return { backend: 'none', reason: 'OCR resource not configured' };
          }
          if (command === 'mcp_config_status' || command === 'agent_bot_config_status') {
            return { enabled: false };
          }
          if (command === 'plugin:notification|is_permission_granted') {
            return notificationPermission === 'granted';
          }
          if (command === 'set_autostart_enabled') {
            autostartEnabled = Boolean(args?.enabled);
            return autostartEnabled;
          }
          if (command === 'read_autostart_enabled') return autostartEnabled;
          if (command === 'plugin:updater|check') return null;
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  });
}

async function expectCleanEnglishScreen(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.trim().length).toBeGreaterThan(20);
  expect(bodyText).not.toMatch(HAN_RE);
  expect(bodyText).not.toMatch(APPIMAGE_HARD_ERROR_RE);
  expect(bodyText).not.toMatch(APPIMAGE_SOFT_ERROR_RE);
}

test(
  'cold-start desktop in English locale renders Butler, onboarding, login, and language settings cleanly',
  { tag: '@release-desktop' },
  async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await installOfflineTauriMock(page);
    await page.goto('/');

    await expect(page.locator('.butler-workspace')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose a project folder' })).toBeVisible();
    await expectCleanEnglishScreen(page);

    await page.getByRole('button', { name: 'Connect Rocket.Chat' }).click();
    await expect(page.getByText('Core Method · GTD, Not a Feature Dump')).toBeVisible();
    await expectCleanEnglishScreen(page);

    await page
      .getByRole('button', {
        name: RELEASE_DESKTOP_E2E ? 'Continue: Desktop Setup' : 'Continue: Setup Options',
      })
      .click();
    if (RELEASE_DESKTOP_E2E) {
      await expect(page.getByRole('heading', { name: 'Desktop Defaults' })).toBeVisible();
      await expectCleanEnglishScreen(page);
      await page.getByRole('button', { name: 'Apply & Continue' }).click();
      await expect(page.getByText('Enabled', { exact: true })).toHaveCount(2);
      await expectCleanEnglishScreen(page);
      await page.getByRole('button', { name: 'Continue to Team Setup' }).click();
    }

    await expect(page.getByRole('heading', { name: 'Join Team Workspace' })).toBeVisible();
    await expectCleanEnglishScreen(page);

    await page.getByRole('button', { name: 'Connect server manually' }).click();
    await expect(page.getByRole('button', { name: 'Connect & Sign In' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open AI Butler' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Unified Kanban' })).toBeVisible();
    await expectCleanEnglishScreen(page);

    await page.getByRole('button', { name: 'Open AI Butler' }).click();
    await expect(page.locator('.butler-workspace')).toBeVisible();
    await expectCleanEnglishScreen(page);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByText('Interface Language', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(System Default|跟随系统)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^简体中文/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^English/ })).toBeVisible();

    await page.getByRole('button', { name: /^简体中文/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByText('主题', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /^English/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByText('Theme', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /^(System Default|跟随系统)/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    expect(pageErrors).toEqual([]);
  },
);

test(
  'cold-start desktop at 800x600 narrow viewport stays clean English',
  { tag: '@release-desktop' },
  async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 800, height: 600 });
    await installOfflineTauriMock(page);
    await page.goto('/');

    await expect(page.locator('.butler-workspace')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose a project folder' })).toBeVisible();
    await expectCleanEnglishScreen(page);

    expect(pageErrors).toEqual([]);
  },
);
