import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { initializeStartupAiRuntimeProvider } from './lib/aiRuntimeBootstrap';
import { getServerBase, installContextMenuGuard, installLinkInterceptor } from './lib/client';
import { applyRuntimeModeDocumentState, runtimeFeatures } from './lib/runtimeMode';
import { initI18n, t } from './i18n';
import { autostartAvailable } from './lib/autostart';
import { hasExistingRocketXUserState, prepareDesktopDefaultsRecord, resetFirstRun } from './lib/firstRun';
import { initTheme } from './lib/theme';
import { preloadPinyin } from './lib/pinyin';
import { ensureKernelStoreReady, initializeKernel } from './kernel/runtime';
import { probePiRuntime, selectNativeButlerAccount } from './platform/desktopCommands';
import { isTauri } from './lib/http';
import { LOCAL_ACCOUNT_OWNER } from './lib/accountScope';
import { useAuth } from './stores/auth';
import { useChat } from './stores/chat';
import { usePrefs } from './stores/prefs';
import { useOnboarding } from './stores/onboarding';
import { useImLayout } from './stores/imLayout';
import { useFileIndex } from './stores/fileIndex';
import { useDownloadHistory } from './stores/downloadHistory';
import { useCodexWorkspace } from './stores/codexWorkspace';
import { beginWorkLedgerAccount } from './stores/workLedger';
import { awaitTodoAccountReady } from './stores/todos';
import { createStartupCoordinator, type StartupCoordinator } from './lib/startup';
import { toast } from './stores/toast';
import { UI_MODULE_STORAGE_KEY, useUI } from './stores/ui';
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

async function hydrateAccount(userId: string): Promise<void> {
  const scope = useAuth.getState().localMode ? LOCAL_ACCOUNT_OWNER : `${userId}@${getServerBase() || 'same-origin'}`;
  const activateLedger = beginWorkLedgerAccount(scope);
  if (isTauri) {
    await selectNativeButlerAccount(scope);
    await awaitTodoAccountReady();
  }
  activateLedger();
  useOnboarding.getState().hydrate(userId);
  useImLayout.getState().hydrate(userId);
  useFileIndex.getState().hydrate(userId);
  useDownloadHistory.getState().hydrate(userId);
  useCodexWorkspace.getState().hydrate(`${getServerBase() || 'same-origin'}:${userId}`);
}

function hasPersistedModuleSelection(): boolean {
  try {
    return typeof localStorage !== 'undefined' && Boolean(localStorage.getItem(UI_MODULE_STORAGE_KEY));
  } catch {
    return false;
  }
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
        if (signal?.aborted) throw new Error(t('auth.startup.aborted'));
        if (platformPrepared) return;
        installLinkInterceptor(
          (mid) => void useChat.getState().jumpToMessage(mid),
          (error) => toast.error(error, t('auth.main.openExternalFailed')),
        );
        // 桌面端：屏蔽 webview 自带的右键菜单（聊天软件里不该弹出「刷新 / 另存为 / 检查」）
        installContextMenuGuard();
        await ensureKernelStoreReady();
        platformPrepared = true;
      },
      restoreAuth: async (signal) => {
        if (useAuth.getState().status !== 'authed') await useAuth.getState().resume();
        if (signal?.aborted) throw new Error(t('auth.startup.restoreAuthAborted'));
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
        if (signal?.aborted) throw new Error(t('auth.startup.loadCoreDataAborted'));
        if (!useChat.getState().ready) throw new Error(t('auth.startup.loadConversationsFailed'));
      },
      initializeRuntime: async (signal) => {
        await runtimeProviderReady;
        if (signal?.aborted) throw new Error(t('auth.startup.runtimeProbeAborted'));
      },
      initializeKernel: async (signal) => {
        if (runtimeFeatures().bootKernel) await initializeKernel(undefined, signal);
        if (
          useAuth.getState().localMode &&
          !hasPersistedModuleSelection() &&
          useUI.getState().module === 'messages'
        ) {
          useUI.getState().setModule(runtimeFeatures().butler ? 'butler-view' : 'todos');
        }
        if (signal?.aborted) throw new Error(t('auth.startup.kernelInitAborted'));
      },
      startBackground: async (signal) => {
        if (runtimeFeatures().runtimeProbes) await probePiRuntime().catch(() => undefined);
        if (signal?.aborted) throw new Error(t('auth.startup.backgroundAborted'));
      },
    },
    onState: ({ stage, error }) => useUI.setState({ startupStage: stage, startupError: error }),
  });
  useUI.setState({ retryStartup: coordinator.retry });
  return coordinator;
}

async function bootstrapOnce(): Promise<void> {
  // 运行模式、主题和语言必须先落到 document，避免首屏闪烁并让后续启动门禁读到正确设置。
  applyRuntimeModeDocumentState();
  initTheme();
  initI18n();
  if (isTauri) {
    // 恢复无账号会创建本地 owner；设备是否首次安装必须提前判定。
    const hasExistingUserState = hasExistingRocketXUserState(localStorage);
    prepareDesktopDefaultsRecord({ storage: localStorage, releaseDesktop: autostartAvailable, hasExistingUserState });
    if (!hasExistingUserState) resetFirstRun(localStorage);
  }
  // AI 运行时探测不阻塞首屏，协调器会在消息连接后等待它再启动 Kernel。
  const aiRuntimeProviderReady = initializeStartupAiRuntimeProvider({});

  startupCoordinator ??= createCoordinator(aiRuntimeProviderReady);
  useAuth.subscribe((state, previous) => {
    if (state.status === 'authed' && (
      state.user?._id !== previous.user?._id || (!state.localMode && previous.status !== 'authed')
    )) {
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
