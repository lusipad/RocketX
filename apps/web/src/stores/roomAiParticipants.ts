import { create } from 'zustand';
import { t } from '../i18n';
import type { AiParticipantDragPayload } from '../lib/butlerChatBridge';
import type { LinkedGitHubIssue } from '../lib/githubIssueLoop';
import {
  environmentNameFromPath,
  normalizeEnvironmentPath,
  useAgentEnvironments,
} from './agentEnvironments';
import { resolveButlerAccountScope } from './butlerMemory';
import { useCodexWorkspace } from './codexWorkspace';

export type RoomAiAgentKind = 'pi_butler' | 'acp';
export type RoomAiReplyPolicy = 'every_message' | 'mention_only';
export type RoomAiMode = 'solo' | 'roundtable';
export type RoundtableRoleId = 'product' | 'architect' | 'contrarian' | 'captain' | 'custom';

export interface RoomAiSeat {
  seatId: string;
  roleId: RoundtableRoleId;
  roleTitle: string;
  stancePrompt?: string;
  agentKind: RoomAiAgentKind;
  agentId: string;
  agentName: string;
  enabled: boolean;
  threadId?: string;
  acpSessionKey?: string;
}

export interface RoomAiParticipant {
  rid: string;
  isDiscussion: boolean;
  mode?: RoomAiMode;
  seats?: RoomAiSeat[];
  agentKind: RoomAiAgentKind;
  agentId: string;
  agentName: string;
  replyPolicy: RoomAiReplyPolicy;
  enabled: boolean;
  threadId?: string;
  acpSessionKey?: string;
  workspaceRoot?: string;
  originDiscussionRid?: string;
  originDiscussionName?: string;
  latestDecisionSummary?: string;
  linkedCardId?: string;
  linkedGithubIssue?: LinkedGitHubIssue;
  lastProcessedMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnrollRoomAiInput {
  rid: string;
  isDiscussion: boolean;
  mode?: RoomAiMode;
  seats?: RoomAiSeat[];
  agentKind: RoomAiAgentKind;
  agentId: string;
  agentName: string;
  replyPolicy?: RoomAiReplyPolicy;
  enabled?: boolean;
  threadId?: string;
  acpSessionKey?: string;
  workspaceRoot?: string;
  originDiscussionRid?: string;
  originDiscussionName?: string;
  latestDecisionSummary?: string;
  linkedCardId?: string;
  linkedGithubIssue?: LinkedGitHubIssue;
}

export interface SelectableProjectWorkspace {
  label: string;
  path: string;
  isSandbox?: boolean;
}

export function createDefaultRoundtableSeats(
  defaultAgent?: { kind: RoomAiAgentKind; id: string; name: string },
): RoomAiSeat[] {
  const kind = defaultAgent?.kind ?? 'pi_butler';
  const id = defaultAgent?.id ?? 'pi_butler';
  const name = defaultAgent?.name || t('chat.aiParticipant.piButlerName');
  return [
    {
      seatId: 'seat-product',
      roleId: 'product',
      roleTitle: t('chat.aiParticipant.seatProductTitle'),
      agentKind: kind,
      agentId: id,
      agentName: name,
      enabled: true,
    },
    {
      seatId: 'seat-architect',
      roleId: 'architect',
      roleTitle: t('chat.aiParticipant.seatArchitectTitle'),
      agentKind: kind,
      agentId: id,
      agentName: name,
      enabled: true,
    },
    {
      seatId: 'seat-contrarian',
      roleId: 'contrarian',
      roleTitle: t('chat.aiParticipant.seatContrarianTitle'),
      agentKind: kind,
      agentId: id,
      agentName: name,
      enabled: true,
    },
    {
      seatId: 'seat-captain',
      roleId: 'captain',
      roleTitle: t('chat.aiParticipant.seatCaptainTitle'),
      agentKind: kind,
      agentId: id,
      agentName: name,
      enabled: true,
    },
  ];
}

export function listSelectableProjectWorkspaces(): SelectableProjectWorkspace[] {
  const envs = useAgentEnvironments.getState().environments;
  const ws = useCodexWorkspace.getState();
  const seen = new Set<string>();
  const items: SelectableProjectWorkspace[] = [];

  const pushUnique = (pathValue: string | undefined | null, label?: string, isSandbox = false) => {
    const trimmed = pathValue?.trim();
    if (!trimmed) return;
    const key = normalizeEnvironmentPath(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({
      label: label?.trim() || environmentNameFromPath(trimmed),
      path: trimmed,
      isSandbox,
    });
  };

  for (const env of envs) {
    if (env.enabled) pushUnique(env.path, env.name, false);
  }
  const butlerKey = normalizeEnvironmentPath(ws.butlerWorkspaceRoot || '');
  if (ws.workspaceRoot && normalizeEnvironmentPath(ws.workspaceRoot) !== butlerKey) {
    pushUnique(ws.workspaceRoot, environmentNameFromPath(ws.workspaceRoot), false);
  }
  if (ws.defaultWorkspaceRoot && normalizeEnvironmentPath(ws.defaultWorkspaceRoot) !== butlerKey) {
    pushUnique(ws.defaultWorkspaceRoot, environmentNameFromPath(ws.defaultWorkspaceRoot), false);
  }
  if (ws.butlerWorkspaceRoot) {
    pushUnique(ws.butlerWorkspaceRoot, t('chat.aiParticipant.sandboxWorkspaceLabel'), true);
  }
  return items;
}

export function resolvePreferredProjectWorkspace(): string {
  const envState = useAgentEnvironments.getState();
  const preferredEnv = envState.lastDispatchEnvironmentId
    ? envState.environments.find((e) => e.enabled && e.id === envState.lastDispatchEnvironmentId)
    : undefined;
  if (preferredEnv?.path) return preferredEnv.path;

  const firstEnabled = envState.environments.find((e) => e.enabled && e.path);
  if (firstEnabled?.path) return firstEnabled.path;

  const ws = useCodexWorkspace.getState();
  const butlerKey = normalizeEnvironmentPath(ws.butlerWorkspaceRoot || '');
  if (ws.workspaceRoot && normalizeEnvironmentPath(ws.workspaceRoot) !== butlerKey) {
    return ws.workspaceRoot;
  }
  if (ws.defaultWorkspaceRoot && normalizeEnvironmentPath(ws.defaultWorkspaceRoot) !== butlerKey) {
    return ws.defaultWorkspaceRoot;
  }
  return ws.butlerWorkspaceRoot || '';
}

const STORAGE_PREFIX = 'rcx-room-ai-participants:v1:';
const MAX_PARTICIPANTS = 120;

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope || 'default'}`;
}

function readPersisted(scope: string): Record<string, RoomAiParticipant> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, RoomAiParticipant>;
  } catch {
    return {};
  }
}

function writePersisted(scope: string, participants: Record<string, RoomAiParticipant>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const entries = Object.entries(participants)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_PARTICIPANTS);
    localStorage.setItem(storageKey(scope), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore storage quota failures */
  }
}

/**
 * 解析新加入房间的 AI 默认工作区；优先匹配真实项目目录，再兜底管家工作区，避免房间组件耦合内部路径。
 */
export function resolveDefaultParticipantWorkspace(): string {
  return resolvePreferredProjectWorkspace();
}

interface RoomAiParticipantsState {
  accountScope: string;
  hydrated: boolean;
  participants: Record<string, RoomAiParticipant>;
  hydrate: (force?: boolean) => void;
  enrollRoom: (input: EnrollRoomAiInput) => RoomAiParticipant;
  enrollFromDrag: (
    targetRid: string,
    isDiscussion: boolean,
    payload: AiParticipantDragPayload,
  ) => RoomAiParticipant;
  updateParticipant: (
    rid: string,
    patch: Partial<RoomAiParticipant>,
  ) => RoomAiParticipant | undefined;
  toggleSeat: (rid: string, seatId: string) => void;
  upsertSeat: (rid: string, seat: RoomAiSeat) => void;
  upgradeToRoundtable: (rid: string) => RoomAiParticipant | undefined;
  removeParticipant: (rid: string) => void;
  getActiveParticipant: (rid: string) => RoomAiParticipant | undefined;
}

export const useRoomAiParticipants = create<RoomAiParticipantsState>((set, get) => ({
  accountScope: 'default',
  hydrated: false,
  participants: {},

  hydrate: (force = false) => {
    const scope = resolveButlerAccountScope();
    if (!force && get().hydrated && get().accountScope === scope) return;
    set({
      accountScope: scope,
      hydrated: true,
      participants: readPersisted(scope),
    });
  },

  enrollRoom: (input) => {
    get().hydrate();
    const now = Date.now();
    const existing = get().participants[input.rid];
    const resolvedWorkspace = input.workspaceRoot || existing?.workspaceRoot || resolveDefaultParticipantWorkspace();
    const entry: RoomAiParticipant = {
      rid: input.rid,
      isDiscussion: input.isDiscussion,
      mode: input.mode ?? existing?.mode ?? 'solo',
      seats: input.seats ?? existing?.seats,
      agentKind: input.agentKind,
      agentId: input.agentId,
      agentName: input.agentName,
      replyPolicy: input.replyPolicy ?? (input.isDiscussion ? 'every_message' : 'mention_only'),
      enabled: input.enabled ?? true,
      threadId: input.threadId ?? existing?.threadId,
      acpSessionKey: input.acpSessionKey ?? existing?.acpSessionKey,
      workspaceRoot: resolvedWorkspace || undefined,
      originDiscussionRid: input.originDiscussionRid ?? existing?.originDiscussionRid,
      originDiscussionName: input.originDiscussionName ?? existing?.originDiscussionName,
      latestDecisionSummary: input.latestDecisionSummary ?? existing?.latestDecisionSummary,
      linkedCardId: input.linkedCardId ?? existing?.linkedCardId,
      linkedGithubIssue: input.linkedGithubIssue ?? existing?.linkedGithubIssue,
      lastProcessedMessageId: existing?.lastProcessedMessageId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = { ...get().participants, [input.rid]: entry };
    writePersisted(get().accountScope, next);
    set({ participants: next });
    return entry;
  },

  enrollFromDrag: (targetRid, isDiscussion, payload) => {
    const existing = get().participants[targetRid];
    const originParticipant = payload.discussionRid
      ? get().participants[payload.discussionRid]
      : undefined;
    const carryContext = payload.discussionRid && payload.discussionRid !== targetRid;
    return get().enrollRoom({
      rid: targetRid,
      isDiscussion,
      mode: payload.mode ?? existing?.mode ?? 'solo',
      seats: payload.seats ?? existing?.seats,
      agentKind: payload.agentKind,
      agentId: payload.agentId,
      agentName: payload.agentName,
      replyPolicy: isDiscussion ? 'every_message' : 'mention_only',
      enabled: true,
      threadId: payload.threadId ?? existing?.threadId,
      acpSessionKey: payload.acpSessionKey ?? existing?.acpSessionKey,
      workspaceRoot: payload.workspaceRoot || existing?.workspaceRoot,
      originDiscussionRid: carryContext ? payload.discussionRid : existing?.originDiscussionRid,
      originDiscussionName: carryContext ? payload.discussionName : existing?.originDiscussionName,
      latestDecisionSummary: payload.decisionSummary ?? existing?.latestDecisionSummary,
      linkedCardId: originParticipant?.linkedCardId ?? existing?.linkedCardId,
      linkedGithubIssue: originParticipant?.linkedGithubIssue ?? existing?.linkedGithubIssue,
    });
  },

  updateParticipant: (rid, patch) => {
    get().hydrate();
    const current = get().participants[rid];
    if (!current) return undefined;
    const updated: RoomAiParticipant = {
      ...current,
      ...patch,
      rid,
      updatedAt: Date.now(),
    };
    const next = { ...get().participants, [rid]: updated };
    writePersisted(get().accountScope, next);
    set({ participants: next });
    return updated;
  },

  toggleSeat: (rid, seatId) => {
    const current = get().participants[rid];
    if (!current?.seats?.length) return;
    const nextSeats = current.seats.map((seat) =>
      seat.seatId === seatId ? { ...seat, enabled: !seat.enabled } : seat,
    );
    get().updateParticipant(rid, { seats: nextSeats });
  },

  upsertSeat: (rid, seat) => {
    const current = get().participants[rid];
    if (!current) return;
    const existing = current.seats ?? [];
    const found = existing.some((s) => s.seatId === seat.seatId);
    const nextSeats = found
      ? existing.map((s) => (s.seatId === seat.seatId ? seat : s))
      : [...existing, seat];
    get().updateParticipant(rid, { seats: nextSeats });
  },

  upgradeToRoundtable: (rid) => {
    const current = get().participants[rid];
    if (!current) return undefined;
    const seats =
      current.seats && current.seats.length > 0
        ? current.seats
        : createDefaultRoundtableSeats({
            kind: current.agentKind,
            id: current.agentId,
            name: current.agentName,
          });
    return get().updateParticipant(rid, {
      mode: 'roundtable',
      agentName: t('chat.aiParticipant.roundtableBadgeName'),
      seats,
      enabled: true,
    });
  },

  removeParticipant: (rid) => {
    get().hydrate();
    if (!get().participants[rid]) return;
    const next = { ...get().participants };
    delete next[rid];
    writePersisted(get().accountScope, next);
    set({ participants: next });
  },

  getActiveParticipant: (rid) => {
    get().hydrate();
    const p = get().participants[rid];
    return p?.enabled ? p : undefined;
  },
}));
