import type { AuditEntry } from '../kernel/permission';
import type { ButlerSource, ButlerSurfaceContext } from './butlerContext';
import type { AdoAuth } from './adoDirect';
import {
  createButlerToolCheckpoint,
  type ButlerToolCheckpoint,
  type ButlerToolEffect,
} from './butlerToolRuntime';

export type ButlerActionKind = 'reply' | 'send' | 'todo' | 'commitment' | 'ado' | 'ado-state' | 'codex';
export type ButlerAnswerActionKind = Exclude<ButlerActionKind, 'ado-state'>;
export type ButlerActionStatus = 'proposed' | 'cancelled' | 'executed' | 'failed';
export const BUTLER_AUDIT_UPDATED_EVENT = 'rcx:butler-audit-updated';
const ACTION_MESSAGE_ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
const ACTION_MESSAGE_ID_RE = /^[23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz]{17}$/;

let actionDraftProvider: (kind: ButlerAnswerActionKind) => boolean = () => false;
let adoStateDraftProvider: (input: ButlerAdoStateDraftInput) => boolean = () => false;

export function setButlerActionDraftProvider(
  provider: (kind: ButlerAnswerActionKind) => boolean,
): () => void {
  const previous = actionDraftProvider;
  actionDraftProvider = provider;
  return () => {
    actionDraftProvider = previous;
  };
}

export function requestButlerActionDraft(kind: ButlerAnswerActionKind): boolean {
  return actionDraftProvider(kind);
}

export function setButlerAdoStateDraftProvider(
  provider: (input: ButlerAdoStateDraftInput) => boolean,
): () => void {
  const previous = adoStateDraftProvider;
  adoStateDraftProvider = provider;
  return () => {
    adoStateDraftProvider = previous;
  };
}

export function requestButlerAdoStateDraft(input: ButlerAdoStateDraftInput): boolean {
  return adoStateDraftProvider(input);
}

export interface ButlerAdoStateDraftInput {
  workItemId: number;
  workItemTitle: string;
  currentState: string;
  targetState: string;
  expectedRevision: number;
  adoIdentityId: string;
  project?: string;
  webUrl?: string;
  adoBase: string;
  adoAuth?: AdoAuth;
  adoAccount: string;
}

export interface ButlerActionDraft {
  id: string;
  checkpointId: string;
  kind: ButlerActionKind;
  sourceLineId: string;
  status: 'pending';
  title: string;
  text: string;
  rid?: string;
  messageId?: string;
  committedTo?: string;
  due?: string;
  workItemId?: number;
  currentState?: string;
  targetState?: string;
  expectedRevision?: number;
  adoIdentityId?: string;
  adoBase?: string;
  adoAuth?: AdoAuth;
  adoAccount?: string;
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

function hashMessageSeed(input: string, seed: number): number {
  let value = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value >>> 0;
}

export function butlerActionMessageId(seed: string): string {
  const source = seed || 'butler-action';
  let left = hashMessageSeed(source, 2166136261);
  let right = hashMessageSeed(`butler:${source}`, 2654435761);
  let output = '';
  for (let index = 0; index < 17; index += 1) {
    left = Math.imul(left ^ (left >>> 15), 2246822519) >>> 0;
    right = Math.imul(right ^ (right >>> 13), 3266489917) >>> 0;
    const mixed = (left + right + source.charCodeAt(index % source.length)) >>> 0;
    output += ACTION_MESSAGE_ID_CHARS[mixed % ACTION_MESSAGE_ID_CHARS.length];
    left = (left + index + 1) >>> 0;
    right = (right + mixed) >>> 0;
  }
  return output;
}

export function isButlerActionMessageId(value: unknown): value is string {
  return typeof value === 'string' && ACTION_MESSAGE_ID_RE.test(value);
}

export function normalizeAdoIdentityId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function createButlerActionDraft(
  kind: ButlerAnswerActionKind,
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
    ...(kind === 'send' ? { messageId: butlerActionMessageId(draftId) } : {}),
    ...(kind === 'commitment' ? { committedTo: '' } : {}),
    sources: line.sources ?? context?.sources ?? [],
  };
}

