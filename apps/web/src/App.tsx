import { useEffect } from 'react';
import { useAuth } from './stores/auth';
import LoginPage from './pages/LoginPage';
import MainPage from './pages/MainPage';
import { useOnboarding } from './stores/onboarding';
import { useImLayout } from './stores/imLayout';
import { useFileIndex } from './stores/fileIndex';
import { useDownloadHistory } from './stores/downloadHistory';
import DesktopUiScaleBridge from './components/DesktopUiScaleBridge';
import GlobalShortcutBridge from './components/GlobalShortcutBridge';
import NotificationNavigationBridge from './components/NotificationNavigationBridge';
import DiagnosticBridge from './components/DiagnosticBridge';
import UpdaterBridge from './components/UpdaterBridge';
import WorkspaceSyncBridge from './components/WorkspaceSyncBridge';
import Toaster from './components/Toaster';
import { getServerBase } from './lib/client';
import { useCodexWorkspace } from './stores/codexWorkspace';

export default function App() {
  const status = useAuth((s) => s.status);
  const resume = useAuth((s) => s.resume);
  const userId = useAuth((s) => s.user?._id);
  const onboardingOwnerId = useOnboarding((s) => s.ownerId);
  const onboarding = useOnboarding((s) => s.state);
  const hydrateOnboarding = useOnboarding((s) => s.hydrate);
  const hydrateImLayout = useImLayout((s) => s.hydrate);
  const fileIndexOwnerId = useFileIndex((s) => s.ownerId);
  const hydrateFileIndex = useFileIndex((s) => s.hydrate);
  const downloadHistoryOwnerId = useDownloadHistory((s) => s.ownerId);
  const hydrateDownloadHistory = useDownloadHistory((s) => s.hydrate);
  const hydrateCodexWorkspace = useCodexWorkspace((s) => s.hydrate);

  useEffect(() => {
    void resume();
  }, [resume]);

  useEffect(() => {
    if (status === 'authed' && userId) {
      hydrateOnboarding(userId);
      hydrateImLayout(userId);
      hydrateFileIndex(userId);
      hydrateDownloadHistory(userId);
      hydrateCodexWorkspace(`${getServerBase() || 'same-origin'}:${userId}`);
    }
  }, [hydrateCodexWorkspace, hydrateDownloadHistory, hydrateFileIndex, hydrateImLayout, hydrateOnboarding, status, userId]);

  let content;
  if (status === 'boot') {
    content = (
      <div className="flex h-full items-center justify-center bg-fill-2 text-ink-3">
        正在加载…
      </div>
    );
  } else if (status !== 'authed') {
    content = <LoginPage />;
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
