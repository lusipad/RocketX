import type { RcMessage } from '@rcx/rc-client';
import { tsMs } from '@rcx/rc-client';
import type { ComposerCommandContext } from './types';
import { mergeButlerSources, type ButlerSource, type ButlerSurfaceContext } from '../lib/butlerContext';
import { stripQuotePrefix } from '../lib/messageText';
import { stripAgentSessionMarker } from '../agent/card';
import { useButler } from '../stores/butler';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import type { PullRequest } from '../stores/workbench';

/** 发起结果：`busy` 表示管家正忙（ask 在 running 时静默 return，入口必须自己挡）。 */
export type ButlerHandoffResult = 'asked' | 'busy';

const SOURCE_LABEL_LIMIT = 88;
const TRANSCRIPT_LIMIT = 40;

function roomNameOf(rid: string): string {
  const chat = useChat.getState();
  return chat.subscriptions[rid]?.fname ||
    chat.subscriptions[rid]?.name ||
    chat.rooms[rid]?.fname ||
    chat.rooms[rid]?.name ||
    rid;
}

function short(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim() || fallback;
  return normalized.length > SOURCE_LABEL_LIMIT
    ? `${normalized.slice(0, SOURCE_LABEL_LIMIT - 1)}…`
    : normalized;
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
      const sender = message.u?.name || message.u?.username || '未知发言人';
      const clock = clockOf(message);
      const body = bodyOf(message) || '[非文本内容]';
      return `${clock ? `[${clock}] ` : ''}${sender}：${body}`;
    })
    .join('\n');
}

/** 遵守 SOURCE_LIMIT：来源芯片满 8 条后，管家自己查证到的证据就再也挤不进来了。 */
function messageSources(rid: string, messages: readonly RcMessage[]): ButlerSource[] {
  const room = roomNameOf(rid);
  return mergeButlerSources(messages.map((message) => ({
    kind: 'message' as const,
    id: message._id,
    mid: message._id,
    rid,
    label: short(
      `${room} · ${message.u?.name || message.u?.username || ''}：${bodyOf(message)}`,
      room,
    ),
  })));
}

export function runButlerCommand({ rid, params }: ComposerCommandContext): void {
  const chat = useChat.getState();
  chat.setPanel({ kind: 'butler' });
  const question = params.trim();
  if (question) void useButler.getState().ask(question, { rid, roomName: roomNameOf(rid) });
}

/**
 * 把指定的消息交给管家：上下文随手带走，用户不用再描述「哪个群哪几条」。
 * 落到右侧管家面板（聊天模块内，不打断当前会话）。
 */
export function askButlerAboutMessages(
  rid: string,
  messages: readonly RcMessage[],
  question: string,
): ButlerHandoffResult {
  if (!messages.length) return 'asked';
  if (useButler.getState().running) return 'busy';
  const roomName = roomNameOf(rid);
  const context: ButlerSurfaceContext = {
    kind: 'room',
    label: roomName,
    detail: `用户指定的 ${messages.length} 条消息`,
    sources: messageSources(rid, messages),
  };
  useChat.getState().setPanel({ kind: 'butler' });
  void useButler.getState().ask(
    `${question}\n\n以下是「${roomName}」里指定的消息：\n${messagesTranscript(messages)}`,
    context,
    undefined,
    // 场景识别只看 question：转录里的「查一下那个文档」会把场景劫持成找文件，
    // 管家转而反问「请补充发送人」，整轮空转（对抗审查实测复现）。
    question,
  );
  return 'asked';
}

/**
 * 把指定的 PR 交给管家。落到全屏对话——工作台没有 activeRid，
 * 右侧管家面板在无 activeRid 时直接不渲染。
 */
export function askButlerAboutPullRequests(
  pullRequests: readonly PullRequest[],
  question: string,
): ButlerHandoffResult {
  if (!pullRequests.length) return 'asked';
  if (useButler.getState().running) return 'busy';
  const context: ButlerSurfaceContext = {
    kind: 'workbench',
    label: 'ADO 拉取请求',
    detail: `用户指定的 ${pullRequests.length} 个拉取请求`,
    sources: pullRequests.map((pr) => ({
      kind: 'pull-request' as const,
      id: String(pr.id),
      label: short(`PR #${pr.id} ${pr.title}`, `PR #${pr.id}`),
      ...(pr.project ? { project: pr.project } : {}),
      ...(pr.webUrl ? { webUrl: pr.webUrl } : {}),
    })),
  };
  useUI.getState().openButlerConversation();
  void useButler.getState().ask(question, context, undefined, question);
  return 'asked';
}
