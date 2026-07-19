import { useEffect } from 'react';
import { useAuth } from '../stores/auth';
import { startButlerPoller, stopButlerPoller } from '../lib/butlerPoller';

export default function ButlerPollerBridge() {
  const authed = useAuth((s) => s.status === 'authed');

  useEffect(() => {
    if (authed) {
      startButlerPoller();
      return stopButlerPoller;
    }
  }, [authed]);

  return null;
}
