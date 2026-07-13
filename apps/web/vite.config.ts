import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 版本号以桌面端的 package.json 为准（发版时改的就是它），构建时注入。
// 之前设置页里是手写的常量，发了好几个版本都还停在 0.2.3 —— 手写必然会忘。
const desktopPkg = JSON.parse(
  readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'),
) as { version: string };

// 开发时把 API / WebSocket / 头像请求代理到 Rocket.Chat 服务，
// 前端一律用同源相对路径，彻底避开 CORS。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.RC_URL || 'http://localhost:3300';
  return {
    define: {
      __APP_VERSION__: JSON.stringify(desktopPkg.version),
    },
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/avatar': { target, changeOrigin: true },
        '/file-upload': { target, changeOrigin: true },
        '/websocket': { target, changeOrigin: true, ws: true },
      },
    },
  };
});
