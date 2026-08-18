import { defineConfig, devices } from '@playwright/test';

// 连接真实 Rocket.Chat 服务器的 live 验证专用配置（不进默认 pnpm test:ui 套件）。
// 运行方式见 tests/ui/live-issues.spec.ts 头部注释。
// 注意：webServer 用的是 `vite preview`（服务 apps/web/dist 的发布构建），
// 必须先跑 `pnpm --filter @rcx/web build`。
const configuredPort = Number.parseInt(process.env.PLAYWRIGHT_LIVE_PORT ?? '', 10);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536
  ? configuredPort
  : 45_000 + (process.pid % 5_000);
const baseURL = `http://127.0.0.1:${port}`;
// worker 进程会各自重新加载本配置，pid 不同会算出不同端口——
// 由主进程把选定的端口写进 env，worker 继承后复用同一地址（同 playwright.config.ts 的做法）。
process.env.PLAYWRIGHT_LIVE_PORT = String(port);

export default defineConfig({
  testDir: './tests/ui',
  testMatch: 'live-issues.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    baseURL,
    serviceWorkers: 'block',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `pnpm --filter @rcx/web exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
