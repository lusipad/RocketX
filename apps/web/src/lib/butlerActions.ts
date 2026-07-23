import type { AuditEntry } from '../kernel/permission';
import type { ButlerSource, ButlerSurfaceContext } from './butlerContext';
import {
  createButlerToolCheckpoint,
  type ButlerToolCheckpoint,
  type ButlerToolEffect,
} from './butlerToolRuntime';

export type ButlerActionKind = 'reply' | 'todo' | 'commitment' | 'ado' | 'codex';
export type ButlerActionStatus = 'proposed' | 'cancelled' | 'executed' | 'failed';
export const BUTLER_AUDIT_UPDATED_EVENT = 'rcx:butler-audit-updated';

export interface ButlerActionDraft {
  id: string;
  checkpointId: string;
  kind: ButlerActionKind;
  sourceLineId: string;
  status: 'pending';
  title: string;
  text: string;
  rid?: string;
  committedTo?: string;
  due?: string;
  sources: ButlerSource[];
}

interface SourceLine {
  id: string;
  text: string;
  sources?: ButlerSource[];
}

function plainTitle(text: string): string {
  const first = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '管家结论';
  const cleaned = first
    .replace(/^[-*#>\s]+/, '')
    .replace(/[*_`~[\]]/g, '')
    .trim();
  return (cleaned || '管家结论').slice(0, 120);
}

function targetRid(line: SourceLine, context: ButlerSurfaceContext | null): string | undefined {
  return line.sources?.find((source) => source.kind === 'message' && source.rid)?.rid
    ?? line.sources?.find((source) => source.kind === 'room' && source.rid)?.rid
    ?? context?.sources.find((source) => source.rid)?.rid;
}

export function createButlerActionDraft(
  kind: ButlerActionKind,
  line: SourceLine,
  context: ButlerSurfaceContext | null,
  id: () => string = () => crypto.randomUUID(),
): ButlerActionDraft {
  const rid = targetRid(line, context);
  const draftId = id();
  return {
    id: draftId,
    checkpointId: draftId,
    kind,
    sourceLineId: line.id,
    status: 'pending',
    title: plainTitle(line.text),
    text: line.text.trim(),
    ...(rid ? { rid } : {}),
    ...(kind === 'commitment' ? { committedTo: '' } : {}),
    sources: line.sources ?? context?.sources ?? [],
  };
}

export function normalizeButlerActionDraft(value: unknown): ButlerActionDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Partial<ButlerActionDraft>;
  if (!draft.id || typeof draft.id !== 'string' || !draft.checkpointId || typeof draft.checkpointId !== 'string') return null;
  if (draft.kind !== 'reply' && draft.kind !== 'todo' && draft.kind !== 'commitment'
    && draft.kind !== 'ado' && draft.kind !== 'codex') return null;
  if (!draft.sourceLineId || typeof draft.sourceLineId !== 'string' || draft.status !== 'pending') return null;
  if (typeof draft.title !== 'string' || typeof draft.text !== 'string' || !Array.isArray(draft.sources)) return null;
  if (draft.rid !== undefined && typeof draft.rid !== 'string') return null;
  if (draft.committedTo !== undefined && typeof draft.committedTo !== 'string') return null;
  if (draft.due !== undefined && typeof draft.due !== 'string') return null;
  return {
    id: draft.id,
    checkpointId: draft.checkpointId,
    kind: draft.kind,
    sourceLineId: draft.sourceLineId,
    status: 'pending',
    title: draft.title,
    text: draft.text,
    ...(draft.rid ? { rid: draft.rid } : {}),
    ...(draft.committedTo !== undefined ? { committedTo: draft.committedTo } : {}),
    ...(draft.due ? { due: draft.due } : {}),
    sources: draft.sources as ButlerSource[],
  };
}

function actionEffect(kind: ButlerActionKind): ButlerToolEffect {
  return kind === 'reply' || kind === 'ado' ? 'draft' : 'write';
}

function actionCapability(kind: ButlerActionKind): string {
  if (kind === 'reply') return 'chat.draft';
  if (kind === 'todo' || kind === 'commitment') return 'todos.write';
  if (kind === 'ado') return 'ado.work-items.draft';
  return 'codex.handoff';
}

function actionPreview(draft: ButlerActionDraft): string {
  if (draft.kind === 'reply') return `把回复草稿放入原会话：${draft.text.trim()}`;
  if (draft.kind === 'todo') return `创建本地待办：${draft.title.trim()}`;
  if (draft.kind === 'commitment') return `记录对 ${draft.committedTo?.trim() || '（未填写）'} 的承诺：${draft.title.trim()}`;
  if (draft.kind === 'ado') return `打开 ADO 工作项草稿：${draft.title.trim()}`;
  return '把当前 Butler 对话交接到 Codex App';
}

function actionParams(draft: ButlerActionDraft): Record<string, unknown> {
  return {
    kind: draft.kind,
    sourceLineId: draft.sourceLineId,
    title: draft.title,
    text: draft.text,
    ...(draft.rid ? { rid: draft.rid } : {}),
    ...(draft.committedTo !== undefined ? { committedTo: draft.committedTo } : {}),
    ...(draft.due ? { due: draft.due } : {}),
  };
}

export function createButlerActionCheckpoint(
  draft: ButlerActionDraft,
  now = Date.now(),
): ButlerToolCheckpoint {
  return createButlerToolCheckpoint({
    id: draft.checkpointId,
    toolName: `action.${draft.kind}`,
    effect: actionEffect(draft.kind),
    capability: actionCapability(draft.kind),
    idempotencyKey: `action:${draft.id}`,
    status: 'approval-required',
    params: actionParams(draft),
    preview: actionPreview(draft),
    now,
  });
}

export function updateButlerActionCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  draft: ButlerActionDraft,
  now = Date.now(),
): ButlerToolCheckpoint {
  return {
    ...checkpoint,
    params: actionParams(draft),
    preview: actionPreview(draft),
    updatedAt: now,
  };
}

export function preflightButlerAction(
  draft: ButlerActionDraft,
  capabilities: { adoDirectConfigured?: boolean } = {},
): string | undefined {
  if (draft.kind !== 'codex' && !draft.text.trim()) return '动作内容不能为空';
  if (draft.kind === 'reply' && !draft.rid) return '这条结论没有可回复的 Rocket.Chat 房间';
  if ((draft.kind === 'todo' || draft.kind === 'commitment' || draft.kind === 'ado') && !draft.title.trim()) {
    return '动作标题不能为空';
  }
  if (draft.kind === 'ado' && !capabilities.adoDirectConfigured) return '请先在设置中配置 ADO 直连';
  if (draft.kind === 'commitment' && !draft.committedTo?.trim()) return '请填写“我答应给谁”';
  return undefined;
}

export function butlerActionAuditEntry(
  kind: ButlerActionKind,
  status: ButlerActionStatus,
  draft: Pick<ButlerActionDraft, 'id' | 'rid'>,
  now = Date.now(),
  reason?: string,
): AuditEntry {
  return {
    id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `butler-audit-${now}-${Math.random().toString(36).slice(2)}`,
    timestamp: now,
    appId: 'builtin:butler',
    action: `butler.action.${kind}.${status}`,
    allowed: status !== 'cancelled' && status !== 'failed',
    draftId: draft.id,
    ...(draft.rid ? { rid: draft.rid } : {}),
    ...(reason ? { reason } : {}),
  };
}

export async function auditButlerAction(
  kind: ButlerActionKind,
  status: ButlerActionStatus,
  draft: Pick<ButlerActionDraft, 'id' | 'rid'>,
  reason?: string,
): Promise<void> {
  const { kernelStore } = await import('../kernel/store');
  await kernelStore.audit.append(butlerActionAuditEntry(kind, status, draft, Date.now(), reason));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BUTLER_AUDIT_UPDATED_EVENT));
}
