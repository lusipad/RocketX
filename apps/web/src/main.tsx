import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installContextMenuGuard, installLinkInterceptor } from './lib/client';
import { initTheme } from './lib/theme';
import { preloadPinyin } from './lib/pinyin';
import './styles.css';

// 桌面端：所有外链点击交给系统浏览器（webview 内 target="_blank" 无效）
installLinkInterceptor();
// 桌面端：屏蔽 webview 自带的右键菜单（聊天软件里不该弹出「刷新 / 另存为 / 检查」）
installContextMenuGuard();
// 首屏前应用主题，避免闪烁
initTheme();
// 拼音字典单独成块，后台预热，用户点开搜索时已就绪
preloadPinyin();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
