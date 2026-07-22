import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated, TEST_SERVER } from './support/rocket-chat-mock';

const USER_ID = 'user-me';
const FILE_PATH = 'C:\\Users\\tester\\Downloads\\RocketX-guide.pdf';

async function installDesktopBridge(page: Page) {
  await page.addInitScript(() => {
    let nextRid = 1;
    const requests = new Map<number, { method: string; url: string; headers: string[][]; data?: number[] }>();
    const responses = new Map<number, { bytes: number[]; read: boolean }>();
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    (window as unknown as { __desktopCalls: typeof calls }).__desktopCalls = calls;

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string, args?: Record<string, any>) => {
          calls.push({ command, args });
          if (command === 'allow_http_origin') return new URL(String(args?.origin)).origin;
          if (command === 'plugin:http|fetch') {
            const rid = nextRid++;
            requests.set(rid, args?.clientConfig);
            return rid;
          }
          if (command === 'plugin:http|fetch_send') {
            const request = requests.get(Number(args?.rid))!;
            const response = await fetch(request.url, {
              method: request.method,
              headers: request.headers,
              body: request.data ? new Uint8Array(request.data) : undefined,
            });
            const rid = nextRid++;
            responses.set(rid, { bytes: [...new Uint8Array(await response.arrayBuffer())], read: false });
            return {
              status: response.status,
              statusText: response.statusText,
              url: response.url,
              headers: [...response.headers.entries()],
              rid,
            };
          }
          if (command === 'plugin:http|fetch_read_body') {
            const response = responses.get(Number(args?.rid))!;
            if (response.read) return [1];
            response.read = true;
            return [...response.bytes, 0];
          }
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

test('桌面下载页可打开文件、定位目录并只清除记录（issue #169）', async ({ page }) => {
  await installDesktopBridge(page);
  await page.addInitScript(({ server, userId, filePath }) => {
    const key = `rcx-download-history-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      records: [{
        id: 'download-1',
        fileName: 'RocketX-guide.pdf',
        path: filePath,
        completedAt: Date.parse('2026-07-22T12:00:00.000Z'),
      }],
    }));
  }, { server: TEST_SERVER, userId: USER_ID, filePath: FILE_PATH });
  const state = await bootAuthenticated(page);
  await expect.poll(() => page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(true);

  await page.getByRole('button', { name: '下载', exact: true }).click();
  await expect(page.getByRole('heading', { name: '下载' })).toBeVisible();
  await expect(page.getByText('RocketX-guide.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText(FILE_PATH)).toBeVisible();

  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  const revealButton = page.getByRole('button', { name: '打开所在文件夹', exact: true });
  await expect(revealButton).toBeEnabled();
  await revealButton.click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __desktopCalls: Array<{ command: string }> }).__desktopCalls
      .filter((item) => item.command.startsWith('plugin:opener|')).length,
  )).toBe(2);
  const openerCalls = await page.evaluate(() =>
    (window as unknown as { __desktopCalls: Array<{ command: string; args?: Record<string, unknown> }> })
      .__desktopCalls.filter((item) => item.command.startsWith('plugin:opener|')),
  );
  expect(openerCalls).toEqual([
    { command: 'plugin:opener|open_path', args: { path: FILE_PATH, with: undefined } },
    { command: 'plugin:opener|reveal_item_in_dir', args: { paths: [FILE_PATH] } },
  ]);

  await page.getByRole('button', { name: '清除记录' }).click();
  await expect(page.getByRole('dialog', { name: '清除下载记录' })).toContainText('不会删除磁盘上的文件');
  await page.getByRole('dialog', { name: '清除下载记录' }).getByRole('button', { name: '清除记录' }).click();
  await expect(page.getByText('暂无下载记录')).toBeVisible();

  const removeCalls = await page.evaluate(() =>
    (window as unknown as { __desktopCalls: Array<{ command: string }> }).__desktopCalls
      .filter((item) => item.command.includes('remove')),
  );
  expect(removeCalls).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
