import { tsMs, type RcMessage, type RcRoom } from '@rcx/rc-client';
import { buildUiLanguageInstruction, getLocale, t } from '../i18n';
import { stripQuotePrefix } from '../lib/messageText';
import { parseAdoUrl } from '../lib/ado';
import { stripAgentSessionMarker } from './card';

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_CONTEXT_CHARS = 100_000;

export function agentTurnInput(text: string, imagePaths: readonly string[]) {
  return [
    { type: 'text' as const, text, text_elements: [] },
    ...imagePaths.map((path) => ({ type: 'localImage' as const, path })),
  ];
}

export function buildAgentDeveloperInstructions(input: {
  workItem?: { id: number; project?: string; title: string };
  proposedBranch?: string;
  baseBranch?: string;
}): string {
  return [
    t('agent.devInstructions.untrusted'),
    buildUiLanguageInstruction(),
    input.workItem
      ? t('agent.devInstructions.workItem', {
          id: input.workItem.id,
          projectPart: input.workItem.project
            ? (getLocale() === 'zh-CN' ? `（${input.workItem.project}）` : ` (${input.workItem.project})`)
            : '',
          title: input.workItem.title,
        })
      : '',
    input.proposedBranch
      ? t('agent.devInstructions.branch', {
          baseBranch: input.baseBranch || t('agent.devInstructions.currentBranchFallback'),
          proposedBranch: input.proposedBranch,
        })
      : '',
  ].filter(Boolean).join('\n');
}

export function agentInstruction(text: string): string | null {
  const match = /^\s*(?:@ai(?:\s+|$)|@codex(?:\s+|$)|\$codex(?:\s+|$)|\$(?=\s))([\s\S]*)$/i.exec(
    stripQuotePrefix(text),
  );
  return match ? match[1].trim() : null;
}

export function workItemIdFromRoomTitle(title: string): number | undefined {
  const id = /(?:^|\s)#(\d+)\b/.exec(title)?.[1];
  return id ? Number(id) : undefined;
}

export function agentMessageInstruction(
  message: RcMessage,
  botUsername = 'ai',
  allowLiteralAi = false,
): string | null {
  const stripped = stripQuotePrefix(message.msg);
  if (!/^\s*@ai(?:\s+|$)/i.test(stripped)) return agentInstruction(message.msg);
  if (message.editedAt || message.u.username.toLocaleLowerCase() === botUsername.toLocaleLowerCase()) return null;
  if (allowLiteralAi) return agentInstruction(message.msg);
  const mentioned = message.mentions?.some(
    (mention) => mention.type !== 'team' && mention.username.toLocaleLowerCase() === botUsername.toLocaleLowerCase(),
  );
  return mentioned ? agentInstruction(message.msg) : null;
}

export interface AgentAttachmentSource {
  messageId: string;
  name: string;
  path: string;
  image: boolean;
}

export interface AgentLinkedWorkItem {
  id: number;
  title?: string;
  type?: string;
  state?: string;
  project?: string;
  webUrl: string;
}

interface KnownWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  project: string;
  webUrl: string;
}

export function quoteMessageIds(message: RcMessage): string[] {
  const links = [
    ...(message.attachments ?? []).map((attachment) => attachment.message_link),
    ...Array.from(message.msg.matchAll(/\[ \]\(([^)]+)\)/g), (match) => match[1]),
  ];
  return links
    .map((link) => link?.match(/[?&]msg=([^&]+)/)?.[1])
    .filter((value): value is string => !!value)
    .map((value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    });
}

export function selectAgentContextMessages(
  command: RcMessage,
  messages: readonly RcMessage[],
): RcMessage[] {
  const roots = new Set([command.tmid ?? command._id]);
  for (const quotedId of quoteMessageIds(command)) {
    const quoted = messages.find((message) => message._id === quotedId);
    roots.add(quoted?.tmid ?? quotedId);
  }
  return messages
    .filter((message) => roots.has(message._id) || (!!message.tmid && roots.has(message.tmid)))
    .sort((left, right) => tsMs(left.ts) - tsMs(right.ts));
}

function attachmentSources(message: RcMessage): AgentAttachmentSource[] {
  const sources: AgentAttachmentSource[] = [];
  const visit = (
    attachments: RcMessage['attachments'],
    preferredName?: string,
    preferredImage = false,
  ) => {
    for (const [index, attachment] of (attachments ?? []).entries()) {
      const path = attachment.title_link_download
        ? attachment.title_link
        : attachment.image_url
          ? attachment.title_link ?? attachment.image_url
          : undefined;
      if (path) {
        sources.push({
          messageId: message._id,
          name: preferredName ?? attachment.title ?? `attachment-${index + 1}`,
          path,
          image: preferredImage || !!attachment.image_url,
        });
      }
      visit(attachment.attachments);
    }
  };
  visit(message.attachments, message.file?.name, message.file?.type?.startsWith('image/') ?? false);
  return sources;
}

