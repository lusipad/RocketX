import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

const port = process.env.PLAYWRIGHT_PORT!;
const baseURL = process.env.PLAYWRIGHT_BASE_URL!;

// 生产预览会把 import.meta.env.DEV 编译为 false，固定覆盖仅正式桌面版启用的路径。
process.env.PLAYWRIGHT_RELEASE_MODE = '1';

export default defineConfig({
  ...baseConfig,
  webServer: {
    command: `node ./apps/web/node_modules/vite/bin/vite.js preview ./apps/web --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 120_000,
  },
});
