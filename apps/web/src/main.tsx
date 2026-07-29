import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { installContextMenuGuard, installLinkInterceptor } from './lib/client';
import { applyRuntimeModeDocumentState, runtimeFeatures } from './lib/runtimeMode';
import { initTheme } from './lib/theme';
import { preloadPinyin } from './lib/pinyin';
import { initializeKernel } from './kernel/runtime';
import { toast } from './stores/toast';
import './styles.css';

async function bootstrap(): Promise<void> {
  // 运行模式必须先落到 document，上层 CSS 和后续启动门禁都依赖它。
  applyRuntimeModeDocumentState();
  // 桌面端：所有外链点击交给系统浏览器（webview 内 target="_blank" 无效）
  installLinkInterceptor((error) => toast.error(error, '无法用系统浏览器打开链接'));
  // 桌面端：屏蔽 webview 自带的右键菜单（聊天软件里不该弹出「刷新 / 另存为 / 检查」）
  installContextMenuGuard();
  // 首屏前应用主题，避免闪烁
  initTheme();
  // 拼音字典单独成块，后台预热，用户点开搜索时已就绪
  preloadPinyin();
  if (runtimeFeatures().bootKernel) {
    await initializeKernel();
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
