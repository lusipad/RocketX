import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 开发时把 API / WebSocket / 头像请求代理到 Rocket.Chat 服务，
// 前端一律用同源相对路径，彻底避开 CORS。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.RC_URL || 'http://localhost:3300';
  return {
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