export function collectAgentAttachmentSources(messages: readonly RcMessage[]): AgentAttachmentSource[] {
  const seen = new Set<string>();
  return messages.flatMap(attachmentSources).filter((source) => {
    if (seen.has(source.path)) return false;
    seen.add(source.path);
    return true;
  });
}

function messageUrls(message: RcMessage): string[] {
  return [
    ...(message.urls ?? []).map((entry) => entry.url),
    ...Array.from(message.msg.matchAll(/https?:\/\/[^\s<>()]+/g), (match) => match[0]),
  ];
}

export function collectLinkedWorkItems(
  messages: readonly RcMessage[],
  adoBase: string | null,
  knownWorkItems: readonly KnownWorkItem[],
): AgentLinkedWorkItem[] {
  const linked = new Map<number, AgentLinkedWorkItem>();
  const known = new Map(knownWorkItems.map((item) => [item.id, item]));
  const add = (id: number, href?: string) => {
    const item = known.get(id);
    if (!item && !href) return;
    linked.set(id, item ? { ...item } : { id, webUrl: href! });
  };
  for (const message of messages) {
    for (const url of messageUrls(message)) {
      const entity = parseAdoUrl(url, adoBase);
      if (entity?.kind === 'workitem') add(entity.id, entity.href);
    }
    for (const match of message.msg.matchAll(/(?:^|\s)#(\d+)\b/g)) add(Number(match[1]));
  }
  return [...linked.values()];
}

function messageLine(message: RcMessage, attachmentPaths: Readonly<Record<string, readonly string[]>>): string {
  const author = message.u.name || message.u.username;
  const time = new Date(tsMs(message.ts)).toISOString();
  const attachmentNames = [message.file?.name, ...(message.attachments ?? []).map((item) => item.title)]
    .filter((value): value is string => !!value)
    .join(', ');
  const quotes = (message.attachments ?? [])
    .filter((attachment) => !!attachment.message_link)
    .map((attachment) => `${attachment.author_name ?? t('agent.context.unknownAuthor')}: ${attachment.text ?? t('agent.context.noText')}`)
    .join(' | ');
  const paths = attachmentPaths[message._id]?.join(', ');
  return `[${time}] ${author} (${message.u._id}): ${stripQuotePrefix(stripAgentSessionMarker(message.msg))}${quotes ? t('agent.context.quoteBracket', { quotes }) : ''}${attachmentNames ? t('agent.context.attachmentBracket', { names: attachmentNames }) : ''}${paths ? t('agent.context.attachmentPathBracket', { paths }) : ''}`;
}

export function buildAgentContext(input: {
  command: RcMessage;
  messages: readonly RcMessage[];
  room?: RcRoom;
  limit?: number;
  attachmentPaths?: Readonly<Record<string, readonly string[]>>;
  linkedWorkItems?: readonly AgentLinkedWorkItem[];
}): string {
  const instruction = agentInstruction(input.command.msg);
  if (instruction === null) throw new Error(t('agent.context.notAgentInstruction'));
  const limit = Math.max(1, Math.min(200, input.limit ?? DEFAULT_MESSAGE_LIMIT));
  const selectedMessages = input.command.tmid
    ? selectAgentContextMessages(input.command, input.messages)
    : input.messages
        .filter((message) => message.rid === input.command.rid)
        .sort((left, right) => tsMs(left.ts) - tsMs(right.ts));
  const limitedMessages = selectedMessages
    .slice(-limit)
  const context = limitedMessages
    .map((message) => messageLine(message, input.attachmentPaths ?? {}))
    .join('\n')
    .slice(-MAX_CONTEXT_CHARS);
  const participants = [...new Map(limitedMessages.map((message) => [message.u._id, message.u])).values()]
    .map((user) => `${user.name || user.username} (${user._id})`)
    .join(', ');
  const workItems = (input.linkedWorkItems ?? [])
    .map(
      (item) =>
        `#${item.id} ${item.title ?? t('agent.context.detailsNotLoaded')}${item.type ? ` · ${item.type}` : ''}${item.state ? ` · ${item.state}` : ''}${item.project ? ` · ${item.project}` : ''} · ${item.webUrl}`,
    )
    .join('\n');
  const room = input.room;
  return [
    t('agent.context.untrustedIntro'),
    t('agent.context.roomLine', { room: room?.fname || room?.name || input.command.rid }),
    room?.topic ? t('agent.context.topicLine', { topic: room.topic }) : '',
    t('agent.context.triggeredByLine', { user: input.command.u.name || input.command.u.username, id: input.command.u._id }),
    participants ? t('agent.context.participantsLine', { participants }) : '',
    workItems ? t('agent.context.linkedWorkItemsHeader', { items: workItems }) : '',
    '<rocket_chat_untrusted_context>',
    context,
    '</rocket_chat_untrusted_context>',
    '<rocket_chat_user_request>',
    instruction,
    '</rocket_chat_user_request>',
    t('agent.context.footer'),
  ]
    .filter(Boolean)
    .join('\n');
}
