import { create } from 'zustand';
import { t } from '../i18n';
import { AcpController, type AcpControllerOptions } from '../agent/acp/AcpController';
import { expireDisconnectedAcpPermissions, readAcpPermissionJournal, writeAcpPermissionJournal, type AcpPermissionJournalEntry } from '../agent/acp/permissionJournal';
import type {
  AcpAvailableCommand,
  AcpContentBlock,
  AcpPermissionOption,
  AcpPlanEntry,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionModelState,
  AcpSessionModeState,
  AcpSessionUpdate,
  AcpToolCall,
  AcpToolCallUpdate,
} from '../agent/acp/acpTypes';
import { agentDeviceId } from '../agent/device';
import { getAcpHostBridge } from '../agent/acp/acpHostBridge';
import { matchesAcpWorkSession } from '../agent/sessionAdapter';
import { workContextPathKey } from '../lib/workContext';
import { LOCAL_ACCOUNT_OWNER } from '../lib/accountScope';
import { isTauriRuntime } from '../lib/http';
import {
  acpAgentDelete,
  acpAgentDiscover,
  acpAgentList,
  acpAgentProbe,
  acpAgentUpsert,
  acpLocalSessionMessages,
  acpLocalSessionHandoff,
  acpLocalSessionsDiscover,
  createGitCheckpoint,
  type AcpAgentPreset,
  type AcpAgentProbeResult,
  type AcpAgentProfile,
  type AcpAgentUpsertInput,
  type AcpDiscoveredCandidate,
  type DiscoveredLocalSession,
  type NativeResumeAuthorization,
  type WorkCardAutonomyMode,
} from '../platform/desktopCommands';

const resolveButlerAccountScope = (): string => getAcpHostBridge().resolveAccountScope();

const FALLBACK_AGENTS_PREFIX = 'rcx-acp-agents-v1';

export interface AcpPresetTemplate {
  preset: AcpAgentPreset;
  name: string;
  command: string;
  args: string[];
  badge?: string;
  transportLabel?: string;
  description: string;
  defaultAutoApproveSafeReads: boolean;
}

