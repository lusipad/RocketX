import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

export interface ButlerPtyOutputPayload {
  terminalId: string;
  data: string;
  seq: number;
}

export interface ButlerPtyExitPayload {
  terminalId: string;
  exitCode: number | null;
}

export function listenDesktopEvent<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, handler);
}

export function listenButlerPtyOutput(
  handler: (payload: ButlerPtyOutputPayload) => void,
): Promise<UnlistenFn> {
  return listen<ButlerPtyOutputPayload>('butler-pty-output', (event) => handler(event.payload));
}

export function listenButlerPtyExit(
  handler: (payload: ButlerPtyExitPayload) => void,
): Promise<UnlistenFn> {
  return listen<ButlerPtyExitPayload>('butler-pty-exit', (event) => handler(event.payload));
}
