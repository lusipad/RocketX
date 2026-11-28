import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './agent/acpButlerWiring';
import './agent/codexHostTools';
import { initializeStartupAiRuntimeProvider } from './lib/aiRuntimeBootstrap';
import { getServerBase, installContextMenuGuard, installLinkInterceptor, setServerBase } from './lib/client';
import {
  flushDesktopClientStateBackup,
  installDesktopClientStateMirror,
  restoreDesktopClientStateIfEmpty,
} from './lib/desktopConfigBackup';
import { loadWorkbenchConfig } from './lib/ado';
import { applyRuntimeModeDocumentState, runtimeFeatures } from './lib/runtimeMode';
import { initI18n, t } from './i18n';
import { autostartAvailable } from './lib/autostart';
import { hasExistingRocketXUserState, prepareDesktopDefaultsRecord, resetFirstRun } from './lib/firstRun';
import { initTheme } from './lib/theme';
import { preloadPinyin } from './lib/pinyin';
import {
  ensureCoreModulesRegistered,
  ensureKernelStoreReady,
  initializeKernel,
  syncAiKernelBuiltins,
} from './kernel/runtime';
import { probePiRuntime, selectNativeButlerAccount } from './platform/desktopCommands';
import { isTauri } from './lib/http';
import { LOCAL_ACCOUNT_OWNER } from './lib/accountScope';
import { useAuth } from './stores/auth';
import { useCalendar } from './stores/calendar';
import { useChat } from './stores/chat';
import { useFolders } from './stores/folders';
import { usePrefs } from './stores/prefs';
import { useOnboarding } from './stores/onboarding';
import { useImLayout } from './stores/imLayout';
import { useFileIndex } from './stores/fileIndex';
import { useDownloadHistory } from './stores/downloadHistory';
import { useCodexWorkspace } from './stores/codexWorkspace';
import { useWorkbench } from './stores/workbench';
import { beginWorkLedgerAccount } from './stores/workLedger';
import { awaitTodoAccountReady } from './stores/todos';
import { createStartupCoordinator, type StartupCoordinator } from './lib/startup';
import { toast } from './stores/toast';
import { readPersistedModule, readPersistedNavCollapsed, UI_MODULE_STORAGE_KEY, useUI } from './stores/ui';
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
  if (
    useAuth.getState().localMode &&
    !hasPersistedModuleSelection() &&
    useUI.getState().module === 'messages'
  ) {
    useUI.getState().setModule(runtimeFeatures().butler ? 'butler-view' : 'todos');
  }
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
  const runtimeProviderReady = aiRuntimeProviderReady.then(
    (aiRuntimeProvider) => {
      useUI.setState({ aiRuntimeProvider, aiRuntimeProbing: false });
      syncAiKernelBuiltins();
      if (runtimeFeatures().runtimeProbes) {
        void probePiRuntime().catch(() => undefined);
      }
      return aiRuntimeProvider;
    },
    (error) => {
      console.warn('[rcx] AI 运行时探测失败，降级为无 AI 运行时', error);
      useUI.setState({ aiRuntimeProvider: 'none', aiRuntimeProbing: false });
      return 'none' as const;
    },
  );
  const coordinator = createStartupCoordinator({
    steps: {
      preparePlatform: async (signal) => {
        if (signal?.aborted) throw new Error(t('auth.startup.aborted'));
        ensureCoreModulesRegistered();
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
        // AI 探测（尤其首次解包 Pi 运行时）不阻塞日历/待办/工作台等核心模块启动；最多小等 1.5s 后放行首屏。
        await Promise.race([
          (async () => {
            await runtimeProviderReady;
          })(),
          new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
        ]);
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
        if (runtimeFeatures().runtimeProbes && !useUI.getState().aiRuntimeProbing) {
          await probePiRuntime().catch(() => undefined);
        }
        if (signal?.aborted) throw new Error(t('auth.startup.backgroundAborted'));
      },
    },
    onState: ({ stage, error }) => {
      useUI.setState({ startupStage: stage, startupError: error });
      if (stage === 'error' && error && !['platform', 'auth', 'account'].includes(error.operation)) {
        toast.error(error.message);
      }
    },
  });
  useUI.setState({ retryStartup: coordinator.retry });
  return coordinator;
}

async function bootstrapOnce(): Promise<void> {
  const restoredFromBackup = isTauri
    ? await restoreDesktopClientStateIfEmpty(localStorage)
    : false;
  // 运行模式、主题和语言必须先落到 document，避免首屏闪烁并让后续启动门禁读到正确设置。
  applyRuntimeModeDocumentState();
  initTheme();
  initI18n();
  if (restoredFromBackup) {
    const server = getServerBase();
    if (server) setServerBase(server);
    useCalendar.getState().reload();
    useFolders.getState().reload();
    useWorkbench.setState({ config: loadWorkbenchConfig() });
    useUI.setState({
      module: readPersistedModule(localStorage),
      navRailCollapsed: readPersistedNavCollapsed(localStorage),
    });
  }
  ensureCoreModulesRegistered();
  if (isTauri) {
    // 恢复无账号会创建本地 owner；设备是否首次安装必须提前判定。
    const hasExistingUserState = hasExistingRocketXUserState(localStorage);
    prepareDesktopDefaultsRecord({ storage: localStorage, releaseDesktop: autostartAvailable, hasExistingUserState });
    if (!hasExistingUserState) resetFirstRun(localStorage);
    installDesktopClientStateMirror(localStorage);
    if (hasExistingUserState) {
      void flushDesktopClientStateBackup(localStorage);
    }
  }
  useUI.setState({ aiRuntimeProbing: isTauri && runtimeFeatures().runtimeProbes });
  // AI 运行时探测不阻塞首屏与日历/待办等内建模块；完成后再动态补全 AI 扩展入口。
  const aiRuntimeProviderReady = initializeStartupAiRuntimeProvider({});

  startupCoordinator ??= createCoordinator(aiRuntimeProviderReady);
  useAuth.subscribe((state, previous) => {
    const authTransition =
      state.user?._id !== previous.user?._id ||
      (!state.localMode && previous.status !== 'authed') ||
      (!state.localMode && !state.needsReauth && previous.needsReauth);
    if (state.status === 'authed' && authTransition) {
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
