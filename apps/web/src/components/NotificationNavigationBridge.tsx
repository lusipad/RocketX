import { useEffect } from 'react';
import { isTauri } from '../lib/http';
import {
  NOTIFICATION_OPEN_ROOM_EVENT,
  notificationRoomId,
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
          const rid = notificationRoomId(payload);
          if (!rid || useAuth.getState().status !== 'authed' || !useChat.getState().ready) return;
          useUI.getState().setModule('messages');
          void useChat
            .getState()
            .openRoom(rid)
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
