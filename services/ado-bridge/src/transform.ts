import type { RcMessageAttachment } from '@rcx/rc-client';

/** Azure DevOps Service Hooks 通用载荷（所有事件都带 message/detailedMessage） */
export interface AdoEvent {
  eventType?: string;
  message?: { text?: string; html?: string; markdown?: string };
  detailedMessage?: { text?: string; html?: string; markdown?: string };
  resource?: Record<string, any>;
}

interface EventStyle {
  emoji: string;
  color: string;
  label: string;
}

const COLORS = {
  blue: '#3370ff',
  green: '#34c724',
  orange: '#ff8800',
  purple: '#7f3bf5',
  red: '#f54a45',
  gray: '#8f959e',
};

const EVENT_STYLES: Record<string, EventStyle> = {
  'workitem.created': { emoji: '🆕', color: COLORS.blue, label: '工作项已创建' },
  'workitem.updated': { emoji: '✏️', color: COLORS.orange, label: '工作项已更新' },
  'workitem.commented': { emoji: '💬', color: COLORS.blue, label: '工作项新评论' },
  'workitem.deleted': { emoji: '🗑️', color: COLORS.gray, label: '工作项已删除' },
  'workitem.restored': { emoji: '♻️', color: COLORS.green, label: '工作项已恢复' },
  'git.push': { emoji: '📦', color: COLORS.blue, label: '代码推送' },
  'git.pullrequest.created': { emoji: '🔀', color: COLORS.purple, label: 'PR 已创建' },
  'git.pullrequest.updated': { emoji: '🔄', color: COLORS.purple, label: 'PR 已更新' },
  'git.pullrequest.merged': { emoji: '✅', color: COLORS.green, label: 'PR 已合并' },
  'ms.vss-code.git-pullrequest-comment-event': {
    emoji: '💬',
    color: COLORS.purple,
    label: 'PR 新评论',
  },
  'build.complete': { emoji: '🏗️', color: COLORS.green, label: '构建完成' },
  'ms.vss-release.release-created-event': { emoji: '🚀', color: COLORS.blue, label: '发布已创建' },
  'ms.vss-release.deployment-completed-event': {
    emoji: '🚀',
    color: COLORS.green,
    label: '部署完成',
  },
};

/** 从事件里尽力找出可点击的 Web 链接 */
function findLink(event: AdoEvent): string | undefined {
  const r = event.resource;
  if (!r) return undefined;
  return (
    r._links?.web?.href ??
    r.pullRequest?._links?.web?.href ??
    (typeof r.url === 'string' && r.url.includes('_apis') ? undefined : r.url)
  );
}

/** 构建/部署失败时把颜色改红 */
function adjustColor(event: AdoEvent, style: EventStyle): string {
  const result: string | undefined =
    event.resource?.result ?? event.resource?.deployment?.deploymentStatus;
  if (typeof result === 'string' && /fail|reject|cancel/i.test(result)) return COLORS.red;
  return style.color;
}

export interface CardMessage {
  text: string;
  attachments: RcMessageAttachment[];
}

/**
 * 把任意 ADO Service Hooks 事件转成 Rocket.Chat 消息卡片。
 * 未识别的 eventType 也能处理（用 ADO 自带的 message 文本兜底）。
 */
export function transformAdoEvent(event: AdoEvent): CardMessage | null {
  const title = event.message?.text ?? event.message?.markdown;
  if (!event.eventType && !title) return null;

  const style = EVENT_STYLES[event.eventType ?? ''] ?? {
    emoji: '🔔',
    color: COLORS.gray,
    label: event.eventType ?? 'DevOps 事件',
  };

  const detail = event.detailedMessage?.markdown ?? event.detailedMessage?.text;
  const link = findLink(event);

  const attachment: RcMessageAttachment = {
    color: adjustColor(event, style),
    title: `${style.emoji} ${style.label}`,
    title_link: link,
    text: detail && detail !== title ? detail : (title ?? ''),
    collapsed: false,
  };

  return { text: title ?? style.label, attachments: [attachment] };
}
