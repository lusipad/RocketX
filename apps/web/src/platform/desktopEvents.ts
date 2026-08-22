import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

export function listenDesktopEvent<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, handler);
}
