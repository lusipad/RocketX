import { tsMs, type RcMessage, type RoomType } from '@rcx/rc-client';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';

export const BUTLER_PROPOSAL_HANDLED_KEY = 'rcx-butler-v1:proposal-handled';

const MAX_HANDLED_REFS = 200;
const MAX_RECENT_SENT_MESSAGES = 50;
const MAX_MESSAGE_TEXT_LENGTH = 280;
const LOOKBACK_MS = 24 * 60 * 60 * 1_000;

export interface ButlerProposalHandledStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ButlerOutboxRoom {
  name?: string;
  fname?: string;
  t?: RoomType;
}

export interface ButlerOutboxMessageSource {
  messages: Readonly<Record<string, readonly RcMessage[]>>;
  subscriptions: Readonly<Record<string, ButlerOutboxRoom | undefined>>;
  rooms: Readonly<Record<string, ButlerOutboxRoom | undefined>>;
}

export interface RecentSentMessage {
  ref: `msg:${string}`;
  rid: string;
  roomName: string;
  peer: string;
  text: string;
  at: string;
}

export type ButlerRecentSentMessage = RecentSentMessage;

export interface ButlerOutboxDependencies {
  getMessageSource?: () => ButlerOutboxMessageSource;
  getCurrentUserId?: () => string | null | undefined;
  storage?: ButlerProposalHandledStorage;
  now?: () => number;
}

function browserStorage(): ButlerProposalHandledStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function isMessageRef(value: unknown): value is `msg:${string}` {
  return typeof value === 'string' && /^msg:.+/.test(value);
}

export function listProposalHandledRefs(
  storage: ButlerProposalHandledStorage | undefined = browserStorage(),
): `msg:${string}`[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(BUTLER_PROPOSAL_HANDLED_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isMessageRef))].slice(-MAX_HANDLED_REFS);
  } catch {
    return [];
  }
}

export function markProposalHandled(
  ref: string,
  storage: ButlerProposalHandledStorage | undefined = browserStorage(),
): boolean {
  if (!isMessageRef(ref) || !storage) return false;
  const refs = [...listProposalHandledRefs(storage).filter((item) => item !== ref), ref]
    .slice(-MAX_HANDLED_REFS);
  storage.setItem(BUTLER_PROPOSAL_HANDLED_KEY, JSON.stringify(refs));
  return true;
}

export function isProposalHandled(
  ref: string,
  storage: ButlerProposalHandledStorage | undefined = browserStorage(),
): boolean {
  return isMessageRef(ref) && listProposalHandledRefs(storage).includes(ref);
}

function defaultMessageSource(): ButlerOutboxMessageSource {
  const { messages, subscriptions, rooms } = useChat.getState();
  return { messages, subscriptions, rooms };
}

function roomLabel(source: ButlerOutboxMessageSource, rid: string): string {
  const subscription = source.subscriptions[rid];
  const room = source.rooms[rid];
  return subscription?.fname || subscription?.name || room?.fname || room?.name || rid;
}

function windowStart(lastRoundsAt: string | null, now: number): number {
  const parsed = lastRoundsAt ? new Date(lastRoundsAt).getTime() : Number.NaN;
  return Math.max(Number.isFinite(parsed) ? parsed : 0, now - LOOKBACK_MS);
}

function scannableText(message: RcMessage): string | null {
  const text = message.msg.trim();
  if (!text || message.t || /^\s*\//.test(message.msg)) return null;
  if (message.msg.includes('<!--rocketx-agent:')) return null;
  return text.slice(0, MAX_MESSAGE_TEXT_LENGTH);
}

export function collectRecentSentMessages(
  lastRoundsAt: string | null,
  dependencies: ButlerOutboxDependencies = {},
): RecentSentMessage[] {
  const now = dependencies.now?.() ?? Date.now();
  const currentUserId = dependencies.getCurrentUserId
    ? dependencies.getCurrentUserId()
    : useAuth.getState().user?._id;
  if (!currentUserId || !Number.isFinite(now)) return [];

  const source = dependencies.getMessageSource?.() ?? defaultMessageSource();
  const handled = new Set(listProposalHandledRefs(dependencies.storage));
  const start = windowStart(lastRoundsAt, now);
  const candidates = Object.values(source.messages)
    .flatMap((messages) => messages)
    .map((message) => ({ message, timestamp: tsMs(message.ts) }))
    .filter(({ message, timestamp }) => (
      message.u._id === currentUserId
      && Number.isFinite(timestamp)
      && timestamp >= start
      && timestamp <= now
    ))
    .sort((left, right) => right.timestamp - left.timestamp);

  const refs = new Set<string>();
  const collected: RecentSentMessage[] = [];
  for (const { message, timestamp } of candidates) {
    const ref = `msg:${message._id}` as const;
    if (refs.has(ref) || handled.has(ref)) continue;
    const text = scannableText(message);
    if (!text) continue;
    refs.add(ref);
    const roomName = roomLabel(source, message.rid);
    collected.push({
      ref,
      rid: message.rid,
      roomName,
      peer: roomName,
      text,
      at: new Date(timestamp).toISOString(),
    });
    if (collected.length === MAX_RECENT_SENT_MESSAGES) break;
  }
  return collected;
}
