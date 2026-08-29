import { useAuth } from './stores/auth';
import LoginPage from './pages/LoginPage';
import MainPage from './pages/MainPage';
import { useOnboarding } from './stores/onboarding';
import { useFileIndex } from './stores/fileIndex';
import { useDownloadHistory } from './stores/downloadHistory';
import DesktopUiScaleBridge from './components/DesktopUiScaleBridge';
import GlobalShortcutBridge from './components/GlobalShortcutBridge';
import NotificationNavigationBridge from './components/NotificationNavigationBridge';
import DiagnosticBridge from './components/DiagnosticBridge';
import UpdaterBridge from './components/UpdaterBridge';
import WorkspaceSyncBridge from './components/WorkspaceSyncBridge';
import Toaster from './components/Toaster';
import { useUI } from './stores/ui';

export default function App() {
  const status = useAuth((s) => s.status);
  const userId = useAuth((s) => s.user?._id);
  const onboardingOwnerId = useOnboarding((s) => s.ownerId);
  const onboarding = useOnboarding((s) => s.state);
  const fileIndexOwnerId = useFileIndex((s) => s.ownerId);
  const downloadHistoryOwnerId = useDownloadHistory((s) => s.ownerId);
  const startupStage = useUI((s) => s.startupStage);
  const startupError = useUI((s) => s.startupError);
  const retryStartup = useUI((s) => s.retryStartup);

  let content;
  if (status === 'boot') {
    content = (
      <div className="flex h-full items-center justify-center bg-fill-2 text-ink-3">
        正在加载…
      </div>
    );
  } else if (status !== 'authed') {
    content = <LoginPage />;
  } else if (startupStage === 'error') {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-fill-2 px-6 text-center">
        <div className="text-lg font-medium text-ink">启动没有完成</div>
        <div className="max-w-md text-sm text-ink-3">
          {startupError?.message || '应用初始化失败，请重试。'}
        </div>
        <button
          type="button"
          onClick={() => void retryStartup()}
          className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-white transition hover:bg-primary-hover active:bg-primary-active"
        >
          重试
        </button>
      </div>
    );
  } else if (
    !userId ||
    onboardingOwnerId !== userId ||
    fileIndexOwnerId !== userId ||
    downloadHistoryOwnerId !== userId ||
    !onboarding
  ) {
    content = (
      <div className="flex h-full items-center justify-center bg-fill-2 text-ink-3">
        正在加载个人设置…
      </div>
    );
  } else {
    content = <MainPage />;
  }
  return (
    <>
      <DiagnosticBridge />
      <UpdaterBridge />
      <WorkspaceSyncBridge />
      <DesktopUiScaleBridge />
      <GlobalShortcutBridge />
      <NotificationNavigationBridge />
      {content}
      <Toaster />
    </>
  );
}
