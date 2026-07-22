import { defineConfig, devices } from '@playwright/test';

const configuredPort = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? '', 10);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536
  ? configuredPort
  : 42_000 + (process.pid % 10_000);
const baseURL = `http://127.0.0.1:${port}`;
// 测试 worker 与 mock 共用配置进程选出的地址，避免误连其他工作树的 Vite 服务。
process.env.PLAYWRIGHT_PORT = String(port);
process.env.PLAYWRIGHT_BASE_URL = baseURL;

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    baseURL,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `pnpm --filter @rcx/web exec vite --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
