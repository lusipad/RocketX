import { useEffect, useRef } from 'react';
import { isTauri } from '../lib/http';
import { takePendingNotificationNavigation } from '../platform/desktopCommands';
import { listenDesktopEvent } from '../platform/desktopEvents';
import {
  NOTIFICATION_OPEN_ROOM_EVENT,
  notificationDestination,
  notificationTarget,
  queueNotificationTarget,
  takeQueuedNotificationTarget,
  type NotificationNavigationTarget,
} from '../lib/notificationNavigation';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

export default function NotificationNavigationBridge() {
  const authStatus = useAuth((s) => s.status);
  const chatReady = useChat((s) => s.ready);
  const pendingTargetsRef = useRef<NotificationNavigationTarget[]>([]);
  const handlingRef = useRef(false);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let pendingRead: Promise<void> | null = null;

    const openTarget = async (target: NotificationNavigationTarget) => {
      if (notificationDestination(target) === 'butler-view') {
        useUI.getState().setModule('butler-view');
        return;
      }
      useUI.getState().setModule('messages');
      await useChat.getState().jumpToMessage(target.mid, target.rid);
    };

    const flushPending = () => {
      if (handlingRef.current) return;
      const next = takeQueuedNotificationTarget(
        pendingTargetsRef.current,
        useAuth.getState().status,
        useChat.getState().ready,
      );
      pendingTargetsRef.current = next.queue;
      if (!next.target) return;
      handlingRef.current = true;
      void openTarget(next.target)
        .catch((err) => toast.error(err, '无法打开通知对应的会话'))
        .finally(() => {
          handlingRef.current = false;
          flushPending();
        });
    };

    const enqueuePayload = (payload: unknown) => {
      const target = notificationTarget(payload);
      if (!target) return;
      pendingTargetsRef.current = queueNotificationTarget(pendingTargetsRef.current, target);
      flushPending();
    };

    const readPendingFromDesktop = () => {
      if (pendingRead) return pendingRead;
      const task = (async () => {
        while (!cancelled) {
          const payload = await takePendingNotificationNavigation();
          if (payload == null) return;
          enqueuePayload(payload);
        }
      })()
        .catch(() => {})
        .finally(() => {
          if (pendingRead === task) pendingRead = null;
        });
      pendingRead = task;
      return task;
    };

    refreshRef.current = () => {
      flushPending();
      void readPendingFromDesktop();
    };

    void readPendingFromDesktop();
    void listenDesktopEvent<unknown>(NOTIFICATION_OPEN_ROOM_EVENT, ({ payload }) => {
          enqueuePayload(payload);
          void readPendingFromDesktop();
        })
      .then((release) => {
        if (cancelled) release();
        else unlisten = release;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      refreshRef.current = null;
      pendingTargetsRef.current = [];
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    refreshRef.current?.();
  }, [authStatus, chatReady]);

  return null;
}
