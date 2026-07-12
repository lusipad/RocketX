import { useEffect } from 'react';
import { useAuth } from './stores/auth';
import LoginPage from './pages/LoginPage';
import MainPage from './pages/MainPage';

export default function App() {
  const status = useAuth((s) => s.status);
  const resume = useAuth((s) => s.resume);

  useEffect(() => {
    void resume();
  }, [resume]);

  if (status === 'boot') {
    return (
      <div className="flex h-full items-center justify-center bg-fill-2 text-ink-3">
        正在加载…
      </div>
    );
  }
  return status === 'authed' ? <MainPage /> : <LoginPage />;
}