export function createButlerAdoStateActionDraft(
  input: ButlerAdoStateDraftInput,
  id: () => string = () => crypto.randomUUID(),
): ButlerActionDraft {
  const workItemId = input.workItemId;
  const expectedRevision = input.expectedRevision;
  const title = input.workItemTitle.trim() || `工作项 #${workItemId}`;
  const currentState = input.currentState.trim();
  const targetState = input.targetState.trim();
  const adoIdentityId = normalizeAdoIdentityId(input.adoIdentityId);
  const adoBase = input.adoBase.trim().replace(/\/+$/, '');
  if (!Number.isInteger(workItemId) || workItemId <= 0) throw new Error('工作项编号无效');
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new Error('工作项 revision 无效');
  if (!currentState) throw new Error('当前状态不能为空');
  if (!targetState) throw new Error('目标状态不能为空');
  if (!adoIdentityId) throw new Error('ADO 身份不能为空');
  if (!adoBase) throw new Error('ADO 连接不能为空');
  const draftId = id();
  return {
    id: draftId,
    checkpointId: draftId,
    kind: 'ado-state',
    sourceLineId: `work-item:${workItemId}:rev:${expectedRevision}`,
    status: 'pending',
    title,
    text: `把 #${workItemId} 从「${currentState}」改为「${targetState}」`,
    workItemId,
    currentState,
    targetState,
    expectedRevision,
    adoIdentityId,
    adoBase,
    ...(input.adoAuth ? { adoAuth: input.adoAuth } : {}),
    adoAccount: input.adoAccount.trim(),
    sources: [{
      kind: 'work-item',
      id: String(workItemId),
      label: `#${workItemId} ${title}`,
      ...(input.project?.trim() ? { project: input.project.trim() } : {}),
      ...(input.webUrl?.trim() ? { webUrl: input.webUrl.trim() } : {}),
    }],
  };
}

function isAdoAuth(value: unknown): value is AdoAuth {
  return value === 'ntlm' || value === 'pat' || value === 'bearer' || value === 'none';
}

export function normalizeButlerActionDraft(value: unknown): ButlerActionDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Partial<ButlerActionDraft>;
  if (!draft.id || typeof draft.id !== 'string' || !draft.checkpointId || typeof draft.checkpointId !== 'string') return null;
  if (draft.kind !== 'reply' && draft.kind !== 'send' && draft.kind !== 'todo' && draft.kind !== 'commitment'
    && draft.kind !== 'ado' && draft.kind !== 'ado-state' && draft.kind !== 'codex') return null;
  if (!draft.sourceLineId || typeof draft.sourceLineId !== 'string' || draft.status !== 'pending') return null;
  if (typeof draft.title !== 'string' || typeof draft.text !== 'string' || !Array.isArray(draft.sources)) return null;
  if (draft.rid !== undefined && typeof draft.rid !== 'string') return null;
  if (draft.messageId !== undefined && !isButlerActionMessageId(draft.messageId)) return null;
  if (draft.committedTo !== undefined && typeof draft.committedTo !== 'string') return null;
  if (draft.due !== undefined && typeof draft.due !== 'string') return null;
  if (draft.kind === 'ado-state') {
    if (!Number.isInteger(draft.workItemId) || (draft.workItemId ?? 0) <= 0) return null;
    if (!Number.isInteger(draft.expectedRevision) || (draft.expectedRevision ?? 0) <= 0) return null;
    if (typeof draft.currentState !== 'string' || !draft.currentState.trim()) return null;
    if (typeof draft.targetState !== 'string' || !draft.targetState.trim()) return null;
    if (!normalizeAdoIdentityId(draft.adoIdentityId)) return null;
    if (typeof draft.adoBase !== 'string' || !draft.adoBase.trim()) return null;
    if (draft.adoAuth !== undefined && !isAdoAuth(draft.adoAuth)) return null;
    if (typeof draft.adoAccount !== 'string') return null;
  }
  return {
    id: draft.id,
    checkpointId: draft.checkpointId,
    kind: draft.kind,
    sourceLineId: draft.sourceLineId,
    status: 'pending',
    title: draft.title,
    text: draft.text,
    ...(draft.rid ? { rid: draft.rid } : {}),
    ...(draft.messageId ? { messageId: draft.messageId } : {}),
    ...(draft.committedTo !== undefined ? { committedTo: draft.committedTo } : {}),
    ...(draft.due ? { due: draft.due } : {}),
    ...(draft.workItemId !== undefined ? { workItemId: draft.workItemId } : {}),
    ...(draft.currentState !== undefined ? { currentState: draft.currentState } : {}),
    ...(draft.targetState !== undefined ? { targetState: draft.targetState } : {}),
    ...(draft.expectedRevision !== undefined ? { expectedRevision: draft.expectedRevision } : {}),
    ...(draft.adoIdentityId !== undefined ? { adoIdentityId: normalizeAdoIdentityId(draft.adoIdentityId)! } : {}),
    ...(draft.adoBase !== undefined ? { adoBase: draft.adoBase } : {}),
    ...(draft.adoAuth !== undefined ? { adoAuth: draft.adoAuth } : {}),
    ...(draft.adoAccount !== undefined ? { adoAccount: draft.adoAccount } : {}),
    sources: draft.sources as ButlerSource[],
  };
}

