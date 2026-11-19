import type { RcMessageAttachment } from '@rcx/rc-client';

/** Azure DevOps Service Hooks 通用载荷（所有事件都带 message/detailedMessage） */
export interface AdoEvent {
  id?: string;
  notificationId?: number;
  eventType?: string;
  createdDate?: string;
  message?: { text?: string; html?: string; markdown?: string };
  detailedMessage?: { text?: string; html?: string; markdown?: string };
  resource?: Record<string, any>;
  resourceContainers?: Record<string, any>;
}

export interface AdoStructuredEventMetadata {
  dedupeKey: string;
  source: 'ado_webhook';
  eventType: string;
  resourceKey: string;
  resourceVersion: number;
  project?: string;
  repo?: string;
  branch?: string;
  commitSha?: string;
  workItemId?: number;
  prId?: number;
  buildId?: number;
  result?: string;
  webUrl?: string;
  summary: string;
  occurredAt: number;
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

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * 提取 ADO Service Hooks 事件的结构化关联元数据，供管家反馈回路去重、水位抑制与关联卡片使用。
 */
export function extractAdoStructuredEvent(event: AdoEvent): AdoStructuredEventMetadata | null {
  const eventType = event.eventType?.trim();
  const title = event.message?.text ?? event.message?.markdown ?? '';
  if (!eventType && !title) return null;

  const r = event.resource ?? {};
  const pr = r.pullRequest ?? r;
  const project: string | undefined =
    r.project?.name ??
    pr.repository?.project?.name ??
    r.repository?.project?.name ??
    r.fields?.['System.TeamProject']?.newValue ??
    r.fields?.['System.TeamProject'] ??
    r.revision?.fields?.['System.TeamProject'];
  const repo: string | undefined = pr.repository?.name ?? r.repository?.name;
  const branch: string | undefined =
    pr.sourceRefName ??
    r.sourceBranch ??
    r.refUpdates?.[0]?.name;
  const commitSha: string | undefined =
    pr.lastMergeSourceCommit?.commitId ??
    r.sourceVersion ??
    r.refUpdates?.[0]?.newObjectId;

  const workItemId =
    eventType?.startsWith('workitem.')
      ? toPositiveNumber(r.workItemId ?? r.revision?.id ?? r.id)
      : toPositiveNumber(r.workItemId);
  const prId =
    eventType?.includes('pullrequest')
      ? toPositiveNumber(r.pullRequestId ?? pr.pullRequestId ?? pr.id)
      : undefined;
  const buildId =
    eventType === 'build.complete' ? toPositiveNumber(r.id ?? r.buildNumber) : undefined;

  const occurredAt = event.createdDate ? Date.parse(event.createdDate) || Date.now() : Date.now();
  const resourceVersion =
    toPositiveNumber(r.rev ?? r.revision?.rev ?? buildId ?? event.notificationId) ?? occurredAt;

  let resourceKey = `ado:${eventType ?? 'unknown'}`;
  if (workItemId) {
    resourceKey = `ado:workitem:${project ?? 'default'}:${workItemId}`;
  } else if (prId) {
    resourceKey = `ado:pr:${project ?? 'default'}:${repo ?? 'default'}:${prId}`;
  } else if (buildId) {
    const defId = r.definition?.id ?? r.definition?.name ?? 'pipeline';
    resourceKey = `ado:build:${project ?? 'default'}:${defId}:${ branch ?? 'default' }`;
  } else if (repo && branch) {
    resourceKey = `ado:branch:${project ?? 'default'}:${repo}:${branch}`;
  }

  const dedupeKey =
    event.id?.trim() ||
    `${resourceKey}:${eventType ?? 'event'}:${resourceVersion}:${commitSha ?? ''}`;

  return {
    dedupeKey,
    source: 'ado_webhook',
    eventType: eventType ?? 'unknown',
    resourceKey,
    resourceVersion,
    project,
    repo,
    branch,
    commitSha,
    workItemId,
    prId,
    buildId,
    result: typeof r.result === 'string' ? r.result : undefined,
    webUrl: findLink(event),
    summary: (event.detailedMessage?.text ?? title ?? eventType ?? 'ADO 事件').trim(),
    occurredAt,
  };
}

export interface CardMessage {
  text: string;
  attachments: RcMessageAttachment[];
  structuredEvent?: AdoStructuredEventMetadata;
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

  const structuredEvent = extractAdoStructuredEvent(event) ?? undefined;
  return { text: title ?? style.label, attachments: [attachment], structuredEvent };
}
