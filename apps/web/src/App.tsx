import { useEffect } from 'react';
import { useAuth } from './stores/auth';
import LoginPage from './pages/LoginPage';
import MainPage from './pages/MainPage';
import AdoOnboardingPage from './pages/AdoOnboardingPage';
import { useOnboarding } from './stores/onboarding';
import { useImLayout } from './stores/imLayout';

export default function App() {
  const status = useAuth((s) => s.status);
  const resume = useAuth((s) => s.resume);
  const userId = useAuth((s) => s.user?._id);
  const onboardingOwnerId = useOnboarding((s) => s.ownerId);
  const onboarding = useOnboarding((s) => s.state);
  const hydrateOnboarding = useOnboarding((s) => s.hydrate);
  const hydrateImLayout = useImLayout((s) => s.hydrate);

  useEffect(() => {
    void resume();
  }, [resume]);

  useEffect(() => {
    if (status === 'authed' && userId) {
      hydrateOnboarding(userId);
      hydrateImLayout(userId);
    }
  }, [hydrateImLayout, hydrateOnboarding, status, userId]);

  if (status === 'boot') {
    return (
      <div className="flex h-full items-center justify-center bg-fill-2 text-ink-3">
        正在加载…
      </div>
    );
  }
  if (status !== 'authed') return <LoginPage />;
  if (!userId || onboardingOwnerId !== userId || !onboarding) {
    return (
      <div className="flex h-full items-center justify-center bg-fill-2 text-ink-3">
        正在加载个人设置…
      </div>
    );
  }
  return onboarding.ado === 'pending' ? <AdoOnboardingPage /> : <MainPage />;
}
