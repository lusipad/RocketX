import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { initializeStartupAiRuntimeProvider } from './lib/aiRuntimeBootstrap';
import { getServerBase, installContextMenuGuard, installLinkInterceptor } from './lib/client';
import { applyRuntimeModeDocumentState, runtimeFeatures } from './lib/runtimeMode';
import { initTheme } from './lib/theme';
import { preloadPinyin } from './lib/pinyin';
import { ensureKernelStoreReady, initializeKernel } from './kernel/runtime';
import { getCodexManualPath } from './stores/codexRuntime';
import { useCodexRuntime } from './stores/codexRuntime';
import { useAuth } from './stores/auth';
import { useChat } from './stores/chat';
import { usePrefs } from './stores/prefs';
import { useOnboarding } from './stores/onboarding';
import { useImLayout } from './stores/imLayout';
import { useFileIndex } from './stores/fileIndex';
import { useDownloadHistory } from './stores/downloadHistory';
import { useCodexWorkspace } from './stores/codexWorkspace';
import { createStartupCoordinator, type StartupCoordinator } from './lib/startup';
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

let bootstrapPromise: Promise<void> | null = null;
let startupCoordinator: StartupCoordinator | null = null;

function hydrateAccount(userId: string): void {
  useOnboarding.getState().hydrate(userId);
  useImLayout.getState().hydrate(userId);
  useFileIndex.getState().hydrate(userId);
  useDownloadHistory.getState().hydrate(userId);
  useCodexWorkspace.getState().hydrate(`${getServerBase() || 'same-origin'}:${userId}`);
}

function createCoordinator(
  aiRuntimeProviderReady: Promise<ReturnType<typeof useUI.getState>['aiRuntimeProvider']>,
): StartupCoordinator {
  let platformPrepared = false;
  const runtimeProviderReady = aiRuntimeProviderReady.then((aiRuntimeProvider) => {
    useUI.setState({ aiRuntimeProvider });
    return aiRuntimeProvider;
  });
  const coordinator = createStartupCoordinator({
    steps: {
      preparePlatform: async (signal) => {
        if (signal?.aborted) throw new Error('启动任务已取消');
        if (platformPrepared) return;
        // 桌面端：所有外链点击交给系统浏览器（webview 内 target="_blank" 无效）
        installLinkInterceptor((error) => toast.error(error, '无法用系统浏览器打开链接'));
        // 桌面端：屏蔽 webview 自带的右键菜单（聊天软件里不该弹出「刷新 / 另存为 / 检查」）
        installContextMenuGuard();
        await ensureKernelStoreReady();
        platformPrepared = true;
      },
      restoreAuth: async (signal) => {
        if (useAuth.getState().status !== 'authed') await useAuth.getState().resume();
        if (signal?.aborted) throw new Error('登录恢复已取消');
      },
      readAuth: () => {
        const auth = useAuth.getState();
        return { status: auth.status, userId: auth.user?._id ?? null };
      },
      hydrateAccount,
      loadCoreData: async (signal) => {
        await Promise.all([
          useChat.getState().init(),
          usePrefs.getState().load(),
        ]);
        if (signal?.aborted) throw new Error('核心数据加载已取消');
        if (!useChat.getState().ready) throw new Error('无法加载会话列表，请重试');
      },
      initializeRuntime: async (signal) => {
        await runtimeProviderReady;
        if (signal?.aborted) throw new Error('本地运行时探测已取消');
      },
      initializeKernel: async (signal) => {
        if (runtimeFeatures().bootKernel) await initializeKernel(undefined, signal);
        if (signal?.aborted) throw new Error('扩展内核启动已取消');
      },
      startBackground: async (signal) => {
        if (runtimeFeatures().runtimeProbes) await useCodexRuntime.getState().probe();
        if (signal?.aborted) throw new Error('后台任务启动已取消');
      },
    },
    onState: ({ stage, error }) => useUI.setState({ startupStage: stage, startupError: error }),
  });
  useUI.setState({ retryStartup: coordinator.retry });
  return coordinator;
}

async function bootstrapOnce(): Promise<void> {
  // 运行模式和主题必须先落到 document，避免首屏闪烁并让后续启动门禁读到正确模式。
  applyRuntimeModeDocumentState();
  initTheme();
  // AI 运行时探测不阻塞首屏，协调器会在消息连接后等待它再启动 Kernel。
  const aiRuntimeProviderReady = initializeStartupAiRuntimeProvider({
    manualCodexPath: getCodexManualPath() || null,
  });

  startupCoordinator ??= createCoordinator(aiRuntimeProviderReady);
  useAuth.subscribe((state, previous) => {
    if (state.status === 'authed' && previous.status !== 'authed') {
      void startupCoordinator?.start();
    }
  });
  const startupPromise = startupCoordinator.start();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  scheduleStartupWarmups();
  await startupPromise;
}

export function bootstrap(): Promise<void> {
  bootstrapPromise ??= bootstrapOnce();
  return bootstrapPromise;
}

void bootstrap();