function actionEffect(kind: ButlerActionKind): ButlerToolEffect {
  return kind === 'reply' || kind === 'ado' ? 'draft' : 'write';
}

function actionCapability(kind: ButlerActionKind): string {
  if (kind === 'reply') return 'chat.draft';
  if (kind === 'send') return 'chat.messages.write';
  if (kind === 'todo' || kind === 'commitment') return 'todos.write';
  if (kind === 'ado') return 'ado.work-items.draft';
  if (kind === 'ado-state') return 'ado.work-items.state.write';
  return 'codex.handoff';
}

function actionPreview(draft: ButlerActionDraft): string {
  if (draft.kind === 'reply') return `把回复草稿放入原会话：${draft.text.trim()}`;
  if (draft.kind === 'send') return `发送回复到原会话：${draft.text.trim()}`;
  if (draft.kind === 'todo') return `创建本地待办：${draft.title.trim()}`;
  if (draft.kind === 'commitment') return `记录对 ${draft.committedTo?.trim() || '（未填写）'} 的承诺：${draft.title.trim()}`;
  if (draft.kind === 'ado') return `打开 ADO 工作项草稿：${draft.title.trim()}`;
  if (draft.kind === 'ado-state') {
    return `修改 ADO 工作项 #${draft.workItemId}「${draft.title.trim()}」：${draft.currentState} → ${draft.targetState}`;
  }
  return '把当前管家对话交接到 Codex App';
}

function actionParams(draft: ButlerActionDraft): Record<string, unknown> {
  return {
    kind: draft.kind,
    sourceLineId: draft.sourceLineId,
    title: draft.title,
    text: draft.text,
    ...(draft.rid ? { rid: draft.rid } : {}),
    ...(draft.messageId ? { messageId: draft.messageId } : {}),
    ...(draft.committedTo !== undefined ? { committedTo: draft.committedTo } : {}),
    ...(draft.due ? { due: draft.due } : {}),
    ...(draft.workItemId !== undefined ? { workItemId: draft.workItemId } : {}),
    ...(draft.currentState !== undefined ? { currentState: draft.currentState } : {}),
    ...(draft.targetState !== undefined ? { targetState: draft.targetState } : {}),
    ...(draft.expectedRevision !== undefined ? { expectedRevision: draft.expectedRevision } : {}),
    ...(draft.adoIdentityId !== undefined ? { adoIdentityId: draft.adoIdentityId } : {}),
    ...(draft.adoBase !== undefined ? { adoBase: draft.adoBase } : {}),
    ...(draft.adoAuth !== undefined ? { adoAuth: draft.adoAuth } : {}),
    ...(draft.adoAccount !== undefined ? { adoAccount: draft.adoAccount } : {}),
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
  capabilities: {
    adoDirectConfigured?: boolean;
    adoConnection?: { adoBase: string; auth?: AdoAuth; account: string };
  } = {},
): string | undefined {
  if (draft.kind !== 'codex' && !draft.text.trim()) return '动作内容不能为空';
  if ((draft.kind === 'reply' || draft.kind === 'send') && !draft.rid) return '这条结论没有可回复的 Rocket.Chat 房间';
  if (draft.kind === 'send' && !isButlerActionMessageId(draft.messageId)) return '发送动作缺少稳定消息 ID';
  if ((draft.kind === 'todo' || draft.kind === 'commitment' || draft.kind === 'ado' || draft.kind === 'ado-state') && !draft.title.trim()) {
    return '动作标题不能为空';
  }
  if ((draft.kind === 'ado' || draft.kind === 'ado-state') && !capabilities.adoDirectConfigured) {
    return '请先在设置中配置 ADO 直连';
  }
  if (draft.kind === 'ado-state') {
    if (!Number.isInteger(draft.workItemId) || !Number.isInteger(draft.expectedRevision)
      || !draft.currentState?.trim() || !draft.targetState?.trim()
      || !normalizeAdoIdentityId(draft.adoIdentityId) || !draft.adoBase?.trim()) {
      return 'ADO 状态修改参数不完整，请重新发起';
    }
    const current = capabilities.adoConnection;
    const sameBase = current?.adoBase.trim().replace(/\/+$/, '').toLocaleLowerCase()
      === draft.adoBase.trim().replace(/\/+$/, '').toLocaleLowerCase();
    const sameAuth = (current?.auth ?? 'pat') === (draft.adoAuth ?? 'pat');
    const sameAccount = (current?.account ?? '').trim().toLocaleLowerCase()
      === (draft.adoAccount ?? '').trim().toLocaleLowerCase();
    if (!current || !sameBase || !sameAuth || !sameAccount) {
      return 'ADO 连接或账号已变化，请重新发起状态修改';
    }
  }
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
