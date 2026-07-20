import { useEffect } from 'react';
import { useAuth } from '../stores/auth';
import { startButlerPoller, stopButlerPoller } from '../lib/butlerPoller';
import { startButlerRoundsTriggers, stopButlerRoundsTriggers } from '../lib/butlerRoundsRunner';

export default function ButlerPollerBridge() {
  const authed = useAuth((s) => s.status === 'authed');

  useEffect(() => {
    if (authed) {
      startButlerRoundsTriggers();
      startButlerPoller();
      return () => {
        stopButlerPoller();
        stopButlerRoundsTriggers();
      };
    }
  }, [authed]);

  return null;
}
