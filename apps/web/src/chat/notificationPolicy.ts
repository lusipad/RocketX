import type { RcMessage, RcUser } from '@rcx/rc-client';

export function messageIsFromCurrentUser(
  sender: Pick<RcMessage['u'], '_id' | 'username'>,
  authUserId: string,
  currentUser?: Pick<RcUser, '_id' | 'username'> | null,
): boolean {
  if (sender._id === authUserId || sender._id === currentUser?._id) return true;
  return !!currentUser?.username && sender.username.toLocaleLowerCase() === currentUser.username.toLocaleLowerCase();
}

export function messageIsNotificationCandidate(
  message: Pick<RcMessage, 't' | 'attachments'>,
): boolean {
  if (message.t) return false;
  return !message.attachments?.some((attachment) => attachment.type === 'removed-file');
}

export function messageMentionsCurrentUser(
  message: Pick<RcMessage, 'msg' | 'mentions'>,
  currentUser: Pick<RcUser, '_id' | 'username'> | null | undefined,
): boolean {
  if (!currentUser) return false;
  const username = currentUser.username.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return !!message.mentions?.some(
    (mention) => mention._id === currentUser._id || mention.username === currentUser.username,
  ) || new RegExp(`@(${username}|all|here)\\b`, 'i').test(message.msg ?? '');
}

export function threadReplyShouldNotify(
  message: Pick<RcMessage, 'tmid' | 'msg' | 'mentions'>,
  root: Pick<RcMessage, 'u' | 'replies' | 'tcount'> | undefined,
  currentUser: Pick<RcUser, '_id' | 'username'> | null | undefined,
): boolean {
  if (!message.tmid) return true;
  if (messageMentionsCurrentUser(message, currentUser)) return true;
  if (!root || !currentUser) return false;
  if (root.replies?.includes(currentUser._id)) return true;
  return !root.tcount && root.u._id === currentUser._id;
}

export function notificationAttentionPolicy(input: {
  subscribed: boolean;
  muted: boolean;
  mentioned: boolean;
  focused: boolean;
  isGroupish: boolean;
  desktopNotifications: 'all' | 'mentions' | 'nothing';
  muteFocusedConversations: boolean;
  taskbarFlash: boolean;
}): { flashTaskbar: boolean; showDesktopNotification: boolean } {
  if (!input.subscribed) return { flashTaskbar: false, showDesktopNotification: false };
  const muted = input.muted && !input.mentioned;
  return {
    flashTaskbar: input.taskbarFlash && !muted && !input.focused,
    showDesktopNotification:
      !muted &&
      input.desktopNotifications !== 'nothing' &&
      (input.desktopNotifications !== 'mentions' || !input.isGroupish || input.mentioned) &&
      (!input.focused || !input.muteFocusedConversations),
  };
}

export function conversationIsActivelyViewed(
  activeRid: string | null,
  rid: string,
  documentHasFocus: boolean,
): boolean {
  return activeRid === rid && documentHasFocus;
}
