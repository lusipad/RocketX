import { useEffect } from 'react';
import { useAuth } from '../stores/auth';
import { startButlerPoller, stopButlerPoller } from '../lib/butlerPoller';
import { startCoffeeScheduler, stopCoffeeScheduler } from '../lib/coffeeTime';
import { useUI } from '../stores/ui';
import { isTauri } from '../lib/http';

async function coffeeNotify(missed: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('show_message_notification', {
      title: '咖啡时间',
      body: missed > 1 ? `有 ${missed} 个时段的事项待查看` : '来看看需要关注什么',
      rid: 'butler',
      mid: 'coffee-time',
    });
  } catch { /* 通知失败不阻断 */ }
}

export default function ButlerPollerBridge() {
  const authed = useAuth((s) => s.status === 'authed');
  const setModule = useUI((s) => s.setModule);

  useEffect(() => {
    if (authed) {
      startButlerPoller();
      startCoffeeScheduler((missed) => {
        setModule('butler-view');
        void coffeeNotify(missed);
      });
      return () => {
        stopButlerPoller();
        stopCoffeeScheduler();
      };
    }
  }, [authed, setModule]);

  return null;
}
