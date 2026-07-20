import type { AuditEntry } from '../kernel/permission';
import type { ButlerSource, ButlerSurfaceContext } from './butlerContext';

export type ButlerActionKind = 'reply' | 'todo' | 'commitment' | 'ado' | 'codex';
export type ButlerActionStatus = 'proposed' | 'cancelled' | 'executed' | 'failed';
export const BUTLER_AUDIT_UPDATED_EVENT = 'rcx:butler-audit-updated';

export interface ButlerActionDraft {
  id: string;
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
  return {
    id: id(),
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
