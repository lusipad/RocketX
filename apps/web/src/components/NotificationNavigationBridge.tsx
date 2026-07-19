import { useEffect } from 'react';
import { isTauri } from '../lib/http';
import {
  NOTIFICATION_OPEN_ROOM_EVENT,
  notificationDestination,
  notificationTarget,
} from '../lib/notificationNavigation';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

export default function NotificationNavigationBridge() {
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(NOTIFICATION_OPEN_ROOM_EVENT, ({ payload }) => {
          const target = notificationTarget(payload);
          if (!target || useAuth.getState().status !== 'authed') return;
          if (notificationDestination(target) === 'butler-view') {
            useUI.getState().setModule('butler-view');
            return;
          }
          if (!useChat.getState().ready) return;
          useUI.getState().setModule('messages');
          void useChat
            .getState()
            .jumpToMessage(target.mid, target.rid)
            .catch((err) => toast.error(err, '无法打开通知对应的会话'));
        }),
      )
      .then((release) => {
        if (cancelled) release();
        else unlisten = release;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return null;
}
