export { readWorkRuntimeEvents } from './desktopCommands';

/** This is an account database cursor, not a provider-native replay cursor. */
export interface WorkRuntimeEvent {
  sequence: number;
  todoId: string;
  sessionId: string;
  actionId: string | null;
  eventType: string;
  connectionId: string;
  connectionSequence: number;
  nativeThreadId: string;
  nativeTurnId: string | null;
  requirementsVersion: number;
  contentVersion: number;
  payload: unknown;
  receivedAt: number;
}

export interface WorkRuntimeEventsPage {
  events: WorkRuntimeEvent[];
  cursor: number;
  hasMore: boolean;
}