export const ACP_PRESET_TEMPLATES: readonly AcpPresetTemplate[] = [
  {
    preset: 'codex-acp',
    name: 'Codex CLI',
    command: 'codex',
    args: ['--rocketx-acp-bridge=codex'],
    get badge() { return t('agent.acpPreset.badge.recommended'); },
    get transportLabel() { return t('agent.acpPreset.transport.bridge'); },
    get description() { return t('agent.acpPreset.codex.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'antigravity',
    name: 'Google Antigravity',
    command: 'agy',
    args: ['--rocketx-acp-bridge=antigravity'],
    get badge() { return t('agent.acpPreset.badge.ideAgent'); },
    get transportLabel() { return t('agent.acpPreset.transport.bridge'); },
    get description() { return t('agent.acpPreset.antigravity.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: ['--rocketx-acp-bridge=claude'],
    badge: 'Anthropic',
    get transportLabel() { return t('agent.acpPreset.transport.bridge'); },
    get description() { return t('agent.acpPreset.claude.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'kimi-cli',
    name: 'Kimi Code (ACP)',
    command: 'kimi',
    args: ['acp'],
    badge: 'Moonshot',
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.kimi.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'copilot-cli',
    name: 'GitHub Copilot (ACP)',
    command: 'copilot',
    args: ['--acp'],
    badge: 'GitHub',
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.copilot.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'gemini-cli',
    name: 'Gemini CLI (ACP)',
    command: 'gemini',
    args: ['--experimental-acp'],
    badge: 'Google',
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.gemini.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'opencode',
    name: 'OpenCode (ACP)',
    command: 'opencode',
    args: ['acp'],
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.opencode.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'goose',
    name: 'Goose (ACP)',
    command: 'goose',
    args: ['acp'],
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.goose.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'qwen-code',
    name: 'Qwen Code (ACP)',
    command: 'qwen',
    args: ['--acp'],
    badge: 'Alibaba',
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.qwen.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'dsh',
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['--rocketx-acp-bridge=dsh'],
    badge: 'DeepSeek',
    get transportLabel() { return t('agent.acpPreset.transport.bridge'); },
    get description() { return t('agent.acpPreset.dsh.desc'); },
    defaultAutoApproveSafeReads: true,
  },
  {
    preset: 'custom',
    get name() { return t('agent.acpPreset.custom.name'); },
    command: '',
    args: [],
    get transportLabel() { return t('agent.acpPreset.transport.native'); },
    get description() { return t('agent.acpPreset.custom.desc'); },
    defaultAutoApproveSafeReads: false,
  },
];

export interface AcpChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thoughts?: string;
  timestamp: number;
}

export interface AcpPendingPermissionRequest {
  requestId: string;
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
  reason: string;
  createdAt: number;
}

export type AcpSessionLifecycleStatus =
  | 'connecting'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'stopped'
  | 'error';

export interface AcpManagedSessionState {
  /** Real executor identity; acpSessionId remains the live RPC address. */
  nativeSessionId?: string;
  nativeIdentityPending?: boolean;
  accountScope?: string;
  sourceScope?: string;
  nativeHandoff?: boolean;
  sessionKey: string;
  agentId: string;
  agentName: string;
  preset: string;
  acpSessionId: string;
  title: string;
  workspaceRoot: string;
  linkedTodoId: string | null;
  autonomyMode: WorkCardAutonomyMode;
  status: AcpSessionLifecycleStatus;
  connectionReady?: boolean;
  error: string | null;
  modes: AcpSessionModeState | null;
  models: AcpSessionModelState | null;
  queuedPrompts?: Array<{ id: string; text: string }>;
  availableCommands: AcpAvailableCommand[];
  plan: AcpPlanEntry[];
  messages: AcpChatMessage[];
  streamingText: string;
  streamingThought: string;
  toolCalls: AcpToolCall[];
  pendingPermissions: AcpPendingPermissionRequest[];
  stderrLogs: string[];
  lastStopReason: string | null;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AcpPermissionEvaluation {
  decision: 'allow' | 'reject' | 'prompt';
  optionId?: string;
  reason: string;
}

const SAFE_READ_KINDS = new Set(['read', 'search', 'think']);
const UNSAFE_TITLE_PATTERN =
  /\b(write|edit|delete|remove|rm|unlink|exec|run|bash|shell|powershell|terminal|curl|wget|fetch|push|commit|install|chmod)\b/i;

function pickPermissionOption(
  options: readonly AcpPermissionOption[],
  preferredKinds: readonly AcpPermissionOption['kind'][],
): AcpPermissionOption | undefined {
  for (const kind of preferredKinds) {
    const match = options.find((opt) => opt.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/**
 * 根据自主策略评估 ACP 代理发起的权限请求：
 * - `'readonly'`：一律自动拒绝
 * - `'autonomous'`：工作区只读/检索类操作自动放行；写操作、终端执行与外部请求仍需用户审批
 * - `'confirm'`：进入交互式人工审批队列
 */
export function evaluateAcpPermissionPolicy(
  autonomyMode: WorkCardAutonomyMode,
  request: AcpRequestPermissionParams,
): AcpPermissionEvaluation {
  if (autonomyMode === 'readonly') {
    const rejectOpt = pickPermissionOption(request.options, ['reject_always', 'reject_once']);
    return {
      decision: 'reject',
      optionId: rejectOpt?.optionId,
      reason: t('agent.acp.perm.readonlyRejected'),
    };
  }

  if (autonomyMode === 'autonomous') {
    const kind = request.toolCall.kind ?? 'other';
    const title = request.toolCall.title ?? '';
    const isSafeRead =
      SAFE_READ_KINDS.has(kind) && !UNSAFE_TITLE_PATTERN.test(title);
    if (isSafeRead) {
      const allowOpt = pickPermissionOption(request.options, ['allow_once', 'allow_always']);
      if (allowOpt) {
        return {
          decision: 'allow',
          optionId: allowOpt.optionId,
          reason: t('agent.acp.perm.autonomousAllowed'),
        };
      }
    }
    return {
      decision: 'prompt',
      reason: t('agent.acp.perm.needsConfirm', { kind, titlePart: title ? `: ${title}` : '' }),
    };
  }

  return {
    decision: 'prompt',
    reason: t('agent.acp.perm.confirmMode'),
  };
}

function normalizeComparePath(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isCandidateMatchedByAgent(
  candidate: AcpDiscoveredCandidate,
  agent: AcpAgentProfile,
): boolean {
  if (candidate.preset !== 'custom' && agent.preset === candidate.preset) {
    return true;
  }
  const agentCmd = normalizeComparePath(agent.command);
  if (!agentCmd) return false;
  return (
    agentCmd === normalizeComparePath(candidate.command) ||
    agentCmd === normalizeComparePath(candidate.resolvedPath)
  );
}

function markDiscoveredRegistered(
  discovered: AcpDiscoveredCandidate[],
  agents: AcpAgentProfile[],
): AcpDiscoveredCandidate[] {
  if (discovered.length === 0 || agents.length === 0) return discovered;
  return discovered.map((candidate) => {
    if (candidate.alreadyRegistered) return candidate;
    return agents.some((agent) => isCandidateMatchedByAgent(candidate, agent))
      ? { ...candidate, alreadyRegistered: true }
      : candidate;
  });
}

function fallbackStorageKey(): string {
  const scope = resolveButlerAccountScope() || LOCAL_ACCOUNT_OWNER;
  return `${FALLBACK_AGENTS_PREFIX}:${scope}`;
}

function loadFallbackAgents(): AcpAgentProfile[] {
  try {
    const raw = localStorage.getItem(fallbackStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AcpAgentProfile[]) : [];
  } catch {
    return [];
  }
}

function saveFallbackAgents(agents: AcpAgentProfile[]): void {
  try {
    localStorage.setItem(fallbackStorageKey(), JSON.stringify(agents));
  } catch {
    /* ignore storage quota */
  }
}

function extractTextFromContent(block: AcpContentBlock | undefined): string {
  if (!block) return '';
  if (block.type === 'text') return block.text;
  if (block.type === 'resource' && block.resource.text) return block.resource.text;
  if (block.type === 'resource_link') return `[${block.name}](${block.uri})`;
  return '';
}

async function syncAcpSessionToLedger(session: AcpManagedSessionState): Promise<void> {
  await getAcpHostBridge().syncSessionToLedger({
    agentId: session.agentId,
    agentName: session.agentName,
    preset: session.preset,
    autonomyMode: session.autonomyMode,
    title: session.title,
    workspaceRoot: session.workspaceRoot,
    acpSessionId: session.acpSessionId,
    nativeSessionId: session.nativeSessionId,
    sourceScope: session.sourceScope,
    accountScope: session.accountScope,
    linkedTodoId: session.linkedTodoId,
    status: session.status,
    connectionReady: session.connectionReady,
    turnCount: session.turnCount,
    modesCurrentModeId: session.modes?.currentModeId ?? null,
    lastTurnId: session.messages.at(-1)?.id ?? null,
    nativeIdentityPending: session.nativeIdentityPending,
  });
}

function mergeToolCallUpdate(
  existing: AcpToolCall[],
  update: AcpToolCallUpdate,
): AcpToolCall[] {
  const idx = existing.findIndex((t) => t.toolCallId === update.toolCallId);
  if (idx < 0) {
    return [
      ...existing,
      {
        toolCallId: update.toolCallId,
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? undefined,
        status: update.status ?? 'pending',
        content: update.content ?? undefined,
        locations: update.locations ?? undefined,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      },
    ];
  }
  const prev = existing[idx];
  const merged: AcpToolCall = {
    ...prev,
    ...(update.title != null ? { title: update.title } : {}),
    ...(update.kind != null ? { kind: update.kind } : {}),
    ...(update.status != null ? { status: update.status } : {}),
    ...(update.content != null ? { content: update.content } : {}),
    ...(update.locations != null ? { locations: update.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  };
  return existing.map((item, i) => (i === idx ? merged : item));
}

export interface StartAcpSessionInput {
  agentId: string;
  workspaceRoot: string;
  linkedTodoId?: string | null;
  autonomyMode?: WorkCardAutonomyMode;
  title?: string;
  controllerFactory?: (options: AcpControllerOptions) => AcpController;
}

export interface LoadAcpSessionInput extends StartAcpSessionInput {
  sessionId: string;
  initialMessages?: AcpChatMessage[];
  nativeResume?: NativeResumeAuthorization;
}

export interface ResumeLocalSessionInput {
  provider: string;
  preset: string;
  nativeSessionId: string;
  title?: string;
  workspaceRoot: string;
  sourcePath?: string | null;
  linkedTodoId?: string | null;
  sourceScope?: string;
  executionProfileId?: string | null;
  handoffConfirmed?: boolean;
}

export interface SendAcpPromptOptions {
  injectMemory?: boolean;
  steer?: boolean;
}

export interface AcpAgentsState {
  expiredPermissions: AcpPermissionJournalEntry[];
  agents: AcpAgentProfile[];
  discovered: AcpDiscoveredCandidate[];
  localSessions: DiscoveredLocalSession[];
  probes: Record<string, AcpAgentProbeResult>;
  sessions: Record<string, AcpManagedSessionState>;
  activeSessionKey: string | null;
  loading: boolean;
  discovering: boolean;
  discoveringLocalSessions: boolean;
  lastError: string | null;

  hydrate: () => Promise<void>;
  discoverLocalAgents: () => Promise<AcpDiscoveredCandidate[]>;
  discoverLocalSessions: (limit?: number) => Promise<DiscoveredLocalSession[]>;
  adoptAllDiscoveredAgents: () => Promise<AcpAgentProfile[]>;
  upsertAgent: (input: AcpAgentUpsertInput) => Promise<AcpAgentProfile>;
  removeAgent: (id: string) => Promise<boolean>;
  probeAgent: (id: string) => Promise<AcpAgentProbeResult>;
  startSession: (input: StartAcpSessionInput) => Promise<AcpManagedSessionState>;
  loadSession: (input: LoadAcpSessionInput) => Promise<AcpManagedSessionState>;
  resumeLocalSession: (input: ResumeLocalSessionInput) => Promise<AcpManagedSessionState>;
  sendPrompt: (
    sessionKey: string,
    text: string,
    options?: SendAcpPromptOptions,
  ) => Promise<{ stopReason: string }>;
  cancelTurn: (sessionKey: string) => Promise<void>;
  setMode: (sessionKey: string, modeId: string) => Promise<void>;
  setModel: (sessionKey: string, modelId: string) => Promise<void>;
  enqueuePrompt: (sessionKey: string, text: string) => string;
  removeQueuedPrompt: (sessionKey: string, queueId: string) => void;
  resolvePermission: (
    sessionKey: string,
    requestId: string,
    optionId: string | null,
  ) => Promise<void>;
  stopSession: (sessionKey: string) => Promise<void>;
  setActiveSession: (sessionKey: string | null) => void;
}

const controllers = new Map<string, AcpController>();
const activePrompts = new Map<string, Promise<{ stopReason: string }>>();
const permissionResolvers = new Map<
  string,
  { resolve: (result: AcpRequestPermissionResult) => void; sessionKey: string; accountScope: string; nativeSessionId: string; turnCount: number; expiresAt: number; controller: AcpController; timer: ReturnType<typeof setTimeout> }
>();

function removePermissionRecord(requestId: string, scope: string): void {
  writeAcpPermissionJournal(scope, readAcpPermissionJournal(scope).filter((entry) => entry.requestId !== requestId));
}

function applySessionUpdate(
  session: AcpManagedSessionState,
  update: AcpSessionUpdate,
): AcpManagedSessionState {
  const now = Date.now();
  switch (update.sessionUpdate) {
    case 'rocketx_native_session': {
      if (!update.nativeSessionId.trim() || update.nativeSessionId.startsWith('acp-bridge-')
        || workContextPathKey(update.workspaceRoot) !== workContextPathKey(session.workspaceRoot)
        || (session.sourceScope && session.sourceScope !== update.sourceScope)) {
        return { ...session, status: 'error', error: t('agent.acp.error.identityMismatch'), updatedAt: now };
      }
      if (session.nativeSessionId && session.nativeSessionId !== update.nativeSessionId) {
        return { ...session, status: 'error', error: t('agent.acp.error.differentNativeSession'), updatedAt: now };
      }
      return { ...session, nativeSessionId: update.nativeSessionId, nativeIdentityPending: false, sourceScope: update.sourceScope, updatedAt: now };
    }
    case 'agent_message_chunk': {
      const chunk = extractTextFromContent(update.content);
      return {
        ...session,
        streamingText: session.streamingText + chunk,
        updatedAt: now,
      };
    }
    case 'agent_thought_chunk': {
      const chunk = extractTextFromContent(update.content);
      return {
        ...session,
        streamingThought: session.streamingThought + chunk,
        updatedAt: now,
      };
    }
    case 'user_message_chunk': {
      const text = extractTextFromContent(update.content);
      if (!text) return session;
      return {
        ...session,
        messages: [
          ...session.messages,
          {
            id: `u:${now}:${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            text,
            timestamp: now,
          },
        ],
        updatedAt: now,
      };
    }
    case 'tool_call':
      return {
        ...session,
        toolCalls: mergeToolCallUpdate(session.toolCalls, update),
        updatedAt: now,
      };
    case 'tool_call_update':
      return {
        ...session,
        toolCalls: mergeToolCallUpdate(session.toolCalls, update),
        updatedAt: now,
      };
    case 'plan':
      return {
        ...session,
        plan: update.entries,
        updatedAt: now,
      };
    case 'current_mode_update':
      return {
        ...session,
        modes: session.modes
          ? { ...session.modes, currentModeId: update.currentModeId }
          : { currentModeId: update.currentModeId, availableModes: [] },
        updatedAt: now,
      };
    case 'available_commands_update':
      return {
        ...session,
        availableCommands: update.availableCommands,
        updatedAt: now,
      };
    default:
      return session;
  }
}

export const useAcpAgents = create<AcpAgentsState>((set, get) => {
  const updateSession = (
    sessionKey: string,
    updater: (prev: AcpManagedSessionState) => AcpManagedSessionState,
  ) => {
    set((state) => {
      const existing = state.sessions[sessionKey];
      if (!existing) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionKey]: updater(existing),
        },
      };
    });
  };

  const buildControllerForSession = (
    sessionKey: string,
    agent: AcpAgentProfile,
    workspaceRoot: string,
    autonomyMode: WorkCardAutonomyMode,
    controllerFactory?: (options: AcpControllerOptions) => AcpController,
    nativeResume?: NativeResumeAuthorization,
  ): AcpController => {
    const controllerOpts: AcpControllerOptions = {
      nativeResume,
      agentId: agent.id,
      workspaceRoot,
      onSessionUpdate: ({ update }) => {
        updateSession(sessionKey, (prev) => applySessionUpdate(prev, update));
        if (update.sessionUpdate === 'rocketx_native_session') {
          const current = get().sessions[sessionKey];
          if (current?.nativeSessionId) void syncAcpSessionToLedger(current).catch(() => undefined);
        }
      },
      onStderr: (line) => {
        updateSession(sessionKey, (prev) => ({
          ...prev,
          stderrLogs: [...prev.stderrLogs.slice(-99), line],
          updatedAt: Date.now(),
        }));
      },
      onExit: (code, reason) => {
        controllers.delete(sessionKey);
        for (const [reqId, pending] of permissionResolvers.entries()) {
          if (pending.sessionKey === sessionKey) {
            clearTimeout(pending.timer);
            permissionResolvers.delete(reqId);
            pending.resolve({ outcome: { outcome: 'cancelled' } });
          }
        }
        set({ expiredPermissions: expireDisconnectedAcpPermissions(resolveButlerAccountScope(), new Set(permissionResolvers.keys())) });
        updateSession(sessionKey, (prev) => ({
          ...prev,
          status: code === 0 || prev.status === 'stopped' ? 'stopped' : 'error',
          connectionReady: false,
          error: code === 0 || prev.status === 'stopped' ? prev.error : (reason ?? t('agent.acp.error.processExited', { code: code ?? '' })),
          pendingPermissions: [],
          updatedAt: Date.now(),
        }));
        const latest = get().sessions[sessionKey];
        if (latest) {
          void syncAcpSessionToLedger(latest).catch(() => undefined);
        }
      },
    };

    const controller = controllerFactory
      ? controllerFactory(controllerOpts)
      : new AcpController(controllerOpts);

    controller.setHostHandlers({
      requestPermission: async (params) => {
        const currentSession = get().sessions[sessionKey];
        if (!currentSession || currentSession.acpSessionId !== params.sessionId || controllers.get(sessionKey) !== controller) {
          return { outcome: { outcome: 'cancelled' } };
        }
        const effectiveAutonomy = currentSession?.autonomyMode ?? autonomyMode;
        const evaluation = evaluateAcpPermissionPolicy(effectiveAutonomy, params);

        if (evaluation.decision === 'allow' && evaluation.optionId) {
          return {
            outcome: { outcome: 'selected', optionId: evaluation.optionId },
          };
        }
        if (evaluation.decision === 'reject') {
          return evaluation.optionId
            ? { outcome: { outcome: 'selected', optionId: evaluation.optionId } }
            : { outcome: { outcome: 'cancelled' } };
        }

        const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const pendingItem: AcpPendingPermissionRequest = {
          requestId,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options,
          reason: evaluation.reason,
          createdAt: Date.now(),
        };

        return new Promise<AcpRequestPermissionResult>((resolve) => {
          const accountScope = resolveButlerAccountScope();
          const expiresAt = Date.now() + 10 * 60_000;
          const timer = setTimeout(() => {
            const pending = permissionResolvers.get(requestId);
            if (!pending) return;
            permissionResolvers.delete(requestId);
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            updateSession(sessionKey, (prev) => ({ ...prev, pendingPermissions: prev.pendingPermissions.filter((entry) => entry.requestId !== requestId), error: t('agent.acp.error.permTimeout'), updatedAt: Date.now() }));
            set({ expiredPermissions: expireDisconnectedAcpPermissions(accountScope, new Set(permissionResolvers.keys())) });
          }, 10 * 60_000);
          permissionResolvers.set(requestId, { resolve, sessionKey, accountScope, nativeSessionId: params.sessionId, turnCount: currentSession.turnCount, expiresAt, controller, timer });
          writeAcpPermissionJournal(accountScope, [...readAcpPermissionJournal(accountScope), { requestId, sessionKey, nativeSessionId: params.sessionId, agentId: agent.id, workspaceRoot, title: currentSession.title, accountScope, turnCount: currentSession.turnCount, createdAt: pendingItem.createdAt, expiresAt, status: 'pending' }]);
          updateSession(sessionKey, (prev) => ({
            ...prev,
            status: 'waiting_approval',
            pendingPermissions: [...prev.pendingPermissions, pendingItem],
            updatedAt: Date.now(),
          }));
          const latest = get().sessions[sessionKey];
          if (latest) {
            void syncAcpSessionToLedger(latest).catch(() => undefined);
          }
        });
      },
    });

    return controller;
  };

  return {
    expiredPermissions: [],
    agents: isTauriRuntime() ? [] : loadFallbackAgents(),
    discovered: [],
    localSessions: [],
    probes: {},
    sessions: {},
    activeSessionKey: null,
    loading: false,
    discovering: false,
    discoveringLocalSessions: false,
    lastError: null,

    hydrate: async () => {
      set({ expiredPermissions: expireDisconnectedAcpPermissions(resolveButlerAccountScope(), new Set(permissionResolvers.keys())) });
      if (!isTauriRuntime()) {
        set({ agents: loadFallbackAgents(), loading: false, lastError: null });
        return;
      }
      set({ loading: true, lastError: null });
      try {
        const agents = await acpAgentList();
        set((state) => ({
          agents,
          discovered: markDiscoveredRegistered(state.discovered, agents),
          loading: false,
          lastError: null,
        }));
        if (!get().discovering && get().discovered.length === 0) {
          void get().discoverLocalAgents();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ loading: false, lastError: message });
      }
    },

    discoverLocalAgents: async () => {
      if (!isTauriRuntime()) {
        set({ discovered: [], discovering: false });
        return [];
      }
      set({ discovering: true, lastError: null });
      try {
        const discovered = await acpAgentDiscover();
        set((state) => ({
          discovered: markDiscoveredRegistered(discovered, state.agents),
          discovering: false,
          lastError: null,
        }));
        return get().discovered;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ discovering: false, lastError: message });
        return [];
      }
    },

    discoverLocalSessions: async (limit = 120) => {
      if (!isTauriRuntime()) {
        set({ localSessions: [], discoveringLocalSessions: false });
        return [];
      }
      set({ discoveringLocalSessions: true });
      try {
        const localSessions = await acpLocalSessionsDiscover(limit);
        set({ localSessions, discoveringLocalSessions: false });
        return localSessions;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ discoveringLocalSessions: false, lastError: message });
        return [];
      }
    },

    adoptAllDiscoveredAgents: async () => {
      const currentDiscovered =
        get().discovered.length > 0 || !isTauriRuntime()
          ? get().discovered
          : await get().discoverLocalAgents();
      const pending = currentDiscovered.filter((candidate) => !candidate.alreadyRegistered);
      if (pending.length === 0) {
        return [];
      }

      const adopted: AcpAgentProfile[] = [];
      for (const candidate of pending) {
        const alreadyExists = get().agents.some((agent) =>
          isCandidateMatchedByAgent(candidate, agent),
        );
        if (alreadyExists) {
          continue;
        }
        const tpl = ACP_PRESET_TEMPLATES.find((item) => item.preset === candidate.preset);
        const saved = await get().upsertAgent({
          name: candidate.name,
          preset: candidate.preset,
          command: candidate.resolvedPath || candidate.command,
          args: candidate.args,
          enabled: true,
          autoApproveSafeReads: tpl?.defaultAutoApproveSafeReads ?? true,
          description: candidate.version
            ? t('agent.acp.notes.detectedWithVersion', { version: candidate.version })
            : t('agent.acp.notes.detected'),
        });
        adopted.push(saved);
      }

      set((state) => ({
        discovered: markDiscoveredRegistered(state.discovered, state.agents),
        lastError: null,
      }));
      if (isTauriRuntime()) {
        void get().discoverLocalAgents();
      }
      return adopted;
    },

    upsertAgent: async (input) => {
      if (isTauriRuntime()) {
        const saved = await acpAgentUpsert(input);
        set((state) => {
          const exists = state.agents.some((a) => a.id === saved.id);
          const agents = exists
            ? state.agents.map((a) => (a.id === saved.id ? saved : a))
            : [...state.agents, saved];
          return {
            agents,
            discovered: markDiscoveredRegistered(state.discovered, agents),
            lastError: null,
          };
        });
        return saved;
      }

      const now = Date.now();
      const current = get().agents;
      const existing = input.id ? current.find((a) => a.id === input.id) : undefined;
      const envKeys = new Set(existing?.envKeys ?? []);
      if (input.env) {
        for (const k of Object.keys(input.env)) envKeys.add(k);
      }
      if (input.clearEnvKeys) {
        for (const k of input.clearEnvKeys) envKeys.delete(k);
      }

      const saved: AcpAgentProfile = {
        id: existing?.id ?? input.id ?? `acp-${crypto.randomUUID().slice(0, 8)}`,
        name: input.name.trim(),
        preset: input.preset,
        command: input.command.trim(),
        args: input.args ?? existing?.args ?? [],
        cwd: input.cwd !== undefined ? input.cwd : (existing?.cwd ?? null),
        envKeys: Array.from(envKeys),
        enabled: input.enabled ?? existing?.enabled ?? true,
        autoApproveSafeReads:
          input.autoApproveSafeReads ?? existing?.autoApproveSafeReads ?? true,
        description:
          input.description !== undefined
            ? input.description
            : (existing?.description ?? null),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = existing
        ? current.map((a) => (a.id === saved.id ? saved : a))
        : [...current, saved];
      saveFallbackAgents(next);
      set((state) => ({
        agents: next,
        discovered: markDiscoveredRegistered(state.discovered, next),
        lastError: null,
      }));
      return saved;
    },

    removeAgent: async (id) => {
      const updateDiscoveredAfterRemoval = (
        discovered: AcpDiscoveredCandidate[],
        removedAgent: AcpAgentProfile | undefined,
        remaining: AcpAgentProfile[],
      ): AcpDiscoveredCandidate[] => {
        if (!removedAgent || discovered.length === 0) return discovered;
        return discovered.map((candidate) =>
          isCandidateMatchedByAgent(candidate, removedAgent) &&
          !remaining.some((agent) => isCandidateMatchedByAgent(candidate, agent))
            ? { ...candidate, alreadyRegistered: false }
            : candidate,
        );
      };

      if (isTauriRuntime()) {
        const removed = await acpAgentDelete(id);
        if (removed) {
          set((state) => {
            const removedAgent = state.agents.find((a) => a.id === id);
            const remaining = state.agents.filter((a) => a.id !== id);
            return {
              agents: remaining,
              discovered: updateDiscoveredAfterRemoval(
                state.discovered,
                removedAgent,
                remaining,
              ),
              lastError: null,
            };
          });
        }
        return removed;
      }
      const current = get().agents;
      const removedAgent = current.find((a) => a.id === id);
      const next = current.filter((a) => a.id !== id);
      if (next.length === current.length) return false;
      saveFallbackAgents(next);
      set((state) => ({
        agents: next,
        discovered: updateDiscoveredAfterRemoval(state.discovered, removedAgent, next),
        lastError: null,
      }));
      return true;
    },

    probeAgent: async (id) => {
      if (!isTauriRuntime()) {
        const result: AcpAgentProbeResult = {
          agentId: id,
          ready: false,
          resolvedPath: null,
          version: null,
          reason: t('agent.acp.error.desktopOnly'),
        };
        set((state) => ({ probes: { ...state.probes, [id]: result } }));
        return result;
      }
      const result = await acpAgentProbe(id);
      set((state) => ({ probes: { ...state.probes, [id]: result } }));
      return result;
    },

    startSession: async (input) => {
      const agent = get().agents.find((a) => a.id === input.agentId);
      if (!agent) {
        throw new Error(t('agent.acp.error.agentNotFound', { agentId: input.agentId }));
      }
      if (!agent.enabled) {
        throw new Error(t('agent.acp.error.agentDisabled', { name: agent.name }));
      }
      const workspaceRoot = input.workspaceRoot.trim();
      if (!workspaceRoot) {
        throw new Error(t('agent.acp.error.startWorkspaceRequired'));
      }

      const autonomyMode: WorkCardAutonomyMode =
        input.autonomyMode ?? (agent.autoApproveSafeReads ? 'autonomous' : 'confirm');
      const tempKey = `acp:${agent.id}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
      const now = Date.now();
      const title = input.title?.trim() || `${agent.name} · ${workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || workspaceRoot}`;

      const initialSession: AcpManagedSessionState = {
        sessionKey: tempKey,
        accountScope: resolveButlerAccountScope(),
        sourceScope: agent.sourceScope ?? undefined,
        agentId: agent.id,
        agentName: agent.name,
        preset: agent.preset,
        acpSessionId: '',
        title,
        workspaceRoot,
        linkedTodoId: input.linkedTodoId ?? null,
        autonomyMode,
        status: 'connecting',
        connectionReady: false,
        error: null,
        modes: null,
        models: null,
        availableCommands: [],
        plan: [],
        messages: [],
        streamingText: '',
        streamingThought: '',
        toolCalls: [],
        pendingPermissions: [],
        stderrLogs: [],
        lastStopReason: null,
        turnCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      set((state) => ({
        sessions: { ...state.sessions, [tempKey]: initialSession },
        activeSessionKey: tempKey,
      }));

      const controller = buildControllerForSession(
        tempKey,
        agent,
        workspaceRoot,
        autonomyMode,
        input.controllerFactory,
      );
      controllers.set(tempKey, controller);

      try {
        const res = await controller.newSession();
        updateSession(tempKey, (prev) => ({
          ...prev,
          acpSessionId: res.sessionId,
          nativeIdentityPending: res.sessionId.startsWith('acp-bridge-') && (agent.preset === 'codex-acp' || agent.sourceScope?.startsWith('codex:') || agent.args.some((arg) => arg.toLowerCase() === '--rocketx-acp-bridge=codex')),
          modes: res.modes ?? null,
          models: res.models ?? null,
          status: 'ready',
          connectionReady: true,
          error: null,
          updatedAt: Date.now(),
        }));
        const readySession = get().sessions[tempKey]!;
        await syncAcpSessionToLedger(readySession).catch(() => undefined);
        return readySession;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controllers.delete(tempKey);
        await controller.stop().catch(() => undefined);
        updateSession(tempKey, (prev) => ({
          ...prev,
          status: 'error',
          connectionReady: false,
          error: message,
          updatedAt: Date.now(),
        }));
        throw error;
      }
    },

    loadSession: async (input) => {
      const agent = get().agents.find((a) => a.id === input.agentId);
      if (!agent) {
        throw new Error(t('agent.acp.error.agentNotFound', { agentId: input.agentId }));
      }
      const workspaceRoot = input.workspaceRoot.trim();
      if (!workspaceRoot) {
        throw new Error(t('agent.acp.error.loadWorkspaceRequired'));
      }
      const autonomyMode: WorkCardAutonomyMode =
        input.autonomyMode ?? (agent.autoApproveSafeReads ? 'autonomous' : 'confirm');
      const sessionKey = `acp:${agent.id}:${input.sessionId}`;
      const now = Date.now();
      const existing = get().sessions[sessionKey];

      const initialMessages = input.initialMessages ?? [];
      const initialSession: AcpManagedSessionState = {
        ...(existing ?? {
          sessionKey,
          agentId: agent.id,
          agentName: agent.name,
          preset: agent.preset,
          acpSessionId: input.sessionId,
          title: input.title?.trim() || `${agent.name} · ${input.sessionId.slice(0, 8)}`,
          workspaceRoot,
          linkedTodoId: input.linkedTodoId ?? null,
          autonomyMode,
          modes: null,
          models: null,
          availableCommands: [],
          plan: [],
          messages: initialMessages,
          streamingText: '',
          streamingThought: '',
          toolCalls: [],
          pendingPermissions: [],
          stderrLogs: [],
          lastStopReason: null,
          turnCount: 0,
          createdAt: now,
        }),
        ...(existing && existing.messages.length === 0 && initialMessages.length > 0
          ? { messages: initialMessages }
          : {}),
        status: 'connecting',
        connectionReady: false,
        sourceScope: input.nativeResume?.sourceScope ?? existing?.sourceScope ?? agent.sourceScope ?? undefined,
        nativeHandoff: Boolean(input.nativeResume) || existing?.nativeHandoff,
        nativeSessionId: input.nativeResume?.sessionId ?? existing?.nativeSessionId,
        accountScope: input.nativeResume?.accountScope ?? existing?.accountScope ?? resolveButlerAccountScope(),
        error: null,
        updatedAt: now,
      };

      set((state) => ({
        sessions: { ...state.sessions, [sessionKey]: initialSession },
        activeSessionKey: sessionKey,
      }));

      const prevController = controllers.get(sessionKey);
      if (prevController) {
        await prevController.stop().catch(() => undefined);
      }

      const controller = buildControllerForSession(
        sessionKey,
        agent,
        workspaceRoot,
        autonomyMode,
        input.controllerFactory,
        input.nativeResume,
      );
      controllers.set(sessionKey, controller);

      try {
        const res = await controller.loadSession(input.sessionId);
        updateSession(sessionKey, (prev) => ({
          ...prev,
          acpSessionId: input.sessionId,
          modes: res.modes ?? prev.modes,
          models: res.models ?? prev.models,
          status: 'ready',
          connectionReady: true,
          error: null,
          updatedAt: Date.now(),
        }));
        const loaded = get().sessions[sessionKey]!;
        await syncAcpSessionToLedger(loaded).catch(() => undefined);
        return loaded;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controllers.delete(sessionKey);
        await controller.stop().catch(() => undefined);
        updateSession(sessionKey, (prev) => ({
          ...prev,
          status: 'error',
          connectionReady: false,
          error: message,
          updatedAt: Date.now(),
        }));
        await syncAcpSessionToLedger(get().sessions[sessionKey]!).catch(() => undefined);
        throw error;
      }
    },

    resumeLocalSession: async (input) => {
      const accountScope = resolveButlerAccountScope();
      const assertAccount = () => {
        if (resolveButlerAccountScope() !== accountScope) throw new Error(t('agent.superAgent.accountSwitchedHandoff'));
      };
      if (input.provider === 'codex' && !input.handoffConfirmed) {
        throw new Error(t('agent.acp.error.codexReadonly'));
      }
      const owned = Object.values(get().sessions).find((candidate) =>
        controllers.has(candidate.sessionKey) && candidate.status !== 'stopped' && candidate.status !== 'error'
        && matchesAcpWorkSession({ nativeSessionId: input.nativeSessionId, sourceScope: input.sourceScope, workspaceRoot: input.workspaceRoot, accountScope, configSnapshotJson: JSON.stringify({ executionProfileId: input.executionProfileId }) }, candidate, accountScope));
      if (owned) { set({ activeSessionKey: owned.sessionKey }); return owned; }
      if (isTauriRuntime() && get().agents.length === 0) {
        await get().hydrate();
        assertAccount();
      }

      if (input.executionProfileId && !get().agents.some((agent) => agent.id === input.executionProfileId && agent.enabled)) {
        throw new Error(t('agent.acp.error.profileMissingOrDisabled'));
      }
      let agent = input.executionProfileId
        ? get().agents.find((a) => a.id === input.executionProfileId && a.enabled)
        :
        get().agents.find((a) => a.preset === input.preset && a.enabled && (!input.sourceScope || a.sourceScope === input.sourceScope)) ??
        get().agents.find((a) => a.preset === input.preset);

      if (!agent) {
        let candidate = get().discovered.find((c) => c.preset === input.preset);
        if (!candidate && isTauriRuntime()) {
          const discovered = await get().discoverLocalAgents();
          assertAccount();
          candidate = discovered.find((c) => c.preset === input.preset);
        }

        if (candidate) {
          const tpl = ACP_PRESET_TEMPLATES.find((item) => item.preset === candidate.preset);
          agent = await get().upsertAgent({
            name: candidate.name,
            preset: candidate.preset,
            command: candidate.resolvedPath || candidate.command,
            args: candidate.args,
            enabled: true,
            autoApproveSafeReads: tpl?.defaultAutoApproveSafeReads ?? true,
            description: candidate.version
              ? t('agent.acp.notes.detectedWithVersion', { version: candidate.version })
              : t('agent.acp.notes.detected'),
          });
        } else {
          const tpl = ACP_PRESET_TEMPLATES.find((item) => item.preset === input.preset);
          if (!tpl) {
            throw new Error(t('agent.acp.error.providerNotFound', { provider: input.provider, preset: input.preset }));
          }
          agent = await get().upsertAgent({
            name: tpl.name,
            preset: tpl.preset,
            command: tpl.command,
            args: tpl.args,
            enabled: true,
            autoApproveSafeReads: tpl.defaultAutoApproveSafeReads,
            description: tpl.description,
          });
        }
      }

      assertAccount();
      const sessionKey = `acp:${agent.id}:${input.nativeSessionId}`;
      const existing = get().sessions[sessionKey];
      if (
        existing &&
        controllers.has(sessionKey) &&
        (existing.status === 'ready' ||
          existing.status === 'running' ||
          existing.status === 'waiting_approval' ||
          existing.status === 'connecting')
      ) {
        set({ activeSessionKey: sessionKey });
        return existing;
      }

      const workspaceRoot = input.workspaceRoot.trim() || agent.cwd?.trim() || '';
      if (!workspaceRoot) {
        throw new Error(t('agent.acp.error.resumeWorkspaceMissing'));
      }
      if (input.provider === 'codex' && (!input.sourceScope || agent.sourceScope !== input.sourceScope)) {
        throw new Error(t('agent.acp.error.codexProfileMismatch'));
      }
      const nativeResume = input.provider === 'codex'
        ? await acpLocalSessionHandoff({ sessionId: input.nativeSessionId, sourceScope: input.sourceScope!, accountScope, hostDeviceId: agentDeviceId(), workspaceRoot, profileId: agent.id })
        : undefined;
      assertAccount();
      const originalTodoId = getAcpHostBridge().findOriginalWorkTodoId({
        nativeSessionId: input.nativeSessionId,
        sourceScope: input.sourceScope,
        accountScope: resolveButlerAccountScope(),
        hostDeviceId: agentDeviceId(),
        workspaceRoot,
      });

      let preloadedMessages: AcpChatMessage[] = [];
      if (isTauriRuntime()) {
        try {
          const history = await acpLocalSessionMessages({
            provider: input.provider,
            sessionId: input.nativeSessionId,
            sourcePath: input.sourcePath ?? null,
            sourceScope: input.sourceScope,
            limit: 40,
          });
          preloadedMessages = history.map((msg) => ({
            id: msg.id,
            role: msg.role === 'user' ? 'user' : 'assistant',
            text: msg.text,
            timestamp: msg.timestamp,
          }));
        } catch {
          preloadedMessages = [];
        }
      }

      assertAccount();
      const loading = get().loadSession({
        agentId: agent.id,
        sessionId: input.nativeSessionId,
        workspaceRoot,
        linkedTodoId: input.linkedTodoId === undefined ? originalTodoId : input.linkedTodoId,
        title: input.title,
        initialMessages: preloadedMessages,
        nativeResume,
      });
      const loadingController = controllers.get(sessionKey);
      const loaded = await loading;
      if (resolveButlerAccountScope() !== accountScope) {
        if (loadingController && controllers.get(sessionKey) === loadingController) {
          controllers.delete(sessionKey);
          await loadingController.stop().catch(() => undefined);
        }
        assertAccount();
      }
      return loaded;
    },

    sendPrompt: async (sessionKey, text, options = {}) => {
      const session = get().sessions[sessionKey];
      const controller = controllers.get(sessionKey);
      if (!session || !controller || !session.acpSessionId) {
        throw new Error(t('agent.acp.error.notReadyOrStopped'));
      }

      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error(t('agent.acp.error.emptyPrompt'));
      }

      const accountScope = session.accountScope ?? resolveButlerAccountScope();
      if (accountScope !== resolveButlerAccountScope()) throw new Error(t('agent.acp.error.otherAccountSend'));
      if (session.status === 'running' || session.status === 'waiting_approval') {
        if (!options.steer) throw new Error(t('agent.acp.error.sessionBusy'));
        await get().cancelTurn(sessionKey);
      }

      let promptText = trimmed;
      const canUsePersonalMemory = () => {
        const current = get().sessions[sessionKey];
        return current && getAcpHostBridge().canUsePersonalMemory(current.linkedTodoId);
      };
      if (options.injectMemory && canUsePersonalMemory()) {
        const memoryBlock = await getAcpHostBridge().recallMemoryBlock({
          query: trimmed,
          workspaceRoot: session.workspaceRoot,
          limit: 5,
        });
        if (memoryBlock && canUsePersonalMemory() && get().sessions[sessionKey]?.linkedTodoId === session.linkedTodoId && accountScope === resolveButlerAccountScope()) {
          promptText = `${memoryBlock}\n\n${trimmed}`;
        }
      }
      if (accountScope !== resolveButlerAccountScope()) throw new Error(t('agent.acp.error.accountSwitchedNotSent'));

      const userMsgId = `u:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
      updateSession(sessionKey, (prev) => ({
        ...prev,
        status: 'running',
        error: null,
        streamingText: '',
        streamingThought: '',
        messages: [
          ...prev.messages,
          {
            id: userMsgId,
            role: 'user',
            text: trimmed,
            timestamp: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }));

      const runningSession = get().sessions[sessionKey];
      if (runningSession) {
        void syncAcpSessionToLedger(runningSession).catch(() => undefined);
      }

      try {
        const prompt = controller.prompt(promptText, session.acpSessionId);
        activePrompts.set(sessionKey, prompt);
        const result = await prompt.finally(() => { if (activePrompts.get(sessionKey) === prompt) activePrompts.delete(sessionKey); });
        updateSession(sessionKey, (prev) => {
          const finalText = prev.streamingText.trim();
          const finalThoughts = prev.streamingThought.trim();
          const nextMessages =
            finalText || finalThoughts
              ? [
                  ...prev.messages,
                  {
                    id: `a:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
                    role: 'assistant' as const,
                    text: finalText || t('agent.acp.error.turnEndedFallback', { stopReason: result.stopReason }),
                    ...(finalThoughts ? { thoughts: finalThoughts } : {}),
                    timestamp: Date.now(),
                  },
                ]
              : prev.messages;
          return {
            ...prev,
            status: prev.pendingPermissions.length > 0 ? 'waiting_approval' : 'ready',
            messages: nextMessages,
            streamingText: '',
            streamingThought: '',
            lastStopReason: result.stopReason,
            turnCount: prev.turnCount + 1,
            updatedAt: Date.now(),
          };
        });
        const after = get().sessions[sessionKey];
        if (after) {
          await syncAcpSessionToLedger(after);
          if (isTauriRuntime() && after.workspaceRoot?.trim()) {
            void createGitCheckpoint(
              after.workspaceRoot,
              t('agent.diff.turnCheckpointLabel'),
              `acp-${after.turnCount}`,
            ).catch(() => undefined);
          }
          const nextQueued = after.queuedPrompts?.[0];
          if (nextQueued && after.status === 'ready') {
            updateSession(sessionKey, (prev) => ({
              ...prev,
              queuedPrompts: (prev.queuedPrompts ?? []).slice(1),
            }));
            queueMicrotask(() => {
              void get().sendPrompt(sessionKey, nextQueued.text, options).catch(() => undefined);
            });
          }
        }
        return { stopReason: result.stopReason };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateSession(sessionKey, (prev) => {
          const partial = prev.streamingText.trim();
          const nextMessages = partial
            ? [
                ...prev.messages,
                {
                  id: `a:${Date.now()}:partial`,
                  role: 'assistant' as const,
                  text: partial,
                  timestamp: Date.now(),
                },
              ]
            : prev.messages;
          return {
            ...prev,
            status: 'error',
            error: message,
            messages: nextMessages,
            streamingText: '',
            streamingThought: '',
            updatedAt: Date.now(),
          };
        });
        const after = get().sessions[sessionKey];
        if (after) {
          void syncAcpSessionToLedger(after).catch(() => undefined);
        }
        throw error;
      }
    },

    cancelTurn: async (sessionKey) => {
      const session = get().sessions[sessionKey];
      const controller = controllers.get(sessionKey);
      if (!session || !controller || !session.acpSessionId) throw new Error(t('agent.acp.error.stopConnectionLost'));
      await controller.cancel(session.acpSessionId);
      // Release approvals before waiting for the old turn: a bridge can be awaiting this host response.
      for (const [requestId, pending] of permissionResolvers) {
        if (pending.sessionKey === sessionKey) {
          clearTimeout(pending.timer);
          permissionResolvers.delete(requestId);
          removePermissionRecord(requestId, pending.accountScope);
          pending.resolve({ outcome: { outcome: 'cancelled' } });
        }
      }
      const activePrompt = activePrompts.get(sessionKey);
      if (activePrompt) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([activePrompt, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(t('agent.acp.error.stopUnconfirmed'))), 10_000); })]);
        } finally { if (timeout) clearTimeout(timeout); }
      }
      updateSession(sessionKey, (prev) => ({
        ...prev,
        status: 'ready',
        pendingPermissions: [],
        updatedAt: Date.now(),
      }));
      const cancelled = get().sessions[sessionKey];
      if (cancelled) await syncAcpSessionToLedger(cancelled);
    },

    setMode: async (sessionKey, modeId) => {
      const session = get().sessions[sessionKey];
      const controller = controllers.get(sessionKey);
      if (!session || !controller || !session.acpSessionId) {
        throw new Error(t('agent.acp.error.notConnected'));
      }
      await controller.setMode(modeId, session.acpSessionId);
      updateSession(sessionKey, (prev) => ({
        ...prev,
        modes: prev.modes
          ? { ...prev.modes, currentModeId: modeId }
          : { currentModeId: modeId, availableModes: [] },
        updatedAt: Date.now(),
      }));
    },

    setModel: async (sessionKey, modelId) => {
      const session = get().sessions[sessionKey];
      const controller = controllers.get(sessionKey);
      if (!session || !controller || !session.acpSessionId) {
        throw new Error(t('agent.acp.error.notConnected'));
      }
      await controller.setModel(modelId, session.acpSessionId);
      updateSession(sessionKey, (prev) => ({
        ...prev,
        models: prev.models
          ? { ...prev.models, currentModelId: modelId }
          : { currentModelId: modelId, availableModels: [] },
        updatedAt: Date.now(),
      }));
    },

    enqueuePrompt: (sessionKey, text) => {
      const trimmed = text.trim();
      const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (!trimmed) return id;
      updateSession(sessionKey, (prev) => ({
        ...prev,
        queuedPrompts: [...(prev.queuedPrompts ?? []), { id, text: trimmed }],
        updatedAt: Date.now(),
      }));
      return id;
    },

    removeQueuedPrompt: (sessionKey, queueId) => {
      updateSession(sessionKey, (prev) => ({
        ...prev,
        queuedPrompts: (prev.queuedPrompts ?? []).filter((item) => item.id !== queueId),
      }));
    },

    resolvePermission: async (sessionKey, requestId, optionId) => {
      const pending = permissionResolvers.get(requestId);
      const session = get().sessions[sessionKey];
      const request = session?.pendingPermissions.find((entry) => entry.requestId === requestId);
      if (!pending || pending.sessionKey !== sessionKey || pending.accountScope !== resolveButlerAccountScope() || pending.nativeSessionId !== session?.acpSessionId || pending.turnCount !== session?.turnCount || controllers.get(sessionKey) !== pending.controller || pending.expiresAt <= Date.now()) {
        throw new Error(t('agent.acp.error.permInvalidOrExpired'));
      }
      if (optionId && !request?.options.some((option) => option.optionId === optionId)) throw new Error(t('agent.acp.error.invalidPermOption'));
      if (pending) {
        clearTimeout(pending.timer);
        removePermissionRecord(requestId, pending.accountScope);
        permissionResolvers.delete(requestId);
        pending.resolve(
          optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : { outcome: { outcome: 'cancelled' } },
        );
      }
      updateSession(sessionKey, (prev) => {
        const remaining = prev.pendingPermissions.filter((p) => p.requestId !== requestId);
        return {
          ...prev,
          pendingPermissions: remaining,
          status:
            remaining.length > 0
              ? 'waiting_approval'
              : prev.status === 'waiting_approval'
                ? 'running'
                : prev.status,
          updatedAt: Date.now(),
        };
      });
      const latest = get().sessions[sessionKey];
      if (latest) {
        void syncAcpSessionToLedger(latest).catch(() => undefined);
      }
    },

    stopSession: async (sessionKey) => {
      const controller = controllers.get(sessionKey);
      controllers.delete(sessionKey);
      for (const [reqId, pending] of permissionResolvers.entries()) {
        if (pending.sessionKey === sessionKey) {
          clearTimeout(pending.timer);
          removePermissionRecord(reqId, pending.accountScope);
          permissionResolvers.delete(reqId);
          pending.resolve({ outcome: { outcome: 'cancelled' } });
        }
      }
      updateSession(sessionKey, (prev) => ({
        ...prev,
        status: 'stopped',
        connectionReady: false,
        pendingPermissions: [],
        updatedAt: Date.now(),
      }));
      if (controller) {
        await controller.stop().catch(() => undefined);
      }
      const latest = get().sessions[sessionKey];
      if (latest) {
        void syncAcpSessionToLedger(latest).catch(() => undefined);
      }
    },

    setActiveSession: (sessionKey) => {
      set({ activeSessionKey: sessionKey });
    },
  };
});
