import { useEffect } from 'react';
import { useAuth } from '../stores/auth';
import { startButlerPoller, stopButlerPoller } from '../lib/butlerPoller';
import {
  hydrateButlerRoundsForCurrentAccount,
  startButlerRoundsTriggers,
  stopButlerRoundsTriggers,
} from '../lib/butlerRoundsRunner';

export default function ButlerPollerBridge() {
  const authed = useAuth((s) => s.status === 'authed');
  const accountId = useAuth((s) => s.user?._id);

  useEffect(() => {
    hydrateButlerRoundsForCurrentAccount();
    if (authed && accountId) {
      startButlerRoundsTriggers();
      startButlerPoller();
      return () => {
        stopButlerPoller();
        stopButlerRoundsTriggers();
      };
    }
  }, [accountId, authed]);

  return null;
}
