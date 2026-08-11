import type { MessageScrollEntry } from './messageScrollTransaction';

const MAX_MESSAGE_SCROLL_DIAGNOSTICS = 200;

export type MessageScrollDiagnosticPhase =
  | 'history'
  | 'layout'
  | 'frame'
  | 'resize'
  | 'scroll';

export interface MessageScrollDiagnosticInput {
  rid: string;
  generation: number;
  entry: MessageScrollEntry;
  phase: MessageScrollDiagnosticPhase;
  historyLoaded: boolean;
  messageCount: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  bottomGap?: number;
  stickToBottom: boolean;
  userIntent: boolean;
  jumpVisible: boolean;
}

export interface MessageScrollDiagnosticRecord {
  at: string;
  room: string;
  generation: number;
  entry: MessageScrollEntry;
  phase: MessageScrollDiagnosticPhase;
  historyLoaded: boolean;
  messageCount: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  bottomGap?: number;
  stickToBottom: boolean;
  userIntent: boolean;
  jumpVisible: boolean;
}

const records: MessageScrollDiagnosticRecord[] = [];

function hashRoomId(rid: string): string {
  let hash = 2166136261;
  for (let index = 0; index < rid.length; index += 1) {
    hash ^= rid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `room#${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function toMetric(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * 100) / 100;
}

export function clearMessageScrollDiagnostics(): void {
  records.length = 0;
}

export function getMessageScrollDiagnostics(): MessageScrollDiagnosticRecord[] {
  return records.slice();
}

export function recordMessageScrollDiagnostic(
  input: MessageScrollDiagnosticInput,
): MessageScrollDiagnosticRecord {
  const record: MessageScrollDiagnosticRecord = {
    at: new Date().toISOString(),
    room: hashRoomId(input.rid),
    generation: input.generation,
    entry: input.entry,
    phase: input.phase,
    historyLoaded: input.historyLoaded,
    messageCount: input.messageCount,
    ...(input.scrollTop === undefined ? {} : { scrollTop: toMetric(input.scrollTop) }),
    ...(input.scrollHeight === undefined ? {} : { scrollHeight: toMetric(input.scrollHeight) }),
    ...(input.clientHeight === undefined ? {} : { clientHeight: toMetric(input.clientHeight) }),
    ...(input.bottomGap === undefined ? {} : { bottomGap: toMetric(input.bottomGap) }),
    stickToBottom: input.stickToBottom,
    userIntent: input.userIntent,
    jumpVisible: input.jumpVisible,
  };
  records.push(record);
  if (records.length > MAX_MESSAGE_SCROLL_DIAGNOSTICS) {
    records.splice(0, records.length - MAX_MESSAGE_SCROLL_DIAGNOSTICS);
  }
  return record;
}

export function formatMessageScrollDiagnostics(
  input: readonly MessageScrollDiagnosticRecord[] = records,
): string {
  if (input.length === 0) return '(none)';
  return input
    .map((record) => {
      const metrics = [
        `historyLoaded=${record.historyLoaded}`,
        `messageCount=${record.messageCount}`,
        `stickToBottom=${record.stickToBottom}`,
        `userIntent=${record.userIntent}`,
        `jumpVisible=${record.jumpVisible}`,
        `scrollTop=${record.scrollTop ?? '?'}`,
        `scrollHeight=${record.scrollHeight ?? '?'}`,
        `clientHeight=${record.clientHeight ?? '?'}`,
        `bottomGap=${record.bottomGap ?? '?'}`,
      ].join(' ');
      return `${record.at} ${record.room} generation=${record.generation} entry=${record.entry} phase=${record.phase} ${metrics}`;
    })
    .join('\n');
}
