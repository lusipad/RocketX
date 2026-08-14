export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

export interface DshMessage {
  id: string;
  role: 'assistant' | 'user' | 'system';
  text: string;
}

export interface DshActivity {
  id: string;
  title: string;
  summary?: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
}

export interface DshTranscript {
  messages: DshMessage[];
  activities: DshActivity[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    const item = record(block);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n').trim();
}

function messageFromEvent(sessionId: string, event: DshSessionEvent): DshMessage | null {
  if (event.type === 'user/message') {
    const message = record(event.data);
    const source = record(message?.source);
    if (message?.role !== 'user' || source?.kind !== 'user') return null;
    const text = contentText(message.content);
    if (!text) return null;
    return {
      id: typeof message.id === 'string' ? message.id : `${sessionId}:${event.seq}`,
      role: 'user',
      text,
    };
  }

  if (event.type === 'assistant/message') {
    const data = record(event.data);
    const message = record(data?.message);
    if (message?.role !== 'assistant') return null;
    const text = contentText(message.content);
    if (!text) return null;
    return {
      id: typeof message.id === 'string' ? message.id : `${sessionId}:${event.seq}`,
      role: 'assistant',
      text,
    };
  }

  return null;
}

function failureMessage(value: unknown): string | null {
  const reason = record(value);
  if (reason?.kind !== 'error') return null;
  const error = record(reason.error);
  return typeof error?.message === 'string' ? error.message : 'DeepSeek 执行失败';
}

export function projectDshTranscript(sessionId: string, sourceEvents: Iterable<DshSessionEvent>): DshTranscript {
  const events = [...sourceEvents].sort((left, right) => left.seq - right.seq);
  const messagesWithSeq: Array<DshMessage & { seq: number }> = [];
  const activities = new Map<string, DshActivity>();
  const completedAssistantSteps = new Set<string>();
  const assistantDrafts = new Map<string, { seq: number; text: string }>();

  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const data = record(event.data);
    if (typeof data?.turn === 'number' && typeof data.step === 'number') {
      completedAssistantSteps.add(`${data.turn}:${data.step}`);
    }
  }

  for (const event of events) {
    const message = messageFromEvent(sessionId, event);
    if (message) messagesWithSeq.push({ ...message, seq: event.seq });

    const data = record(event.data);
    if (event.type === 'assistant/chunk' && typeof data?.turn === 'number' && typeof data?.step === 'number') {
      const key = `${data.turn}:${data.step}`;
      if (completedAssistantSteps.has(key)) continue;
      const chunk = record(data.chunk);
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const draft = assistantDrafts.get(key);
        assistantDrafts.set(key, {
          seq: draft?.seq ?? event.seq,
          text: `${draft?.text ?? ''}${chunk.text}`,
        });
      }
    } else if (event.type === 'tool/call' && typeof data?.callId === 'string') {
      const title = typeof data.name === 'string' ? data.name : '工具调用';
      activities.set(data.callId, {
        id: data.callId,
        title,
        summary: '正在执行',
        detail: typeof data.arguments === 'string' ? data.arguments.slice(0, 4_000) : undefined,
        status: 'running',
      });
    } else if (event.type === 'tool/result') {
      const resultMessage = record(data?.message);
      const source = record(resultMessage?.source);
      const callId = typeof source?.callId === 'string' ? source.callId : null;
      if (!callId) continue;
      const previous = activities.get(callId);
      activities.set(callId, {
        id: callId,
        title: previous?.title ?? '工具调用',
        summary: data?.error ? '执行失败' : '执行完成',
        detail: previous?.detail,
        status: data?.error ? 'failed' : 'completed',
      });
    } else if (event.type === 'turn/end') {
      const message = failureMessage(data?.reason);
      if (message) {
        activities.set(`turn:${String(data?.turn ?? event.seq)}`, {
          id: `turn:${String(data?.turn ?? event.seq)}`,
          title: 'DeepSeek 执行失败',
          summary: message,
          status: 'failed',
        });
      }
    }
  }

  for (const [key, draft] of assistantDrafts) {
    const text = draft.text.trim();
    if (!text) continue;
    messagesWithSeq.push({
      id: `${sessionId}:draft:${key}`,
      role: 'assistant',
      text,
      seq: draft.seq,
    });
  }

  const messages = messagesWithSeq
    .sort((left, right) => left.seq - right.seq)
    .map(({ seq: _seq, ...message }) => message);
  return { messages, activities: [...activities.values()] };
}

export function dshPreview(messages: readonly DshMessage[]): string | undefined {
  const text = messages.at(-1)?.text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}
