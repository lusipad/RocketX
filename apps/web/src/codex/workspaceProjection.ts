import type { ThreadItem } from '../agent/protocol/generated/v2/ThreadItem';
import type { Turn } from '../agent/protocol/generated/v2/Turn';
import {
  extractButlerSources,
  mergeButlerSources,
  type ButlerSource,
} from '../lib/butlerContext';
import {
  type CodexGeneratedImage,
  type CodexImageAttachment,
} from '../lib/codexImages';

const MAX_EVENT_DETAIL = 64 * 1024;

export interface CodexWorkspaceMessage {
  id: string;
  role: 'user' | 'assistant';
  speaker?: string;
  text: string;
  attachments?: CodexImageAttachment[];
  generatedImages?: CodexGeneratedImage[];
  sources?: ButlerSource[];
  pending?: boolean;
}

export interface CodexWorkspaceEvent {
  id: string;
  type: ThreadItem['type'] | 'reasoning' | 'warning' | 'autoReview' | 'turnDiff' | 'terminal';
  title: string;
  summary?: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textFromUserInput(input: unknown): string {
  const value = record(input);
  return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
}

function attachmentFromUserInput(input: unknown): CodexImageAttachment | null {
  const value = record(input);
  if (value.type !== 'localImage' && value.type !== 'image') return null;
  const source = typeof value.path === 'string'
    ? value.path
    : typeof value.url === 'string'
      ? value.url
      : '';
  const name = source.split(/[\\/]/).filter(Boolean).at(-1) ?? '图片';
  return { name, type: 'image' };
}

function generatedImageFromItem(
  item: Extract<ThreadItem, { type: 'imageGeneration' }>,
): CodexGeneratedImage | null {
  if (!item.result) return null;
  const name = item.savedPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? `${item.id}.png`;
  return {
    id: item.id,
    name,
    dataUrl: item.result.startsWith('data:') ? item.result : `data:image/png;base64,${item.result}`,
    savedPath: item.savedPath,
    alt: item.revisedPrompt?.trim() || 'Codex 生成的图片',
  };
}

export function boundedDetail(value: string): string {
  return value.length <= MAX_EVENT_DETAIL
    ? value
    : `${value.slice(value.length - MAX_EVENT_DETAIL)}\n… 输出过长，仅显示最后 64 KiB`;
}

function jsonDetail(value: unknown): string {
  try {
    return boundedDetail(JSON.stringify(value, null, 2));
  } catch {
    return String(value);
  }
}

function durationSummary(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function completedStatus(
  itemStatus: string | undefined,
  fallback: CodexWorkspaceEvent['status'],
): CodexWorkspaceEvent['status'] {
  return itemStatus === 'failed' || itemStatus === 'declined' ? 'failed' : fallback;
}

function sourceText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const text = record(value).text;
  if (typeof text === 'string') return text;
  try {
    return value === null ? null : JSON.stringify(value);
  } catch {
    return null;
  }
}

function sourcesFromToolItem(item: ThreadItem): ButlerSource[] {
  if (item.type !== 'dynamicToolCall' && item.type !== 'mcpToolCall') return [];
  const contents = item.type === 'dynamicToolCall'
    ? (item.contentItems ?? []).flatMap((content) => (
      content.type === 'inputText' ? [content.text] : []
    ))
    : item.result
      ? [item.result.structuredContent, ...item.result.content]
        .map(sourceText)
        .filter((content): content is string => content !== null)
      : [];
  const suffix = item.tool.split(/__|[./:]/).filter(Boolean).at(-1);
  const toolNames = suffix && suffix !== item.tool ? [item.tool, suffix] : [item.tool];
  return mergeButlerSources(...toolNames.flatMap((toolName) => (
    contents.map((content) => extractButlerSources(toolName, content))
  )));
}

export function messagesFromTurns(turns: readonly Turn[]): CodexWorkspaceMessage[] {
  return turns.flatMap((turn) => {
    const messages: CodexWorkspaceMessage[] = [];
    const generatedImages: CodexGeneratedImage[] = [];
    let pendingSources: ButlerSource[] = [];
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const text = item.content.map(textFromUserInput).filter(Boolean).join('\n');
        const attachments = item.content.map(attachmentFromUserInput).filter((entry) => entry !== null);
        if (text || attachments.length > 0) messages.push({ id: item.id, role: 'user', text, attachments });
      } else if (item.type === 'agentMessage' && item.text.trim()) {
        const sources = item.phase === 'commentary' ? [] : pendingSources;
        messages.push({
          id: item.id,
          role: 'assistant',
          text: item.text,
          ...(sources.length > 0 ? { sources } : {}),
        });
        if (item.phase !== 'commentary') pendingSources = [];
      } else if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
        pendingSources = mergeButlerSources(pendingSources, sourcesFromToolItem(item));
      } else if (item.type === 'imageGeneration') {
        const image = generatedImageFromItem(item);
        if (image) generatedImages.push(image);
      }
    }
    if (generatedImages.length > 0) {
      let assistantIndex = messages.length - 1;
      while (assistantIndex >= 0 && messages[assistantIndex].role !== 'assistant') assistantIndex -= 1;
      if (assistantIndex >= 0) {
        messages[assistantIndex] = { ...messages[assistantIndex], generatedImages };
      } else {
        messages.push({ id: `generated-images-${turn.id}`, role: 'assistant', text: '', generatedImages });
      }
    }
    return messages;
  });
}

