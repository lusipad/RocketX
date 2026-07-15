import { isTauri } from './http';

type Timer = ReturnType<typeof setInterval>;

export type TrayFlasher = {
  setFlashing: (flashing: boolean) => Promise<void>;
  stop: () => Promise<void>;
};

export function hasTrayAttention(
  subscriptions: Readonly<
    Record<string, { disableNotifications?: boolean; unread?: number; alert?: boolean }>
  >,
): boolean {
  return Object.values(subscriptions).some(
    (subscription) =>
      !subscription.disableNotifications &&
      ((subscription.unread ?? 0) > 0 || subscription.alert === true),
  );
}

export function createTrayFlasher(
  setNormalIcon: (normal: boolean) => Promise<void>,
  schedule: (callback: () => void, delay: number) => Timer = (callback, delay) =>
    globalThis.setInterval(callback, delay),
  cancel: (timer: Timer) => void = (timer) => globalThis.clearInterval(timer),
): TrayFlasher {
  let flashing = false;
  let normal = true;
  let timer: Timer | undefined;
  let revision = 0;
  let tail = Promise.resolve();

  const enqueue = (nextNormal: boolean, current: number) => {
    const request = tail.then(async () => {
      if (revision !== current) return;
      await setNormalIcon(nextNormal);
    });
    tail = request.catch(() => undefined);
    return request;
  };

  const cancelTimer = () => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const stop = () => {
    flashing = false;
    const current = ++revision;
    cancelTimer();
    normal = true;
    return enqueue(true, current);
  };

  const setFlashing = (nextFlashing: boolean) => {
    if (nextFlashing === flashing) return tail;
    if (!nextFlashing) return stop();

    flashing = true;
    const current = ++revision;
    cancelTimer();
    normal = true;

    timer = schedule(() => {
      normal = !normal;
      void enqueue(normal, current).catch(() => undefined);
    }, 700);
    return tail;
  };

  return { setFlashing, stop };
}

const trayFlasher = createTrayFlasher(async (normal) => {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_icon_normal', { normal });
  } catch {
    /* 托盘提醒失败不应打断聊天 */
  }
});

/** Windows 托盘在非免打扰未读存在时闪烁，清零后恢复正常图标。 */
export async function setTrayAttention(hasUnread: boolean): Promise<void> {
  if (!isTauri || !navigator.userAgent.includes('Windows')) return;
  await trayFlasher.setFlashing(hasUnread);
}

/** 停止当前闪烁；未在闪烁时保持幂等，避免 subscriptions 更新重复 IPC。 */
export async function clearTrayAttention(): Promise<void> {
  if (!isTauri || !navigator.userAgent.includes('Windows')) return;
  await trayFlasher.setFlashing(false);
}

/** 页面初始化或 reload 前无条件写入正常图标，修复上一 JS 上下文遗留的透明帧。 */
export async function restoreTrayAttention(): Promise<void> {
  if (!isTauri || !navigator.userAgent.includes('Windows')) return;
  await trayFlasher.stop();
}
