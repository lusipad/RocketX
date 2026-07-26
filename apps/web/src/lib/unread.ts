/**
 * 未读提醒的口径只此一份。
 *
 * 此前标题栏、任务栏角标、托盘闪烁、侧边栏角标、工作台各写各的 reduce，
 * 只有侧边栏记得跳过已隐藏的会话。于是隐藏一个有未读的讨论之后：列表里
 * 找不到它、托盘提示不提它，任务栏却一直顶着红标——用户没有任何办法清掉
 * 一个看不见的未读（issue #134）。
 *
 * 加新的提醒出口时用这里的函数，别再手写一遍条件。
 */

export type UnreadSubscription = {
  open?: boolean;
  disableNotifications?: boolean;
  unread?: number;
  alert?: boolean;
};

type UnreadMap = Readonly<Record<string, UnreadSubscription>>;

/**
 * 隐藏的会话不进任何提醒：用户点不到它，也就清不掉它。
 * 免打扰是用户明确表达过「别烦我」，同样不计。
 */
export function countsTowardUnread(subscription: UnreadSubscription): boolean {
  return subscription.open !== false && !subscription.disableNotifications;
}

/** 用于数字角标：标题栏、任务栏、侧边栏、工作台。 */
export function totalUnread(subscriptions: UnreadMap): number {
  let total = 0;
  for (const subscription of Object.values(subscriptions)) {
    if (countsTowardUnread(subscription)) total += subscription.unread || 0;
  }
  return total;
}

/**
 * 用于红点/闪烁这类「有没有」的提示。
 * 和 totalUnread 的差别是 alert：没有具体条数但需要引起注意的会话也算。
 */
export function hasUnreadAttention(subscriptions: UnreadMap): boolean {
  return Object.values(subscriptions).some(
    (subscription) =>
      countsTowardUnread(subscription) &&
      ((subscription.unread ?? 0) > 0 || subscription.alert === true),
  );
}