export function eventFromItem(item: ThreadItem, status: CodexWorkspaceEvent['status']): CodexWorkspaceEvent | null {
  if (item.type === 'commandExecution') {
    const metadata = [
      item.exitCode === null ? null : `退出码 ${item.exitCode}`,
      durationSummary(item.durationMs),
    ].filter(Boolean).join(' · ');
    return {
      id: item.id,
      type: item.type,
      title: '运行命令',
      summary: item.command,
      detail: boundedDetail([item.aggregatedOutput, metadata].filter(Boolean).join('\n\n')) || undefined,
      status: completedStatus(item.status, status),
    };
  }
  if (item.type === 'fileChange') {
    return { id: item.id, type: item.type, title: '修改文件', summary: item.changes.map((change) => change.path).join('、'), status: completedStatus(item.status, status) };
  }
  if (item.type === 'mcpToolCall') {
    return { id: item.id, type: item.type, title: item.tool, summary: item.server, detail: item.error?.message ?? (item.result ? jsonDetail(item.result) : undefined), status: completedStatus(item.status, status) };
  }
  if (item.type === 'dynamicToolCall') {
    return { id: item.id, type: item.type, title: item.tool, summary: item.namespace ?? undefined, detail: item.contentItems ? jsonDetail(item.contentItems) : undefined, status: completedStatus(item.status, status) };
  }
  if (item.type === 'plan') return { id: item.id, type: item.type, title: '更新计划', detail: item.text, status };
  if (item.type === 'reasoning') return { id: item.id, type: item.type, title: '思考', detail: boundedDetail([...item.summary, ...item.content].join('\n')) || undefined, status };
  if (item.type === 'collabAgentToolCall') return { id: item.id, type: item.type, title: '协作代理', summary: item.tool, detail: item.prompt ?? (item.receiverThreadIds.join('、') || undefined), status: completedStatus(item.status, status) };
  if (item.type === 'subAgentActivity') return { id: item.id, type: item.type, title: '协作代理', summary: item.agentPath, detail: item.kind, status };
  if (item.type === 'webSearch') {
    const value = record(item);
    return { id: item.id, type: item.type, title: '搜索网络', summary: typeof value.query === 'string' ? value.query : undefined, status };
  }
  if (item.type === 'imageView') return { id: item.id, type: item.type, title: '查看图片', summary: item.path, status };
  if (item.type === 'imageGeneration') return { id: item.id, type: item.type, title: '生成图片', status };
  if (item.type === 'sleep') return { id: item.id, type: item.type, title: '等待', summary: durationSummary(item.durationMs) ?? undefined, status };
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') return { id: item.id, type: item.type, title: item.type === 'enteredReviewMode' ? '进入审查' : '完成审查', detail: item.review, status };
  if (item.type === 'contextCompaction') return { id: item.id, type: item.type, title: '压缩上下文', status };
  return null;
}
