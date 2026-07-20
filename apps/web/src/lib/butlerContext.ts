export type ButlerSourceKind =
  | 'room'
  | 'message'
  | 'todo'
  | 'calendar'
  | 'work-item'
  | 'pull-request'
  | 'build';

export interface ButlerSource {
  kind: ButlerSourceKind;
  id: string;
  label: string;
  rid?: string;
  mid?: string;
  project?: string;
  webUrl?: string;
}

export interface ButlerSurfaceContext {
  kind: 'room' | 'todos' | 'calendar' | 'workbench' | 'surface';
  label: string;
  detail: string;
  sources: ButlerSource[];
}

const SOURCE_LIMIT = 8;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function idOf(record: Record<string, unknown>, key = 'id'): string | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function short(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() || fallback;
  return normalized.length > 88 ? `${normalized.slice(0, 87)}…` : normalized;
}

function parseRows(content: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed)
      ? parsed.map(recordOf).filter((row): row is Record<string, unknown> => !!row)
      : [];
  } catch {
    return [];
  }
}

export function mergeButlerSources(...groups: readonly ButlerSource[][]): ButlerSource[] {
  const seen = new Set<string>();
  const result: ButlerSource[] = [];
  for (const source of groups.flat()) {
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
    if (result.length >= SOURCE_LIMIT) break;
  }
  return result;
}

export function extractButlerSources(toolName: string | undefined, content: string): ButlerSource[] {
  if (!toolName) return [];

  if (toolName === 'search_people_rooms') {
    try {
      const parsed = recordOf(JSON.parse(content));
      const rooms = Array.isArray(parsed?.rooms) ? parsed.rooms : [];
      return mergeButlerSources(rooms.flatMap((value) => {
        const row = recordOf(value);
        const id = row && idOf(row);
        if (!row || !id) return [];
        return [{ kind: 'room', id, rid: id, label: short(textOf(row, 'name'), id) } satisfies ButlerSource];
      }));
    } catch {
      return [];
    }
  }

  const rows = parseRows(content);
  const sources = rows.flatMap((row): ButlerSource[] => {
    if (toolName === 'search_messages' || toolName === 'list_mentions') {
      const mid = idOf(row, toolName === 'search_messages' ? '_id' : 'id');
      const rid = idOf(row, 'rid');
      if (!mid || !rid) return [];
      const room = textOf(row, 'roomName') ?? rid;
      const sender = textOf(row, 'sender');
      const body = short(textOf(row, 'text'), '消息');
      return [{
        kind: 'message', id: mid, mid, rid,
        label: short(`${room}${sender ? ` · ${sender}` : ''}：${body}`, room),
      }];
    }
    if (toolName === 'list_todos') {
      const id = idOf(row);
      if (!id) return [];
      return [{ kind: 'todo', id, label: short(textOf(row, 'text'), '待办') }];
    }
    if (toolName === 'list_calendar') {
      const id = idOf(row);
      if (!id) return [];
      const title = short(textOf(row, 'title'), '日程');
      const date = textOf(row, 'date');
      return [{ kind: 'calendar', id, label: date ? `${date} · ${title}` : title }];
    }
    if (toolName === 'list_work_items') {
      const id = idOf(row);
      if (!id) return [];
      return [{
        kind: 'work-item', id,
        label: short(`#${id} ${textOf(row, 'title') ?? '工作项'}`, `#${id}`),
        project: textOf(row, 'project'),
        webUrl: textOf(row, 'webUrl'),
      }];
    }
    if (toolName === 'list_pull_requests') {
      const id = idOf(row);
      if (!id) return [];
      return [{
        kind: 'pull-request', id,
        label: short(`PR #${id} ${textOf(row, 'title') ?? ''}`, `PR #${id}`),
        project: textOf(row, 'project'),
        webUrl: textOf(row, 'webUrl'),
      }];
    }
    if (toolName === 'list_builds') {
      const id = idOf(row);
      if (!id) return [];
      const name = textOf(row, 'buildNumber') ?? textOf(row, 'definition') ?? id;
      return [{
        kind: 'build', id,
        label: short(`构建 ${name}`, `构建 ${id}`),
        project: textOf(row, 'project'),
        webUrl: textOf(row, 'webUrl'),
      }];
    }
    return [];
  });
  return mergeButlerSources(sources);
}

export function butlerContextPrompt(context: ButlerSurfaceContext): string {
  return [
    `用户当前工作面：${context.label}`,
    context.detail,
    ...(context.kind === 'room' ? [`用户当前所在房间：${context.label}`] : []),
    context.kind === 'room'
      ? `查询本房间消息时优先用 search_messages 的 roomName 参数限定范围为“${context.label}”。`
      : '回答时优先结合这个工作面；需要事实时仍调用工具查证，不要把页面摘要当成完整数据。',
  ].join('\n');
}
