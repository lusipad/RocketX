import type { RcMessage } from '@rcx/rc-client';
import { tsMs } from '@rcx/rc-client';
import type { ComposerCommandContext } from './types';
import { handoffToButlerTask } from '../lib/butlerTaskHandoff';
import { stripQuotePrefix } from '../lib/messageText';
import { stripAgentSessionMarker } from '../agent/card';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { toast } from '../stores/toast';
import type { PullRequest } from '../stores/workbench';
import { t, tp } from '../i18n';

export type ButlerHandoffResult = 'asked';

const TRANSCRIPT_LIMIT = 40;

function roomNameOf(rid: string): string {
  const chat = useChat.getState();
  return chat.subscriptions[rid]?.fname ||
    chat.subscriptions[rid]?.name ||
    chat.rooms[rid]?.fname ||
    chat.rooms[rid]?.name ||
    rid;
}

function bodyOf(message: RcMessage): string {
  return stripQuotePrefix(stripAgentSessionMarker(message.msg ?? '')).trim();
}

function clockOf(message: RcMessage): string {
  const date = new Date(tsMs(message.ts));
  return Number.isNaN(date.getTime())
    ? ''
    : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 交给管家的消息转录：**带发言人**。
 *
 * 不复用 `messagesToMarkdown` —— 它服务于复制/导出，刻意不含发送人（见其注释），
 * 而「谁答应了什么」正需要发言人。来源芯片有 8 条上限（butlerContext.SOURCE_LIMIT），
 * 正文必须自带全量内容，否则超出部分管家根本看不到。
 */
function messagesTranscript(messages: readonly RcMessage[]): string {
  return [...messages]
    .sort((left, right) => tsMs(left.ts) - tsMs(right.ts))
    .slice(-TRANSCRIPT_LIMIT)
    .map((message) => {
      const sender = message.u?.name || message.u?.username || t('settings.kernel.butler.unknownSender');
      const clock = clockOf(message);
      const body = bodyOf(message) || t('settings.kernel.butler.nonTextContent');
      return t('settings.kernel.butler.transcriptLine', {
        prefix: clock ? `[${clock}] ` : '',
        sender,
        body,
      });
    })
    .join('\n');
}

function reportHandoffError(error: unknown): void {
  toast.error(error, t('settings.kernel.butler.handoffFailed'));
}

export function runButlerCommand({ rid, params }: ComposerCommandContext): void {
  const question = params.trim();
  if (!question) {
    useUI.getState().openButlerConversation();
    return;
  }
  const room = roomNameOf(rid);
  void handoffToButlerTask(
    t('settings.kernel.butler.commandPrompt', { room, rid, question }),
    `${room} · ${question}`,
    { rid, preferRoomPanel: true },
  ).catch(reportHandoffError);
}

/**
 * 把指定消息连同来源上下文交给当前 AI 运行时。
 */
export function askButlerAboutMessages(
  rid: string,
  messages: readonly RcMessage[],
  question: string,
): ButlerHandoffResult {
  if (!messages.length) return 'asked';
  const roomName = roomNameOf(rid);
  void handoffToButlerTask(
    [
      tp(
        messages.length,
        'settings.kernel.butler.messagesIntroOne',
        'settings.kernel.butler.messagesIntroOther',
        { roomName, rid, count: messages.length },
      ),
      t('settings.kernel.butler.userRequest', { question }),
      t('settings.kernel.butler.untrustedTranscriptNotice'),
      messagesTranscript(messages),
    ].join('\n\n'),
    `${roomName} · ${question}`,
    { rid, preferRoomPanel: true },
  ).catch(reportHandoffError);
  return 'asked';
}

/** 把指定 PR 连同真实链接交给当前 AI 管家。 */
export function askButlerAboutPullRequests(
  pullRequests: readonly PullRequest[],
  question: string,
): ButlerHandoffResult {
  if (!pullRequests.length) return 'asked';
  const separator = t('settings.kernel.butler.detailSeparator');
  const details = pullRequests.map((pr) => [
    `- PR #${pr.id}: ${pr.title}`,
    pr.project ? t('settings.kernel.butler.prProject', { project: pr.project }) : '',
    pr.webUrl ? t('settings.kernel.butler.prLink', { url: pr.webUrl }) : '',
  ].filter(Boolean).join(separator)).join('\n');
  void handoffToButlerTask(
    t('settings.kernel.butler.prsPrompt', { question, details }),
    `ADO PR · ${question}`,
  ).catch(reportHandoffError);
  return 'asked';
}
