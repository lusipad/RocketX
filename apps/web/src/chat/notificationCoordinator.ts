import { tsMs, type RcMessage, type RcRoom, type RcSubscription, type RcUser } from '@rcx/rc-client';
import { routeNotification, type NotificationAggregationInput, type NotificationAggregationStateV1 } from '../lib/notificationAggregation';
import { focusAggregationConfig } from '../stores/focus';
import { stripAgentSessionMarker } from '../agent/card';
import {
  conversationIsActivelyViewed,
  messageIsFromCurrentUser,
  messageIsNotificationCandidate,
  messageMentionsCurrentUser,
  notificationAttentionPolicy,
  threadReplyShouldNotify,
} from './notificationPolicy';

export interface ChatNotificationSnapshot {
  subscriptions: Record<string, RcSubscription>;
  rooms: Record<string, RcRoom>;
  messages: Record<string, RcMessage[]>;
  activeRid: string | null;
}

export interface NotificationCoordinatorDeps {
  loadAuth: () => { userId: string } | null;
  currentUser: () => Pick<RcUser, '_id' | 'username'> | null | undefined;
  consumeExpectedAgentReply: (rid: string, text: string) => boolean;
  getPrefs: () => {
    desktopNotifications: 'all' | 'mentions' | 'nothing';
    muteFocusedConversations?: boolean;
    notificationsSoundVolume: number;
  };
  taskbarFlash: () => boolean;
  focus: () => {
    session: unknown;
    noteAggregated: (input: NotificationAggregationInput) => void;
    notePassthrough: (input: NotificationAggregationInput) => void;
  };
  aggregation: () => {
    state: NotificationAggregationStateV1 | null;
    recordCandidate: (phase: NonNullable<NotificationAggregationStateV1['metrics']['activePhase']>, timestamp: number) => void;
    recordPopup: (phase: NonNullable<NotificationAggregationStateV1['metrics']['activePhase']>, timestamp: number, kind: 'passthrough') => void;
    addAggregate: (input: NotificationAggregationInput) => void;
  };
  fetchMessage: (mid: string) => Promise<RcMessage>;
  flashTaskbar: () => Promise<void> | void;
  showDesktopNotification: (options: {
    title: string;
    body: string;
    tag: string;
    rid: string;
    mid: string;
    onClick: () => void;
  }) => Promise<boolean>;
  playNotificationSound: (volume: number) => void;
  navigateToMessage: (mid: string, rid: string) => void;
  documentHasFocus: () => boolean;
}

const notifiedMids = new Set<string>();
const locallySentMids = new Set<string>();

export function rememberLocalMessage(mid: string): void {
  locallySentMids.add(mid);
  if (locallySentMids.size <= 800) return;
  for (const id of locallySentMids) {
    locallySentMids.delete(id);
    if (locallySentMids.size <= 400) break;
  }
}

function rememberNotifiedMessage(mid: string): boolean {
  if (notifiedMids.has(mid)) return false;
  notifiedMids.add(mid);
  if (notifiedMids.size > 800) {
    for (const id of notifiedMids) {
      notifiedMids.delete(id);
      if (notifiedMids.size <= 400) break;
    }
  }
  return true;
}

export async function notifyChatMessage(
  msg: RcMessage,
  rid: string,
  snapshot: ChatNotificationSnapshot,
  deps: NotificationCoordinatorDeps,
): Promise<void> {
  const auth = deps.loadAuth();
  if (!auth || !messageIsNotificationCandidate(msg)) return;
  const currentUser = deps.currentUser();
  const expectedAgentReply = deps.consumeExpectedAgentReply(rid, msg.msg ?? '');
  if (locallySentMids.has(msg._id) || messageIsFromCurrentUser(msg.u, auth.userId, currentUser)) return;
  const subscription = snapshot.subscriptions[rid];
  if (!subscription || !rememberNotifiedMessage(msg._id) || expectedAgentReply) return;

  let threadRoot = msg.tmid
    ? snapshot.messages[rid]?.find((message) => message._id === msg.tmid)
    : undefined;
  if (msg.tmid && !threadReplyShouldNotify(msg, threadRoot, currentUser)) {
    if (threadRoot) return;
    try {
      threadRoot = await deps.fetchMessage(msg.tmid);
    } catch {
      return;
    }
    if (!threadReplyShouldNotify(msg, threadRoot, currentUser)) return;
  }

  const mentioned = messageMentionsCurrentUser(msg, currentUser);
  const prefs = deps.getPrefs();
  const roomType = subscription.t ?? snapshot.rooms[rid]?.t;
  const dmSize = snapshot.rooms[rid]?.uids?.length ?? snapshot.rooms[rid]?.usersCount;
  const isGroupish = roomType !== 'd' || (dmSize !== undefined && dmSize > 2);
  const focused = conversationIsActivelyViewed(snapshot.activeRid, rid, deps.documentHasFocus());
  const policy = notificationAttentionPolicy({
    subscribed: true,
    muted: !!subscription.disableNotifications,
    mentioned,
    focused,
    isGroupish,
    desktopNotifications: prefs.desktopNotifications,
    muteFocusedConversations: prefs.muteFocusedConversations ?? true,
    taskbarFlash: deps.taskbarFlash(),
  });
  const focus = deps.focus();
  if (policy.flashTaskbar && !focus.session) void deps.flashTaskbar();
  if (!policy.showDesktopNotification) return;

  const title = msg.u.name || msg.u.username;
  const body = stripAgentSessionMarker(msg.msg) || (msg.attachments?.length ? '[卡片/文件]' : '');
  const directMention = !!currentUser && !!msg.mentions?.some((mention) =>
    mention._id === currentUser._id || mention.username === currentUser.username,
  );
  const broadcastMention = /@(all|here)\b/i.test(msg.msg ?? '');
  const aggregation = deps.aggregation();
  const aggregationState = aggregation.state;
  const candidate: NotificationAggregationInput = {
    id: msg._id,
    roomId: rid,
    roomName: subscription.fname || subscription.name || snapshot.rooms[rid]?.fname || snapshot.rooms[rid]?.name || '会话',
    senderName: title,
    text: body,
    timestamp: tsMs(msg.ts),
    directMessage: !isGroupish,
    directMention,
    broadcastMention,
    priority: /(^|\s|[\[【])P1(?=$|\s|[\]】:：])/i.test(body) ? 1 : undefined,
  };
  const routeConfig = focus.session
    ? focusAggregationConfig(aggregationState?.config ?? null)
    : aggregationState?.config;
  const phase = aggregationState?.metrics.activePhase;
  if (phase) aggregation.recordCandidate(phase, candidate.timestamp);
  if (aggregationState && routeConfig && routeNotification(candidate, routeConfig).mode === 'aggregate') {
    aggregation.addAggregate(candidate);
    focus.noteAggregated(candidate);
    return;
  }
  focus.notePassthrough(candidate);
  void deps.showDesktopNotification({
    title,
    body: body.slice(0, 120),
    tag: msg._id,
    rid,
    mid: msg._id,
    onClick: () => deps.navigateToMessage(msg._id, rid),
  }).then((shown) => {
    if (shown) deps.playNotificationSound(prefs.notificationsSoundVolume);
    if (shown && phase) aggregation.recordPopup(phase, Date.now(), 'passthrough');
  }).catch(() => {});
}
