import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { initializeStartupAiRuntimeProvider } from './lib/aiRuntimeBootstrap';
import { installContextMenuGuard, installLinkInterceptor } from './lib/client';
import { applyRuntimeModeDocumentState, runtimeFeatures } from './lib/runtimeMode';
import { initTheme } from './lib/theme';
import { preloadPinyin } from './lib/pinyin';
import { initializeKernel } from './kernel/runtime';
import { getCodexManualPath } from './stores/codexRuntime';
import { toast } from './stores/toast';
import { useUI } from './stores/ui';
import './styles.css';

function scheduleStartupWarmups(): void {
  const run = () => preloadPinyin();
  const schedule = () => window.setTimeout(run, 1_200);
  window.requestAnimationFrame(() => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(schedule, { timeout: 2_000 });
      return;
    }
    schedule();
  });
}

async function bootstrap(): Promise<void> {
  // 运行模式必须先落到 document，上层 CSS 和后续启动门禁都依赖它。
  applyRuntimeModeDocumentState();
  // 桌面端：所有外链点击交给系统浏览器（webview 内 target="_blank" 无效）
  installLinkInterceptor((error) => toast.error(error, '无法用系统浏览器打开链接'));
  // 桌面端：屏蔽 webview 自带的右键菜单（聊天软件里不该弹出「刷新 / 另存为 / 检查」）
  installContextMenuGuard();
  // 首屏前应用主题，避免闪烁
  initTheme();
  // AI 运行时探测（full 版含私有运行时归档校验和 node/codex 进程探测，秒级耗时）
  // 不阻塞首屏：先渲染，探测完成后应用 provider 再初始化 kernel——kernel 的
  // 例行任务调度依赖最终 provider，而界面模块注册是响应式的，晚到也能正确呈现。
  const aiRuntimeProviderReady = initializeStartupAiRuntimeProvider({
    manualCodexPath: getCodexManualPath() || null,
  });

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  // 拼音字典单独成块，等首屏渲染后再空闲预热
  scheduleStartupWarmups();

  const aiRuntimeProvider = await aiRuntimeProviderReady;
  useUI.setState({ aiRuntimeProvider });
  if (runtimeFeatures().bootKernel) {
    await initializeKernel();
  }
}

void bootstrap();
