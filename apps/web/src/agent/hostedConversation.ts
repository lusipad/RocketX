import { tsMs, type RcMessage } from '@rcx/rc-client';
import { parseAgentSessionCard, stripAgentSessionMarker } from './card';
import { agentMessageInstruction } from './context';
import type { AgentSession } from './session';

const TITLE_LIMIT = 32;
const PREVIEW_LIMIT = 56;

export interface HostedConversationLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  speaker: string;
  at: number;
}

export interface HostedConversationProjection {
  id: string;
  sessionKey: string;
  rid: string;
  roomName: string;
  title: string;
  preview: string;
  updatedAt: number;
  lines: HostedConversationLine[];
}

function shortened(text: string, limit: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function assistantText(text: string): string {
  const raw = stripAgentSessionMarker(text).trim();
  return raw.replace(/^🤖\s*(?:Codex|DeepSeek)?(?:\s*\n|\s+)/u, '').trim() || raw;
}

function belongsToSession(message: RcMessage, session: AgentSession): boolean {
  if (message.rid !== session.rid) return false;
  if (session.tmid.startsWith('room:')) return true;
  return message._id === session.tmid || message.tmid === session.tmid;
}

/**
 * 把 Rocket.Chat 中真实存在的 AI 托管交流映射成管家历史视图。
 * 这里只生成只读视图，不复制到 Butler registry，Rocket.Chat 始终是真源。
 */
export function projectHostedConversation(
  session: AgentSession,
  roomName: string,
  messages: readonly RcMessage[],
): HostedConversationProjection | null {
  const lines = messages
    .filter(
      (message) =>
        belongsToSession(message, session) &&
        !message.pending &&
        !message.failed &&
        !parseAgentSessionCard(message.msg),
    )
    .sort((left, right) => tsMs(left.ts) - tsMs(right.ts))
    .flatMap<HostedConversationLine>((message) => {
      const raw = stripAgentSessionMarker(message.msg ?? '').trim();
      if (/^🤖/u.test(raw)) {
        const text = assistantText(raw);
        return text
          ? [{
              id: message._id,
              role: 'assistant',
              text,
              speaker: 'AI 托管',
              at: tsMs(message.ts),
            }]
          : [];
      }
      const instruction = agentMessageInstruction(message, 'ai', true);
      if (!instruction) return [];
      return [{
        id: message._id,
        role: 'user',
        text: instruction,
        speaker: message.u.name || message.u.username,
        at: tsMs(message.ts),
      }];
    });

  const firstQuestion = lines.find((line) => line.role === 'user')?.text;
  if (!firstQuestion) return null;
  const last = lines[lines.length - 1];
  return {
    id: `hosted:${session.tmid}`,
    sessionKey: session.tmid,
    rid: session.rid,
    roomName,
    title: `${roomName} · ${shortened(firstQuestion, TITLE_LIMIT)}`,
    preview: shortened(last.text, PREVIEW_LIMIT),
    updatedAt: last.at,
    lines,
  };
}
