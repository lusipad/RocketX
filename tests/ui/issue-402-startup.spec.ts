import { expect, test } from '@playwright/test';

const BACKUP_PAYLOAD = {
  schema: 'rcx-client-state-v1',
  updatedAt: 1795737600000,
  entries: {
    'rcx-server': 'https://chat.example.com',
    'rcx-owner': 'alice@https://chat.example.com',
    'rcx-user-cache': JSON.stringify({ _id: 'alice', username: 'alice', name: 'Alice' }),
    'rcx-first-run-v1': 'complete',
    'rcx-locale': 'zh-CN',
    'rcx-calendar': JSON.stringify({
      version: 1,
      data: [
        {
          id: 'evt-402',
          title: '架构评审例会',
          date: (() => {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          })(),
          startTime: '14:00',
          endTime: '15:00',
          allDay: false,
          color: '#3370ff',
          source: 'manual',
          createdAt: 1795737600000,
        },
      ],
    }),
  },
};

test('Issue #402: slow pi_runtime_probe never blocks Calendar/To-Dos and restores backed up remote account without token', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.addInitScript(({ backup }) => {
    let accountGeneration = 0;
    const selectedButlerScopes: string[] = [];
    (window as unknown as { __selectedButlerScopes?: string[] }).__selectedButlerScopes = selectedButlerScopes;
    let resolveProbe: ((value: unknown) => void) | null = null;
    (window as unknown as { __finishPiProbe?: () => void }).__finishPiProbe = () => {
      resolveProbe?.({
        ready: true,
        version: '1.5.0',
        source: 'bundled',
        configuredProvider: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
        hasCredentials: true,
      });
      resolveProbe = null;
    };

    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        transformCallback: () => 0,
        unregisterCallback: () => {},
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { windowLabel: 'main', label: 'main' },
        },
        invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === 'read_desktop_preferences' && args?.scope === '__rcx_client_state_v1__') {
            return backup;
          }
          if (command === 'write_desktop_preferences') return null;
          if (command === 'desktop_distribution_profile') return 'slim';
          if (command === 'butler_db_select_account') {
            const scope = String(args?.accountScope ?? '');
            selectedButlerScopes.push(scope);
            return {
              accountScope: scope,
              generation: ++accountGeneration,
            };
          }
          if (command === 'butler_todo_list') return [];
          if (command === 'butler_todo_migrate_from_json') return 0;
          if (command === 'butler_memory_list') return [];
          if (command === 'butler_skill_list') return [];
          if (command === 'butler_work_ledger_snapshot') {
            return { cards: [], links: [], sessions: [], evidences: [], events: [], actions: [] };
          }
          if (command === 'acp_local_sessions_discover') return [];
          if (command === 'acp_agent_list') return [];
          if (command === 'pi_local_gateways_scan') return [];
          if (command === 'pi_config_read') {
            return {
              provider: 'deepseek',
              apiProtocol: 'auto',
              baseUrl: 'https://api.deepseek.com/v1',
              hasApiKey: true,
              apiKeyHint: 'sk-a••••1234',
              defaultModel: 'deepseek-v4-flash',
              extraModels: [],
            };
          }
          if (command === 'pi_runtime_probe') {
            return await new Promise((resolve) => {
              resolveProbe = resolve;
            });
          }
          return null;
        },
      },
    });
  }, { backup: BACKUP_PAYLOAD });

  await page.goto('/');

  // Startup in restored remote account (no token -> needsReauth) lands cleanly inside MainPage with embedded LoginPage in Messages and active NavRail
  await expect(page.getByRole('button', { name: '连接并登录 Rocket.Chat' })).toBeVisible({ timeout: 8000 });
  const nav = page.getByRole('navigation', { name: 'RocketX 主导航' });
  const calendarBtn = nav.getByRole('button', { name: /日历/ });
  const butlerBtn = nav.getByRole('button', { name: /管家/ });
  const messagesBtn = nav.getByRole('button', { name: /消息/ });
  await expect(calendarBtn).toBeVisible();
  await expect(nav.getByRole('button', { name: /待办/ })).toBeVisible();
  await expect(butlerBtn).toBeVisible();
  await expect(messagesBtn).toBeVisible();

  // While pi_runtime_probe is still pending, Butler shows non-blocking probing message
  await butlerBtn.click();
  await expect(page.getByText('正在准备本地 AI 运行时…')).toBeVisible({ timeout: 5000 });

  // Clicking 日历 immediately displays restored calendar event even before pi_runtime_probe finishes
  await calendarBtn.click();
  await expect(page.getByText('架构评审例会').first()).toBeVisible({ timeout: 5000 });

  // Clicking 消息 returns to embedded Rocket.Chat re-auth without wiping account scope or leaving MainPage
  await messagesBtn.click();
  await expect(page.getByRole('button', { name: '连接并登录 Rocket.Chat' })).toBeVisible({ timeout: 5000 });

  // Restored localStorage owner & server survived fresh WebView load without switching to local-user@local
  const accountCheck = await page.evaluate(() => ({
    server: localStorage.getItem('rcx-server'),
    owner: localStorage.getItem('rcx-owner'),
    selectedScopes: (window as unknown as { __selectedButlerScopes?: string[] }).__selectedButlerScopes ?? [],
  }));
  expect(accountCheck.server).toBe('https://chat.example.com');
  expect(accountCheck.owner).toBe('alice@https://chat.example.com');
  expect(accountCheck.selectedScopes).toEqual(['alice@https://chat.example.com']);

  // Once pi_runtime_probe completes, Butler surface seamlessly transitions to active runtime
  await page.evaluate(() => {
    (window as unknown as { __finishPiProbe?: () => void }).__finishPiProbe?.();
  });
  await nav.getByRole('button', { name: /管家/ }).click();
  await expect(page.getByText('正在准备本地 AI 运行时…')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
