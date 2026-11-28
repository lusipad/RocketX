import { tsMs, type RcMessage, type RoomType } from '@rcx/rc-client';
import { t } from '../i18n';
import './acpButlerWiring';
import './codexHostTools';
import { agentDeviceId } from './device';
import { renderDispatchSpec } from './dispatchSpec';
import { agentMessageBridgeChanges } from './messageBridge';
import { agentBackend, leaseIsActive } from './session';
import {
  buildSessionContextImportSpec,
  evaluateSessionControlMode,
  matchesAcpWorkSession,
} from './sessionAdapter';
import type { ExternalEventInput } from './workCoordinator';
import { actionStopReason, createMessageWatermarks, createWorkSupervisor, runWorkspaceDispatch, type MessageWatermark } from './workSupervisor';
import { getServerBase, rest } from '../lib/client';
import { desktopNotify } from '../lib/notify';
import { workContextPathKey } from '../lib/workContext';
import { isNativeHostAction, isNativeHostSession, isNativeHostWork, nativeHostControlReason } from '../lib/nativeWorkOwnership';
import { isTauri } from '../lib/http';
import { captureButlerRuntimeAccountContext } from '../platform/butlerAccountReady';
import {
  acpLocalSessionsDiscover,
  inspectNativeWorkspaceGit,
  prepareNativeWorktree,
  readNativeWorkSnapshot,
  submitNativeWork,
  type DiscoveredLocalSession,
  type NativeDispatchActionRecord,
  type NativeManagedWorktreeInfo,
  type NativeWorkCard,
  type NativeWorkLink,
  type NativeWorkspaceGitSnapshot,
  type NativeWorkSessionRecord,
  type WorkCardStage,
} from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/toast';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useChat } from '../stores/chat';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useSharedAgent } from '../stores/sharedAgent';
import { useUI } from '../stores/ui';
import { captureWorkLedgerAccount, useWorkLedger, type UpsertWorkSessionInput } from '../stores/workLedger';

export interface SuperAgentRuntimeDrivers {
  isDesktop: () => boolean;
  prepareWorktree: (input: {
    repoRoot: string;
    branchName: string;
    baseRef?: string | null;
    slug?: string | null;
  }) => Promise<NativeManagedWorktreeInfo>;
  inspectWorkspaceGit: (workspaceRoot: string) => Promise<NativeWorkspaceGitSnapshot>;
  startCodexWorkerTask: (input: {
    workspaceRoot: string;
    specText: string;
    title: string;
  }) => Promise<{ threadId: string }>;
  sendCodexSessionPrompt: (input: {
    workspaceRoot: string;
    threadId: string;
    specText: string;
    requiresColdResume: boolean;
  }) => Promise<{ turnMarker: string }>;
  startAcpWorkerTask: (input: {
    agentId: string;
    workspaceRoot: string;
    specText: string;
    title: string;
    todoId: string;
  }) => Promise<{ sessionId: string; sessionKey: string; stopReason?: string }>;
  sendAcpSessionPrompt: (input: {
    agentId: string;
    workspaceRoot: string;
    sessionId: string;
    specText: string;
    requiresColdResume: boolean;
    steer?: boolean;
    todoId?: string;
    sourceScope?: string;
    accountScope?: string | null;
  }) => Promise<{ turnMarker: string; stopReason?: string }>;
  discoverLocalSessions: (limit?: number) => Promise<DiscoveredLocalSession[]>;
}

const defaultDrivers: SuperAgentRuntimeDrivers = {
  isDesktop: () => isTauri,
  discoverLocalSessions: (limit = 120) =>
    isTauri ? acpLocalSessionsDiscover(limit) : Promise.resolve([]),
  prepareWorktree: (input) => prepareNativeWorktree(input),
  inspectWorkspaceGit: (workspaceRoot) => inspectNativeWorkspaceGit(workspaceRoot),
  startCodexWorkerTask: async ({ workspaceRoot, specText, title }) => {
    const ws = useCodexWorkspace.getState();
    const threadId = await ws.startTask(specText, title, { workspaceRoot, background: true });
    return { threadId };
  },
  sendCodexSessionPrompt: async ({
    workspaceRoot,
    threadId,
    specText,
    requiresColdResume,
  }) => {
    if (useWorkLedger.getState().sessions.some((session) => isNativeHostSession(session)
      && session.runtime === 'pi' && session.nativeSessionId === threadId
      && workContextPathKey(session.workspaceRoot) === workContextPathKey(workspaceRoot))) throw new Error(nativeHostControlReason());
    const ws = useCodexWorkspace.getState();
    if (requiresColdResume || !ws.threadStates[threadId]) {
      await ws.resumeThread(threadId, { workspaceRoot, background: true });
    }
    await useCodexWorkspace.getState().send(specText, [], 'queue', { threadId, workspaceRoot, scope: ws.scope });
    const after = useCodexWorkspace.getState();
    const thread = after.threadStates[threadId];
    return {
      turnMarker: thread?.activeTurnId
        ? `turn:${thread.activeTurnId}`
        : `seq:${thread?.turns.length ?? 0}`,
    };
  },
  startAcpWorkerTask: async ({ agentId, workspaceRoot, specText, title, todoId }) => {
    if (todoId && isNativeHostWork(todoId, useWorkLedger.getState().sessions)) throw new Error(nativeHostControlReason());
    const acp = useAcpAgents.getState();
    const session = await acp.startSession({
      agentId,
      workspaceRoot,
      linkedTodoId: todoId,
      title,
    });
    const result = await useAcpAgents.getState().sendPrompt(session.sessionKey, specText, {
      injectMemory: useWorkLedger.getState().cards.find((card) => card.id === todoId)?.state.visibility === 'private',
    });
    const latest = useAcpAgents.getState().sessions[session.sessionKey];
    if (latest?.nativeIdentityPending) throw new Error(t('agent.superAgent.nativeIdentityPending'));
    return {
      sessionId: latest?.nativeSessionId ?? session.acpSessionId,
      sessionKey: session.sessionKey,
      stopReason: result.stopReason,
    };
  },
  sendAcpSessionPrompt: async ({
    agentId,
    workspaceRoot,
    sessionId,
    specText,
    requiresColdResume,
    steer,
    todoId,
    sourceScope,
    accountScope,
  }) => {
    const sessions = useWorkLedger.getState().sessions;
    if ((todoId && isNativeHostWork(todoId, sessions)) || sessions.some((session) => isNativeHostSession(session)
      && session.nativeSessionId === sessionId && workContextPathKey(session.workspaceRoot) === workContextPathKey(workspaceRoot)
      && (session.sourceScope?.trim() || 'default') === (sourceScope?.trim() || 'default')
      && (!session.accountScope || session.accountScope === (accountScope ?? resolveButlerAccountScope())))) throw new Error(nativeHostControlReason());
    const acp = useAcpAgents.getState();
    let existing = Object.values(acp.sessions).find(
      (s) => matchesAcpWorkSession({ nativeSessionId: sessionId, sourceScope, accountScope: accountScope ?? null,
        workspaceRoot, configSnapshotJson: JSON.stringify({ agentId }) }, s, resolveButlerAccountScope())
        && s.status !== 'stopped' && s.status !== 'error',
    );
    if (!existing || requiresColdResume) {
      existing = await acp.loadSession({
        agentId,
        sessionId,
        workspaceRoot,
        linkedTodoId: todoId ?? null,
      });
    }
    const result = await useAcpAgents
      .getState()
      .sendPrompt(existing.sessionKey, specText, {
        injectMemory: useWorkLedger.getState().cards.find((card) => card.id === todoId)?.state.visibility === 'private', steer,
      });
    const latest = useAcpAgents.getState().sessions[existing.sessionKey];
    return {
      turnMarker: latest?.messages.at(-1)?.id ?? `acp:${Date.now()}`,
      stopReason: result.stopReason,
    };
  },
};

let activeDrivers: SuperAgentRuntimeDrivers = { ...defaultDrivers };

export function setSuperAgentRuntimeDriversForTests(
  overrides: Partial<SuperAgentRuntimeDrivers>,
): () => void {
  const previous = activeDrivers;
  activeDrivers = { ...activeDrivers, ...overrides };
  return () => {
    activeDrivers = previous;
  };
}

export function getSuperAgentRuntimeDrivers(): SuperAgentRuntimeDrivers {
  return activeDrivers;
}

const ADO_TITLE_PATTERNS: Array<{ pattern: RegExp; eventType: string }> = [
  { pattern: /构建完成|build\s+complete/i, eventType: 'build.complete' },
  { pattern: /PR\s*已合并|pull\s*request\s*merged/i, eventType: 'git.pullrequest.merged' },
  {
    pattern: /PR\s*新评论|pull\s*request.*comment/i,
    eventType: 'ms.vss-code.git-pullrequest-comment-event',
  },
  { pattern: /PR\s*已更新|pull\s*request\s*updated/i, eventType: 'git.pullrequest.updated' },
  { pattern: /PR\s*已创建|pull\s*request\s*created/i, eventType: 'git.pullrequest.created' },
  { pattern: /工作项新评论|work\s*item\s*comment/i, eventType: 'workitem.commented' },
  { pattern: /工作项已更新|work\s*item\s*updated/i, eventType: 'workitem.updated' },
  { pattern: /工作项已创建|work\s*item\s*created/i, eventType: 'workitem.created' },
  { pattern: /代码推送|git\s*push/i, eventType: 'git.push' },
];

function extractPositiveInt(text: string, regex: RegExp): number | null {
  const match = text.match(regex);
  if (!match?.[1]) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Super Agent 第一层（零 Token 预过滤器）：
 * 从实时聊天消息流中识别 ADO Webhook / CI / PR / 工作项通知，普通闲聊直接过滤不唤醒管家。
 */
export function parseChatMessageAsExternalEvent(
  message: RcMessage,
): ExternalEventInput | null {
  const attachments = message.attachments ?? [];
  const firstAttachment = attachments[0];
  const attTitle = firstAttachment?.title ?? '';
  const attText = firstAttachment?.text ?? '';
  const attLink = firstAttachment?.title_link ?? '';
  const rawText = `${message.msg ?? ''}\n${attTitle}\n${attText}\n${attLink}`.trim();
  if (!rawText) return null;

  const messageAlias = (message as { alias?: string }).alias ?? '';
  const isAdoAlias =
    messageAlias === 'Azure DevOps' ||
    /azure\s*devops|devops-bot|ado-bridge/i.test(message.u?.username ?? '');

  let matchedEventType: string | null = null;
  for (const entry of ADO_TITLE_PATTERNS) {
    if (entry.pattern.test(attTitle) || (isAdoAlias && entry.pattern.test(rawText))) {
      matchedEventType = entry.eventType;
      break;
    }
  }

  if (!matchedEventType && !isAdoAlias) {
    return null;
  }

  const eventType = matchedEventType ?? 'ado.channel_notification';
  const prId =
    extractPositiveInt(rawText, /(?:pullrequest\/|PR\s*#)(\d{1,8})/i) ?? null;
  const workItemId =
    extractPositiveInt(rawText, /(?:_workitems\/edit\/|AB#|工作项\s*#)(\d{1,8})/i) ??
    null;
  const buildId =
    extractPositiveInt(rawText, /(?:buildId=|Build\s*#?)(\d{1,9})/i) ?? null;

  const branchMatch = rawText.match(
    /\b(?:refs\/heads\/)?((?:ai|feature|bugfix|fix|hotfix|task)\/[A-Za-z0-9._/-]+)\b/,
  );
  const branch = branchMatch?.[1] ?? null;

  const shaMatch = rawText.match(/\b([0-9a-f]{7,40})\b/i);
  const commitSha = shaMatch?.[1] ?? null;

  const projectMatch = attLink.match(/https?:\/\/[^/]+\/[^/]+\/([^/_]+)\/_(?:git|build|workitems)/i);
  const project = projectMatch?.[1] ? decodeURIComponent(projectMatch[1]) : null;

  const occurredAt = tsMs(message.ts) || Date.now();
  const resourceKey = prId
    ? `ado:pr:${project ?? 'default'}:${prId}`
    : workItemId
      ? `ado:workitem:${project ?? 'default'}:${workItemId}`
      : buildId
        ? `ado:build:${project ?? 'default'}:${branch ?? 'default'}`
        : `rc:room:${message.rid}:${eventType}`;

  const resourceVersion = buildId ?? occurredAt;

  return {
    dedupeKey: `rc-msg:${message._id}`,
    source: 'ado_webhook',
    eventType,
    resourceKey,
    resourceVersion,
    project,
    repo: null,
    branch,
    commitSha,
    workItemId,
    prId,
    buildId,
    rid: message.rid,
    payloadJson: JSON.stringify({
      mid: message._id,
      rid: message.rid,
      title: attTitle || message.msg,
      text: attText || message.msg,
      link: attLink || undefined,
    }),
    occurredAt,
  };
}

function mapSharedStatusToLedgerStatus(
  status: string,
): NativeWorkSessionRecord['runtimeStatus'] {
  switch (status) {
    case 'running':
    case 'starting':
      return 'running';
    case 'waiting-approval':
      return 'waiting_approval';
    case 'ended':
    case 'interrupted':
      return 'stopped';
    default:
      return 'idle';
  }
}

export const AUTO_BOARDED_SESSIONS_STORAGE_KEY = 'rcx-auto-boarded-sessions-v1';
const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AUTO_PROMOTED_CARDS = 12;
const memoryAutoBoardedKeys = new Set<string>();

export interface WorkSessionProviderMeta {
  provider: string;
  preset: string | null;
  label: string;
  sourcePath: string | null;
  preview: string | null;
  stepCount: number | null;
}

export function parseWorkSessionProviderMeta(
  session: Pick<NativeWorkSessionRecord, 'runtime' | 'configSnapshotJson'>,
): WorkSessionProviderMeta {
  let parsed: Record<string, unknown> | null = null;
  if (session.configSnapshotJson) {
    try {
      const raw = JSON.parse(session.configSnapshotJson) as unknown;
      if (raw && typeof raw === 'object') {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  const rawProvider =
    typeof parsed?.provider === 'string' && parsed.provider.trim()
      ? parsed.provider.trim().toLowerCase()
      : null;
  const rawPreset =
    typeof parsed?.preset === 'string' && parsed.preset.trim()
      ? parsed.preset.trim().toLowerCase()
      : null;
  const sourcePath =
    typeof parsed?.sourcePath === 'string' && parsed.sourcePath.trim()
      ? parsed.sourcePath.trim()
      : null;
  const preview =
    typeof parsed?.preview === 'string' && parsed.preview.trim()
      ? parsed.preview.trim()
      : null;
  const stepCount =
    typeof parsed?.stepCount === 'number' && Number.isFinite(parsed.stepCount)
      ? parsed.stepCount
      : null;

  if (rawProvider === 'antigravity' || rawPreset === 'antigravity') {
    return {
      provider: 'antigravity',
      preset: 'antigravity',
      label: 'Antigravity',
      sourcePath,
      preview,
      stepCount,
    };
  }
  if (rawProvider === 'codex' || rawPreset === 'codex-acp' || session.runtime === 'codex') {
    return {
      provider: 'codex',
      preset: 'codex-acp',
      label: 'Codex',
      sourcePath,
      preview,
      stepCount,
    };
  }
  if (rawProvider === 'claude' || rawPreset === 'claude-code') {
    return {
      provider: 'claude',
      preset: 'claude-code',
      label: 'Claude Code',
      sourcePath,
      preview,
      stepCount,
    };
  }
  if (rawProvider === 'pi' || rawPreset === 'pi' || session.runtime === 'pi') {
    return {
      provider: 'pi',
      preset: 'pi',
      label: 'Pi',
      sourcePath,
      preview,
      stepCount,
    };
  }
  if (rawProvider === 'deepseek' || rawPreset === 'deepseek' || session.runtime === 'deepseek') {
    return {
      provider: 'deepseek',
      preset: rawPreset,
      label: 'DeepSeek',
      sourcePath,
      preview,
      stepCount,
    };
  }

  const presetLabels: Record<string, string> = {
    'kimi-cli': 'Kimi',
    'copilot-cli': 'Copilot',
    'gemini-cli': 'Gemini CLI',
    opencode: 'OpenCode',
  };
  const label =
    (rawPreset && presetLabels[rawPreset]) ||
    rawPreset ||
    rawProvider ||
    session.runtime.toUpperCase();

  return {
    provider: rawProvider || rawPreset || session.runtime,
    preset: rawPreset,
    label,
    sourcePath,
    preview,
    stepCount,
  };
}

function sessionAutoBoardKey(runtime: string, nativeSessionId: string): string {
  return `${runtime}:${nativeSessionId}`;
}

function loadAutoBoardedSet(): Set<string> {
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      const raw = globalThis.localStorage.getItem(AUTO_BOARDED_SESSIONS_STORAGE_KEY);
      if (!raw) return new Set<string>();
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((item): item is string => typeof item === 'string'));
      }
      return new Set<string>();
    }
  } catch {
    // ignore storage errors
  }
  return new Set(memoryAutoBoardedKeys);
}

function saveAutoBoardedSet(keys: Set<string>): void {
  memoryAutoBoardedKeys.clear();
  for (const key of keys) {
    memoryAutoBoardedKeys.add(key);
  }
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem(
        AUTO_BOARDED_SESSIONS_STORAGE_KEY,
        JSON.stringify(Array.from(keys)),
      );
    }
  } catch {
    // ignore storage errors
  }
}

export function resetAutoBoardedSessionsForTests(): void {
  memoryAutoBoardedKeys.clear();
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.removeItem(AUTO_BOARDED_SESSIONS_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function normalizeTimestampMs(ts: number | null | undefined): number | undefined {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return undefined;
  return ts < 100_000_000_000 ? ts * 1000 : ts;
}

function workspaceBasename(workspaceRoot: string): string {
  const normalized = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function isSessionActivelyRunning(status: string): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'waiting_input';
}

function sessionRecordToUpsertInput(
  session: NativeWorkSessionRecord,
  overrides: Partial<UpsertWorkSessionInput> = {},
): UpsertWorkSessionInput {
  return {
    todoId: session.todoId,
    visibility: session.visibility,
    runtime: session.runtime,
    origin: session.origin,
    nativeSessionId: session.nativeSessionId,
    sourceScope: session.sourceScope,
    title: session.title,
    workspaceRoot: session.workspaceRoot,
    environmentId: session.environmentId,
    accountScope: session.accountScope,
    controlEndpoint: session.controlEndpoint,
    controlMode: session.controlMode,
    controlReason: session.controlReason,
    hostDeviceId: session.hostDeviceId,
    writerLeaseOwner: session.writerLeaseOwner,
    writerLeaseExpiresAt: session.writerLeaseExpiresAt,
    runtimeStatus: session.runtimeStatus,
    configSnapshotJson: session.configSnapshotJson,
    lastEventSeq: session.lastEventSeq,
    lastTurnId: session.lastTurnId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...overrides,
  };
}

function buildConfigSnapshotPreservingMeta(
  existingJson: string | null | undefined,
  patch: Record<string, unknown>,
): string {
  let prev: Record<string, unknown> = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson) as unknown;
      if (parsed && typeof parsed === 'object') {
        prev = parsed as Record<string, unknown>;
      }
    } catch {
      prev = {};
    }
  }
  return JSON.stringify({ ...prev, ...patch });
}

export function workSessionImportIdentity(session: NativeWorkSessionRecord, accountScope = resolveButlerAccountScope()): string {
  const meta = parseWorkSessionProviderMeta(session);
  let profile: string | null = null;
  try {
    const config = JSON.parse(session.configSnapshotJson ?? '{}');
    profile = config.executionProfileId ?? config.agentId ?? null;
  } catch { /* Historical records may not contain an execution profile. */ }
  return JSON.stringify([accountScope, session.runtime, meta.provider, session.nativeSessionId,
    session.sourceScope?.trim() || 'default', workContextPathKey(session.workspaceRoot),
    session.hostDeviceId ?? null, session.accountScope ?? null, profile, meta.sourcePath]);
}

export function matchesDiscoveredWorkSession(session: NativeWorkSessionRecord, item: DiscoveredLocalSession): boolean {
  const meta = parseWorkSessionProviderMeta(session);
  let profile: string | null = null;
  try { const config = JSON.parse(session.configSnapshotJson ?? '{}'); profile = config.executionProfileId ?? config.agentId ?? null; } catch { /* Historical metadata. */ }
  const sameRuntime = session.runtime === (item.provider === 'pi' ? 'pi' : 'acp')
    || (session.runtime === 'codex' && item.provider === 'codex' && isNativeHostSession(session));
  return sameRuntime
    && session.nativeSessionId === item.nativeSessionId
    && meta.provider === item.provider
    && (session.sourceScope?.trim() || 'default') === (item.sourceScope?.trim() || 'default')
    && workContextPathKey(session.workspaceRoot) === workContextPathKey(item.workspaceRoot)
    && (!session.accountScope || session.accountScope === resolveButlerAccountScope())
    && (!session.hostDeviceId || session.hostDeviceId === agentDeviceId())
    && (!item.executionProfileId || profile === item.executionProfileId)
    && (!meta.sourcePath || !item.sourcePath || meta.sourcePath === item.sourcePath);
}

const sessionImportsInFlight = new Map<string, Promise<NativeWorkCard>>();

export function promoteWorkSessionToCard(
  sessionOrId: NativeWorkSessionRecord | string,
  options: { stage?: WorkCardStage } = {},
): Promise<NativeWorkCard> {
  const accountScope = resolveButlerAccountScope();
  const records = useWorkLedger.getState().sessions;
  const initialSession = typeof sessionOrId === 'string'
    ? records.find((session) => session.id === sessionOrId)
    : records.find((session) => session.id === sessionOrId.id
      && workSessionImportIdentity(session, accountScope) === workSessionImportIdentity(sessionOrId, accountScope));
  if (!initialSession) {
    return Promise.reject(new Error(t('agent.superAgent.sessionRecordNotFound')));
  }
  if (initialSession.accountScope && initialSession.accountScope !== accountScope) {
    return Promise.reject(new Error(t('agent.superAgent.accountSwitchedSelect')));
  }
  const identity = workSessionImportIdentity(initialSession, accountScope);
  const pending = sessionImportsInFlight.get(identity);
  if (pending) return pending;
  let accountChanged = false;
  const owner = globalThis.localStorage?.getItem('rcx-owner');
  const unsubscribe = useAuth.subscribe(() => {
    if (resolveButlerAccountScope() !== accountScope) accountChanged = true;
  });
  const assertAccount = () => {
    if (accountChanged || resolveButlerAccountScope() !== accountScope || globalThis.localStorage?.getItem('rcx-owner') !== owner) {
      throw new Error(t('agent.superAgent.accountSwitchedImport'));
    }
  };
  const operation = (async () => {
    assertAccount();
    if (initialSession.todoId) {
      const existing = useWorkLedger.getState().cards.find((card) => card.id === initialSession.todoId);
      if (existing) return existing;
      throw new Error(t('agent.superAgent.linkedWorkUnavailable'));
    }

  const meta = parseWorkSessionProviderMeta(initialSession);
  const running = isSessionActivelyRunning(initialSession.runtimeStatus);
  const stage: WorkCardStage = options.stage ?? (running ? 'in_progress' : 'ready');
  const folder = workspaceBasename(initialSession.workspaceRoot);
  const title =
    initialSession.title?.trim() ||
    `${meta.label} · ${folder || initialSession.nativeSessionId.slice(0, 8)}`;

  const card = await useWorkLedger.getState().createCard({
    requestId: `session-import:${identity}`,
    title,
    note: initialSession.workspaceRoot ? t('agent.superAgent.workspaceNote', { workspaceRoot: initialSession.workspaceRoot }) : undefined,
    priority: 3,
    stage,
    goal: title,
    ownerKind: 'human',
    autonomyMode: 'confirm',
    visibility: initialSession.visibility === 'room_shared' ? 'room_shared' : 'private',
  });
  assertAccount();
  const latestSession = useWorkLedger.getState().sessions.find((session) => session.id === initialSession.id
    && workSessionImportIdentity(session, accountScope) === identity);
  if (!latestSession) throw new Error(t('agent.superAgent.sessionSourceChanged'));
  await useWorkLedger
    .getState()
    .upsertSession(
      sessionRecordToUpsertInput(latestSession, {
        todoId: card.id,
        clearTodoId: false,
      }),
    );
  assertAccount();
  const autoBoardedSet = loadAutoBoardedSet();
  autoBoardedSet.add(sessionAutoBoardKey(initialSession.runtime, initialSession.nativeSessionId));
  saveAutoBoardedSet(autoBoardedSet);
  return card;
  })();
  sessionImportsInFlight.set(identity, operation);
  void operation.finally(() => {
    unsubscribe();
    if (sessionImportsInFlight.get(identity) === operation) sessionImportsInFlight.delete(identity);
  }).catch(() => {});
  return operation;
}

export async function bindWorkSessionToCard(
  sessionId: string,
  todoId: string | null,
): Promise<NativeWorkSessionRecord | null> {
  const session = useWorkLedger.getState().sessions.find((s) => s.id === sessionId);
  if (!session) {
    return null;
  }

  if (todoId === null) {
    const autoBoardedSet = loadAutoBoardedSet();
    autoBoardedSet.add(sessionAutoBoardKey(session.runtime, session.nativeSessionId));
    saveAutoBoardedSet(autoBoardedSet);
    return useWorkLedger.getState().upsertSession(
      sessionRecordToUpsertInput(session, {
        todoId: null,
        clearTodoId: true,
      }),
    );
  }

  return useWorkLedger.getState().upsertSession(
    sessionRecordToUpsertInput(session, {
      todoId,
      clearTodoId: false,
    }),
  );
}

export async function openOrResumeWorkSession(
  session: NativeWorkSessionRecord,
  options: { handoffConfirmed?: boolean } = {},
): Promise<void> {
  if (isNativeHostSession(session)) throw new Error(nativeHostControlReason());
  const meta = parseWorkSessionProviderMeta(session);
  const accountScope = resolveButlerAccountScope();
  const codexHandoff = meta.provider === 'codex' && session.origin !== 'rocketx_managed' && options.handoffConfirmed === true;
  if (session.controlMode === 'readonly' && !codexHandoff) {
    throw new Error(t('agent.superAgent.readonlyHandoffRequired'));
  }
  if (session.runtime === 'codex' && session.origin !== 'rocketx_managed' && !codexHandoff) {
    throw new Error(t('agent.superAgent.externalCodexNoPi'));
  }
  if (session.runtime === 'acp' || codexHandoff) {
    if (session.accountScope && session.accountScope !== resolveButlerAccountScope()) throw new Error(t('agent.superAgent.sessionOtherAccount'));
    if (session.hostDeviceId && session.hostDeviceId !== agentDeviceId()) throw new Error(t('agent.superAgent.sessionOtherDevice'));
    const live = Object.values(useAcpAgents.getState().sessions).find(
      (s) =>
        matchesAcpWorkSession(session, s, resolveButlerAccountScope()) &&
        s.status !== 'stopped' &&
        s.status !== 'error',
    );
    if (live) {
      useAcpAgents.getState().setActiveSession(live.sessionKey);
      useUI.getState().openAcpHub(live.agentId);
      return;
    }

    const fallbackPreset =
      meta.preset ||
      (meta.provider === 'codex'
        ? 'codex-acp'
        : meta.provider === 'claude'
          ? 'claude-code'
          : meta.provider);

    try {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(session.configSnapshotJson ?? '{}') ?? {}; } catch { /* old records can omit configuration */ }
      const resumed = await useAcpAgents.getState().resumeLocalSession({
        provider: meta.provider,
        preset: fallbackPreset,
        nativeSessionId: session.nativeSessionId,
        title: session.title ?? undefined,
        workspaceRoot: session.workspaceRoot,
        sourcePath: meta.sourcePath,
        sourceScope: session.sourceScope ?? undefined,
        executionProfileId: typeof config.executionProfileId === 'string' ? config.executionProfileId : typeof config.agentId === 'string' ? config.agentId : undefined,
        handoffConfirmed: options.handoffConfirmed,
        linkedTodoId: session.todoId,
      });
      if (resolveButlerAccountScope() !== accountScope) throw new Error(t('agent.superAgent.accountSwitchedHandoff'));
      useUI.getState().openAcpHub(resumed.agentId);
      return;
    } catch (error) {
      if (resolveButlerAccountScope() === accountScope) useUI.getState().openAcpHub();
      throw error;
    }
  }

  if (session.runtime !== 'pi') {
    throw new Error(t('agent.superAgent.noResumeChannel'));
  }
  useUI.getState().openButlerConversation();
  const ws = useCodexWorkspace.getState();
  if (session.workspaceRoot && ws.workspaceRoot !== session.workspaceRoot) {
    await ws.setWorkspaceRoot(session.workspaceRoot, { reuseRuntime: true });
  }
  await useCodexWorkspace.getState().resumeThread(session.nativeSessionId);
}

/**
 * 将房间共享会话（useSharedAgent）、个人/管家 Pi 线程与本机磁盘历史会话同步投影到统一工作账本，
 * 发现仅整理元数据；需要加入工作台时由调用方明确选择。
 */
export async function syncLiveSessionsIntoLedger(
  options: { autoPromoteRecent?: boolean; limit?: number } = {},
): Promise<number> {
  const accountScope = resolveButlerAccountScope();
  const owner = globalThis.localStorage?.getItem('rcx-owner');
  let accountChanged = false;
  const unsubscribe = useAuth.subscribe(() => { if (resolveButlerAccountScope() !== accountScope) accountChanged = true; });
  const assertAccount = () => {
    if (accountChanged || resolveButlerAccountScope() !== accountScope || globalThis.localStorage?.getItem('rcx-owner') !== owner) {
      throw new Error(t('agent.superAgent.accountSwitchedScan'));
    }
  };
  const syncSession = async (input: UpsertWorkSessionInput) => {
    assertAccount();
    const existing = useWorkLedger.getState().sessions.find((session) => session.runtime === input.runtime
      && session.nativeSessionId === input.nativeSessionId
      && (session.sourceScope?.trim() || 'default') === (input.sourceScope?.trim() || 'default')
      && (!session.accountScope || session.accountScope === accountScope)
      && (!session.hostDeviceId || session.hostDeviceId === agentDeviceId()));
    if (existing && isNativeHostSession(existing)) return existing;
    const record = await useWorkLedger.getState().upsertSession(input);
    assertAccount();
    return record;
  };
  try {
  const ledger = useWorkLedger.getState();
  const localDevice = agentDeviceId();
  let synced = 0;
  const knownPiThreadIds = new Set<string>();
  const liveAcpSessionIds = new Set<string>();

  // 1. 同步房间共享会话
  for (const session of Object.values(useSharedAgent.getState().sessions)) {
    const runtime = agentBackend(session) === 'deepseek' ? 'deepseek' : 'codex';
    const nativeId =
      (runtime === 'deepseek' ? session.dshSessionId : session.codexThreadId) ||
      session.sessionId;
    const workspaceRoot = session.workspaceRoots[0] ?? '';
    const ownedLive =
      session.status !== 'ended' &&
      session.host.deviceId === localDevice &&
      leaseIsActive(session);

    const evaluation = evaluateSessionControlMode({
      runtime,
      nativeSessionId: nativeId,
      origin: 'rocketx_managed',
      workspaceRoot,
      workspaceExists: Boolean(workspaceRoot),
      hasOwnedLiveController: ownedLive,
      hostDeviceId: session.host.deviceId,
      currentDeviceId: localDevice,
    });

    // 仅关联非私密卡片（遵守隐私防火墙）
    let matchedCardId: string | null = null;
    if (session.workItem?.id != null) {
      const candidate = ledger.cards.find(
        (c) =>
          c.adoWorkItemId === session.workItem?.id &&
          c.state.visibility === 'room_shared',
      );
      matchedCardId = candidate?.id ?? null;
    }

    const existing = ledger.sessions.find(
      (s) => s.runtime === runtime && s.nativeSessionId === nativeId,
    );

    await syncSession({
      todoId: existing?.todoId ?? matchedCardId ?? null,
      visibility: 'room_shared',
      runtime,
      origin: 'rocketx_managed',
      nativeSessionId: nativeId,
      title: session.currentTaskLabel || session.workItem?.title || session.roomNameSnapshot || null,
      workspaceRoot,
      environmentId: session.environmentId ?? null,
      accountScope: session.serverId,
      controlEndpoint: ownedLive ? 'shared-agent://local' : null,
      controlMode: evaluation.controlMode,
      controlReason: evaluation.controlReason,
      hostDeviceId: session.host.deviceId,
      writerLeaseOwner: session.host.deviceId,
      writerLeaseExpiresAt: session.host.expiresAt,
      runtimeStatus: mapSharedStatusToLedgerStatus(session.status),
      configSnapshotJson: existing?.configSnapshotJson ?? null,
      lastEventSeq: existing?.lastEventSeq ?? null,
      lastTurnId: session.activeTurnId ?? existing?.lastTurnId ?? null,
    });
    synced += 1;
  }

  // 2. 同步本地 Pi / Codex 协议工作区线程（涵盖活跃线程与历史线程）
  const codexState = useCodexWorkspace.getState();
  const nativeRuntime = 'pi';
  for (const thread of codexState.threads) {
    knownPiThreadIds.add(thread.id);
    const existing = useWorkLedger
      .getState()
      .sessions.find((s) => s.runtime === nativeRuntime && s.nativeSessionId === thread.id);
    const threadState = codexState.threadStates[thread.id];
    const workspaceRoot = threadState?.workspaceRoot || thread.cwd || codexState.workspaceRoot;
    const isLiveActive = Boolean(threadState && ['running', 'ready', 'waiting-input'].includes(threadState.status));
    const isExternal =
      threadState?.status === 'external';

    const evaluation = evaluateSessionControlMode({
      runtime: nativeRuntime,
      nativeSessionId: thread.id,
      origin: isExternal ? 'native_desktop' : 'rocketx_managed',
      workspaceRoot,
      workspaceExists: Boolean(workspaceRoot),
      hasOwnedLiveController: isLiveActive,
      externalWriterActive: isExternal,
      currentDeviceId: localDevice,
    });

    const turnsCount = threadState?.turns.length ?? thread.turns?.length ?? 0;
    const lastTurnId =
      threadState?.activeTurnId ??
      threadState?.turns.at(-1)?.id ??
      existing?.lastTurnId ??
      null;

    await syncSession({
      todoId: existing?.todoId ?? null,
      visibility: existing?.visibility ?? 'private',
      runtime: nativeRuntime,
      origin: isExternal ? 'native_desktop' : 'rocketx_managed',
      nativeSessionId: thread.id,
      title: thread.name || thread.preview?.slice(0, 48) || existing?.title || null,
      workspaceRoot,
      environmentId: existing?.environmentId ?? null,
      accountScope: null,
      controlEndpoint: isLiveActive ? 'pi-app-server://local' : null,
      controlMode: evaluation.controlMode,
      controlReason: evaluation.controlReason,
      hostDeviceId: localDevice,
      writerLeaseOwner: isExternal ? 'external:pi' : 'rocketx:local',
      writerLeaseExpiresAt: null,
      runtimeStatus:
        threadState?.status === 'running'
          ? 'running'
          : threadState?.status === 'waiting-input'
            ? 'waiting_input'
            : 'idle',
      configSnapshotJson: buildConfigSnapshotPreservingMeta(existing?.configSnapshotJson, {
        provider: 'pi',
        preset: 'pi',
        preview: thread.preview?.slice(0, 160) || null,
      }),
      lastEventSeq: turnsCount,
      lastTurnId,
      createdAt: normalizeTimestampMs(thread.createdAt),
      updatedAt: normalizeTimestampMs(thread.updatedAt),
    });
    synced += 1;
  }

  // 3. 同步本地 ACP 托管会话
  const acpSessions = Object.values(useAcpAgents.getState().sessions);
  for (const acpSession of acpSessions) {
    if (!acpSession.acpSessionId) continue;
    if (acpSession.nativeIdentityPending) continue;
    const nativeSessionId = acpSession.nativeSessionId ?? acpSession.acpSessionId;
    if (acpSession.accountScope && acpSession.accountScope !== resolveButlerAccountScope()) continue;
    const stopped = acpSession.status === 'stopped' || acpSession.status === 'error';
    const disconnected = stopped || acpSession.connectionReady === false;
    const existing = useWorkLedger
      .getState()
      .sessions.find((s) => s.runtime === 'acp' && s.nativeSessionId === nativeSessionId && (s.sourceScope ?? 'default') === (acpSession.sourceScope ?? 'default') && (!s.accountScope || s.accountScope === (acpSession.accountScope ?? resolveButlerAccountScope())) && (!s.hostDeviceId || s.hostDeviceId === localDevice));
    const card = acpSession.linkedTodoId
      ? useWorkLedger.getState().cards.find((c) => c.id === acpSession.linkedTodoId)
      : undefined;

    const syncedSession = await syncSession({
      todoId: existing?.todoId ?? acpSession.linkedTodoId ?? null,
      visibility: existing?.visibility ?? card?.state.visibility ?? 'private',
      runtime: 'acp',
      origin: 'rocketx_managed',
      nativeSessionId,
      sourceScope: acpSession.sourceScope,
      title: acpSession.title || t('agent.superAgent.acpSessionTitle', { agentName: acpSession.agentName }),
      workspaceRoot: acpSession.workspaceRoot,
      environmentId: existing?.environmentId ?? null,
      accountScope: acpSession.accountScope ?? existing?.accountScope ?? resolveButlerAccountScope(),
      controlEndpoint: disconnected ? null : `acp://${acpSession.agentId}/${acpSession.acpSessionId}`,
      controlMode: disconnected ? 'resumable' : 'controllable',
      controlReason: acpSession.connectionReady === false ? 'connection_unavailable' : stopped ? 'stopped_local_matching_cwd' : 'owned_live_controller',
      hostDeviceId: localDevice,
      writerLeaseOwner: 'rocketx:local',
      writerLeaseExpiresAt: null,
      runtimeStatus:
        acpSession.status === 'running' || acpSession.status === 'connecting'
          ? 'running'
          : acpSession.status === 'waiting_approval'
            ? 'waiting_approval'
            : acpSession.status === 'stopped'
              ? 'stopped'
              : acpSession.status === 'error'
                ? 'error'
                : 'idle',
      configSnapshotJson: buildConfigSnapshotPreservingMeta(existing?.configSnapshotJson, {
        agentId: acpSession.agentId,
        preset: acpSession.preset,
        autonomyMode: acpSession.autonomyMode,
        transportSessionId: acpSession.acpSessionId,
      }),
      lastEventSeq: acpSession.turnCount,
      lastTurnId: acpSession.messages.at(-1)?.id ?? existing?.lastTurnId ?? null,
    });
    if (!disconnected) liveAcpSessionIds.add(syncedSession.id);
    synced += 1;
  }

  // 4. 扫描并同步本机磁盘会话（Google Antigravity / Codex / Claude Code / Pi 跨工作区历史）
  const discovered = await activeDrivers.discoverLocalSessions(Math.min(300, Math.max(1, options.limit ?? 300)));
  assertAccount();
  const sortedDiscovered = [...discovered].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  );

  for (const item of sortedDiscovered) {
    const runtime = item.provider === 'pi' ? 'pi' : 'acp';
    if (runtime === 'acp' && useWorkLedger.getState().sessions.some((session) => liveAcpSessionIds.has(session.id) && matchesDiscoveredWorkSession(session, item))) {
      continue;
    }
    if (runtime === 'pi' && knownPiThreadIds.has(item.nativeSessionId)) {
      continue;
    }

    const origin =
      item.provider === 'pi'
        ? 'rocketx_managed'
        : item.provider === 'antigravity'
          ? 'native_desktop'
          : 'native_cli';
    const existing = useWorkLedger
      .getState()
      .sessions.find(
        (s) => matchesDiscoveredWorkSession(s, item),
      );
    if (existing && isNativeHostSession(existing)) continue;

    const evaluation = evaluateSessionControlMode({
      runtime,
      nativeSessionId: item.nativeSessionId,
      origin,
      workspaceRoot: item.workspaceRoot,
      workspaceExists: Boolean(item.workspaceRoot.trim()),
      hasOwnedLiveController: false,
      externalWriterActive: item.runtimeStatus === 'running',
      externalActivityUnknown: item.runtimeStatus === 'unknown' || !item.runtimeStatus,
      currentDeviceId: localDevice,
    });

    await syncSession({
      todoId: existing?.todoId ?? null,
      visibility: existing?.visibility ?? 'private',
      runtime,
      origin,
      nativeSessionId: item.nativeSessionId,
      sourceScope: item.sourceScope,
      title: item.title || existing?.title || null,
      workspaceRoot: item.workspaceRoot,
      environmentId: existing?.environmentId ?? null,
      accountScope: existing?.accountScope ?? resolveButlerAccountScope(),
      controlEndpoint: null,
      controlMode: evaluation.controlMode,
      controlReason: evaluation.controlReason,
      hostDeviceId: localDevice,
      writerLeaseOwner:
        origin === 'rocketx_managed' ? 'rocketx:local' : `external:${item.provider}`,
      writerLeaseExpiresAt: null,
      runtimeStatus: item.runtimeStatus === 'running' ? 'running' : item.runtimeStatus === 'idle' || item.runtimeStatus === 'stopped' ? item.runtimeStatus : 'unknown',
      configSnapshotJson: buildConfigSnapshotPreservingMeta(existing?.configSnapshotJson, {
        provider: item.provider,
        preset: item.preset,
        sourcePath: item.sourcePath,
        preview: item.preview,
        stepCount: item.stepCount,
        sourceScope: item.sourceScope,
        executionProfileId: item.executionProfileId,
      }),
      lastEventSeq: item.stepCount ?? existing?.lastEventSeq ?? null,
      lastTurnId: existing?.lastTurnId ?? null,
      createdAt: normalizeTimestampMs(item.createdAt),
      updatedAt: normalizeTimestampMs(item.updatedAt),
    });
    synced += 1;
  }

  // 兼容明确开启的近期加入；同标题和目录不足以认定同一份工作。
  if (options.autoPromoteRecent === true) {
    const autoBoardedSet = loadAutoBoardedSet();
    const initialLedger = useWorkLedger.getState();
    const cardById = new Map(initialLedger.cards.map((c) => [c.id, c]));
    const activeAutoCardIds = new Set<string>();

    for (const s of initialLedger.sessions) {
      if (!s.todoId) continue;
      const key = sessionAutoBoardKey(s.runtime, s.nativeSessionId);
      if (!autoBoardedSet.has(key)) continue;
      const card = cardById.get(s.todoId);
      if (card && card.state.stage !== 'done') {
        activeAutoCardIds.add(card.id);
      }
    }

    const recentCutoff = Date.now() - RECENT_SESSION_WINDOW_MS;
    const candidates = initialLedger.sessions
      .filter((s) => {
        if (s.todoId) return false;
        const key = sessionAutoBoardKey(s.runtime, s.nativeSessionId);
        if (autoBoardedSet.has(key)) return false;
        return isSessionActivelyRunning(s.runtimeStatus) || s.updatedAt >= recentCutoff;
      })
      .sort((a, b) => {
        const aRunning = isSessionActivelyRunning(a.runtimeStatus) ? 1 : 0;
        const bRunning = isSessionActivelyRunning(b.runtimeStatus) ? 1 : 0;
        if (aRunning !== bRunning) return bRunning - aRunning;
        return b.updatedAt - a.updatedAt;
      });

    for (const session of candidates) {
      const key = sessionAutoBoardKey(session.runtime, session.nativeSessionId);
      autoBoardedSet.add(key);

      if (activeAutoCardIds.size < MAX_AUTO_PROMOTED_CARDS) {
        const card = await promoteWorkSessionToCard(session);
        activeAutoCardIds.add(card.id);
      }
    }

    saveAutoBoardedSet(autoBoardedSet);
  }

  return synced;
  } finally { unsubscribe(); }
}

export interface ExecuteSuperAgentDispatchOptions {
  action: NativeDispatchActionRecord;
  approved?: boolean;
  shouldContinue?: () => boolean;
  specText?: string;
  isolateWorktree?: boolean;
  repoRootOverride?: string;
  preferredRuntime?: 'codex' | 'pi' | 'acp';
  acpAgentId?: string;
}

export interface ExecuteSuperAgentDispatchResult {
  ok: boolean;
  action: NativeDispatchActionRecord;
  session?: NativeWorkSessionRecord;
  worktree?: NativeManagedWorktreeInfo;
  error?: string;
}

function buildBranchNameForCard(card: NativeWorkCard): string {
  const prefix = card.adoWorkItemId
    ? `ai/${card.adoWorkItemId}`
    : `ai/card-${card.id.slice(0, 8)}`;
  return prefix.replace(/[^A-Za-z0-9/_-]/g, '-');
}

function resolveBaseRepoRoot(
  card: NativeWorkCard,
  sessions: NativeWorkSessionRecord[],
  links: NativeWorkLink[],
  override?: string,
): string {
  if (override?.trim()) return override.trim();
  const cardSession = sessions.find(
    (s) => s.todoId === card.id && s.workspaceRoot.trim().length > 0,
  );
  if (cardSession) return cardSession.workspaceRoot;
  // 当前界面、默认工作区和管家资料目录都不代表这件工作已选择的项目。
  return links.find((link) => link.todoId === card.id && link.kind === 'kanban_card'
    && link.stateSnapshot === 'workspace' && link.repo?.trim())?.repo?.trim() || '';
}

function resolveAcpAgentIdFromSession(
  session: NativeWorkSessionRecord | undefined,
  explicitAgentId?: string,
): string | null {
  if (explicitAgentId?.trim()) return explicitAgentId.trim();
  if (session?.configSnapshotJson) {
    try {
      const parsed = JSON.parse(session.configSnapshotJson) as { agentId?: string };
      if (parsed.agentId?.trim()) return parsed.agentId.trim();
    } catch {
      /* ignore */
    }
  }
  if (session?.controlEndpoint?.startsWith('acp://')) {
    const seg = session.controlEndpoint.slice('acp://'.length).split('/')[0];
    if (seg) return seg;
  }
  const acpState = useAcpAgents.getState();
  return acpState.agents.find((a) => a.enabled)?.id ?? acpState.agents[0]?.id ?? null;
}

/**
 * Super Agent 第二层（受控 Worker 派发与 Git Worktree 沙盒隔离执行器）
 */
export async function executeSuperAgentDispatch(
  options: ExecuteSuperAgentDispatchOptions,
): Promise<ExecuteSuperAgentDispatchResult> {
  const ledger = useWorkLedger.getState();
  const card = ledger.cards.find((c) => c.id === options.action.todoId);
  if (!card) return { ok: false, action: options.action, error: t('agent.superAgent.targetCardMissing') };
  let action = ledger.actions.find((item) => item.id === options.action.id) ?? options.action;
  if (isNativeHostAction(action) || isNativeHostWork(card.id, ledger.sessions)
    || ledger.sessions.some((session) => session.id === action.sessionId && isNativeHostSession(session))) {
    return { ok: false, action, error: nativeHostControlReason() };
  }
  if (action.state === 'awaiting_approval' && options.approved) {
    action = await ledger.transitionDispatchAction({ id: action.id, state: 'prepared', expectedState: 'awaiting_approval' });
  }
  const stopReason = actionStopReason(card, action, Date.now());
  if (stopReason) return { ok: false, action, error: stopReason };
  let spec: { workspaceRoot?: string; repoRootOverride?: string; isolateWorktree?: boolean } = {};
  try { spec = JSON.parse(action.specJson); } catch { /* 版本门禁会拒绝无效快照。 */ }
  const target = ledger.sessions.find((s) => s.id === action.sessionId);
  // 续发沿用原会话目录，写入锁必须与实际投递目录一致；覆盖值只用于新会话。
  const workspaceRoot = action.actionKind === 'session_create'
    ? resolveBaseRepoRoot(card, ledger.sessions, ledger.links,
      options.repoRootOverride?.trim() || spec.workspaceRoot?.trim() || spec.repoRootOverride?.trim())
    : target?.workspaceRoot.trim() || '';
  const isolateWorktree = options.isolateWorktree ?? spec.isolateWorktree;
  const isolatedCreate = action.actionKind === 'session_create' && isolateWorktree;
  const previousWorktree = isolatedCreate ? ledger.sessions.find((session) => session.todoId === card.id
    && session.configSnapshotJson?.includes('"isolatedWorktree":true')) : undefined;
  const lockRoot = isolatedCreate ? previousWorktree?.workspaceRoot || `worktree:${card.id}` : workspaceRoot;
  const originScope = useCodexWorkspace.getState().scope;
  return runWorkspaceDispatch({ actionId: action.id, workspaceRoot: lockRoot, ready: () => {
    const state = useWorkLedger.getState();
    const current = state.cards.find((item) => item.id === card.id);
    const latestAction = state.actions.find((item) => item.id === action.id);
    if (options.shouldContinue?.() === false || !current || !latestAction || isNativeHostAction(latestAction)
      || isNativeHostWork(card.id, state.sessions) || actionStopReason(current, latestAction, Date.now())
      || useCodexWorkspace.getState().scope !== originScope) return null;
    const busy = state.sessions.find((session) => workContextPathKey(session.workspaceRoot) === workContextPathKey(lockRoot)
      && session.runtimeStatus === 'running' && !(action.actionKind === 'session_steer' && session.id === target?.id));
    if (busy) return t('agent.superAgent.workspaceBusyQueue', { name: busy.title || busy.nativeSessionId });
    const running = state.sessions.filter((session) => session.controlMode === 'controllable' && session.runtimeStatus === 'running'
      && !(action.actionKind === 'session_steer' && session.id === target?.id));
    return running.length >= 2 ? t('agent.superAgent.concurrencyLimitQueue') : null;
  } }, async () => {
    if (options.shouldContinue?.() === false) return { ok: false, action, error: t('agent.superAgent.serviceStopped') };
    if (useCodexWorkspace.getState().scope !== originScope) {
      return { ok: false, action, error: t('agent.superAgent.accountSwitchedNoDispatch') };
    }
    return executeSuperAgentDispatchNow({ ...options, action,
      repoRootOverride: workspaceRoot, isolateWorktree });
  }, async (reason) => {
    const current = useWorkLedger.getState().actions.find((item) => item.id === action.id);
    if (current?.state === 'prepared' && current.errorMessage !== reason) {
      await useWorkLedger.getState().transitionDispatchAction({ id: action.id, state: 'prepared', expectedState: 'prepared', errorMessage: reason });
    }
  });
}

async function executeSuperAgentDispatchNow(
  options: ExecuteSuperAgentDispatchOptions,
): Promise<ExecuteSuperAgentDispatchResult> {
  const accountScope = currentSupervisorScope();
  const runtimeScope = useCodexWorkspace.getState().scope;
  const sameAccount = () => currentSupervisorScope() === accountScope && useCodexWorkspace.getState().scope === runtimeScope;
  const assertAccount = () => {
    if (!sameAccount()) throw new Error(t('agent.superAgent.accountSwitchedCheckDelivery'));
  };
  const ledger = useWorkLedger.getState();
  const card = ledger.cards.find((c) => c.id === options.action.todoId);
  if (!card) {
    return {
      ok: false,
      action: options.action,
      error: t('agent.superAgent.targetCardMissing'),
    };
  }

  let parsedSpecText = options.specText ?? '';
  let parsedMeta: { specText?: string; runtime?: 'codex' | 'pi' | 'acp'; acpAgentId?: string } = {};
  try {
    parsedMeta = JSON.parse(options.action.specJson) as typeof parsedMeta;
  } catch {
    /* raw spec text */
  }
  if (!parsedSpecText) {
    parsedSpecText = parsedMeta.specText ?? options.action.specJson;
  }

  const targetSession = options.action.sessionId
    ? ledger.sessions.find((s) => s.id === options.action.sessionId)
    : undefined;

  const latestAction = ledger.actions.find((item) => item.id === options.action.id) ?? options.action;
  if (isNativeHostAction(latestAction) || isNativeHostWork(card.id, ledger.sessions)
    || (targetSession && isNativeHostSession(targetSession))) {
    return { ok: false, action: latestAction, error: nativeHostControlReason() };
  }
  const stopReason = actionStopReason(card, latestAction, Date.now());
  if (stopReason) {
    if (latestAction.state === 'prepared') await ledger.transitionDispatchAction({
      id: latestAction.id, state: 'canceled', expectedState: 'prepared', errorMessage: stopReason,
    });
    return { ok: false, action: latestAction, error: stopReason };
  }
  if (options.action.actionKind !== 'session_create' && (!targetSession || targetSession.controlMode !== 'controllable')) {
    return { ok: false, action: latestAction, error: t('agent.superAgent.sessionReadonlyOrUnavailable') };
  }
  if (targetSession && targetSession.runtime !== 'pi' && !targetSession.controlEndpoint?.startsWith('acp://')) {
    return { ok: false, action: latestAction, error: t('agent.superAgent.nativeNotHandedOff') };
  }
  let deliveryAttempted = false;
  const verifyBeforeDelivery = () => {
    assertAccount();
    const state = useWorkLedger.getState();
    const current = state.cards.find((item) => item.id === card.id);
    const action = state.actions.find((item) => item.id === options.action.id);
    if (!current || !action || action.state !== 'verifying_delivery') throw new Error(t('agent.superAgent.stateChangedBeforeSend'));
    if (isNativeHostAction(action) || isNativeHostWork(card.id, state.sessions)
      || state.sessions.some((session) => session.id === action.sessionId && isNativeHostSession(session))) throw new Error(nativeHostControlReason());
    const reason = actionStopReason(current, { ...action, state: 'prepared' }, Date.now());
    if (reason) throw new Error(reason);
    if (options.shouldContinue?.() === false) throw new Error(t('agent.superAgent.serviceStoppedBeforeSend'));
  };

  try {
    await ledger.transitionDispatchAction({ id: options.action.id, state: 'verifying_delivery', expectedState: 'prepared' });
  } catch (error) {
    return { ok: false, action: useWorkLedger.getState().actions.find((item) => item.id === options.action.id) ?? options.action,
      error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const shouldSpawnNewSession =
      options.action.actionKind === 'session_create' ||
      (options.isolateWorktree && !targetSession);

    let worktreeInfo: NativeManagedWorktreeInfo | undefined;
    let savedSession: NativeWorkSessionRecord | undefined;
    let receiptRef = '';
    const requestedRuntime =
      options.preferredRuntime ??
      parsedMeta.runtime ??
      (options.acpAgentId || parsedMeta.acpAgentId ? 'acp' : undefined);
    const nativeRuntime = requestedRuntime ?? 'pi';
    if (shouldSpawnNewSession && nativeRuntime === 'codex') throw new Error(t('agent.superAgent.selectCodexAcpClient'));

    if (shouldSpawnNewSession) {
      const baseRepo = resolveBaseRepoRoot(
        card,
        ledger.sessions,
        ledger.links,
        options.repoRootOverride,
      );
      if (!baseRepo) {
        throw new Error(t('agent.superAgent.noWorkspaceBound'));
      }

      let workerWorkspaceRoot = baseRepo;
      if (options.isolateWorktree && activeDrivers.isDesktop()) {
        const branchName = buildBranchNameForCard(card);
        worktreeInfo = await activeDrivers.prepareWorktree({
          repoRoot: baseRepo,
          branchName,
          slug: `card-${card.id.slice(0, 8)}`,
        });
        assertAccount();
        workerWorkspaceRoot = worktreeInfo.worktreePath;

        await useWorkLedger.getState().upsertLink({
          todoId: card.id,
          kind: 'git_branch',
          externalId: worktreeInfo.branch,
          project: card.adoProject,
          repo: null,
          rid: card.rid,
          headSha: worktreeInfo.headSha,
          title: `Worktree: ${worktreeInfo.branch}`,
          webUrl: null,
          stateSnapshot: 'isolated_worktree',
        });
      }

      if (nativeRuntime === 'acp') {
        const acpAgentId = resolveAcpAgentIdFromSession(
          targetSession,
          options.acpAgentId ?? parsedMeta.acpAgentId,
        );
        if (!acpAgentId) {
          throw new Error(t('agent.superAgent.noAcpClientConfigured'));
        }
        verifyBeforeDelivery();
        deliveryAttempted = true;
        const spawned = await activeDrivers.startAcpWorkerTask({
          agentId: acpAgentId,
          workspaceRoot: workerWorkspaceRoot,
          specText: parsedSpecText,
          title: card.title,
          todoId: card.id,
        });
        assertAccount();
        const managed = useAcpAgents.getState().sessions[spawned.sessionKey];
        const recorded = useWorkLedger.getState().sessions.find((session) => session.runtime === 'acp'
          && session.nativeSessionId === spawned.sessionId && (session.sourceScope || 'default') === (managed?.sourceScope || 'default')
          && workContextPathKey(session.workspaceRoot) === workContextPathKey(workerWorkspaceRoot));
        savedSession = await useWorkLedger.getState().upsertSession({
          ...recorded,
          todoId: card.id,
          visibility: card.state.visibility,
          runtime: 'acp',
          origin: 'rocketx_managed',
          nativeSessionId: spawned.sessionId,
          sourceScope: managed?.sourceScope || recorded?.sourceScope,
          title: card.title,
          workspaceRoot: workerWorkspaceRoot,
          environmentId: card.state.environmentId,
          accountScope: recorded?.accountScope ?? null,
          controlEndpoint: `acp://${acpAgentId}/${spawned.sessionId}`,
          controlMode: 'controllable',
          controlReason: 'owned_live_controller',
          hostDeviceId: agentDeviceId(),
          writerLeaseOwner: 'rocketx:local',
          writerLeaseExpiresAt: null,
          runtimeStatus: spawned.stopReason === 'cancelled' ? 'interrupted' : spawned.stopReason ? 'idle' : 'running',
          configSnapshotJson: buildConfigSnapshotPreservingMeta(recorded?.configSnapshotJson, {
            agentId: acpAgentId,
            ...(worktreeInfo ? { isolatedWorktree: true, branch: worktreeInfo.branch } : {}),
          }),
          lastEventSeq: 1,
          lastTurnId: null,
        });
        receiptRef = `acp:${acpAgentId}:${spawned.sessionId}`;
      } else {
        verifyBeforeDelivery();
        deliveryAttempted = true;
        const spawned = await activeDrivers.startCodexWorkerTask({
          workspaceRoot: workerWorkspaceRoot,
          specText: parsedSpecText,
          title: card.title,
        });
        assertAccount();

        savedSession = await useWorkLedger.getState().upsertSession({
          todoId: card.id,
          visibility: card.state.visibility,
          runtime: nativeRuntime,
          origin: 'rocketx_managed',
          nativeSessionId: spawned.threadId,
          title: card.title,
          workspaceRoot: workerWorkspaceRoot,
          environmentId: card.state.environmentId,
          accountScope: null,
          controlEndpoint: nativeRuntime === 'pi' ? 'pi-app-server://local' : 'codex-app-server://local',
          controlMode: 'controllable',
          controlReason: 'owned_live_controller',
          hostDeviceId: agentDeviceId(),
          writerLeaseOwner: 'rocketx:local',
          writerLeaseExpiresAt: null,
          runtimeStatus: 'running',
          configSnapshotJson: worktreeInfo
            ? JSON.stringify({ isolatedWorktree: true, branch: worktreeInfo.branch })
            : null,
          lastEventSeq: 1,
          lastTurnId: null,
        });
        receiptRef = `${nativeRuntime}:thread:${spawned.threadId}`;
      }
    } else if (!targetSession) {
      throw new Error(t('agent.superAgent.sessionUnavailableNoCreate'));
    } else if (!targetSession.workspaceRoot.trim()) {
      throw new Error(t('agent.superAgent.sessionNoWorkspace'));
    } else if (targetSession.runtime === 'acp' || targetSession.controlEndpoint?.startsWith('acp://')) {
      const acpAgentId = resolveAcpAgentIdFromSession(
        targetSession,
        options.acpAgentId ?? parsedMeta.acpAgentId,
      );
      if (!acpAgentId) {
        throw new Error(t('agent.superAgent.noLinkedAcpProfile'));
      }
      verifyBeforeDelivery();
      deliveryAttempted = true;
      const delivery = await activeDrivers.sendAcpSessionPrompt({
        agentId: acpAgentId,
        workspaceRoot: targetSession.workspaceRoot,
        sessionId: targetSession.nativeSessionId,
        specText: parsedSpecText,
        requiresColdResume: targetSession.controlMode === 'resumable',
        steer: options.action.actionKind === 'session_steer',
        todoId: card.id,
        sourceScope: targetSession.sourceScope,
        accountScope: targetSession.accountScope,
      });
      assertAccount();
      savedSession = await useWorkLedger.getState().upsertSession({
        ...targetSession,
        controlMode: 'controllable',
        controlReason: 'owned_live_controller',
        runtimeStatus: delivery.stopReason === 'cancelled' ? 'interrupted' : delivery.stopReason ? 'idle' : 'running',
        lastEventSeq: (targetSession.lastEventSeq ?? 0) + 1,
        lastTurnId: delivery.turnMarker,
      });
      receiptRef = `acp:${targetSession.nativeSessionId}:${delivery.turnMarker}`;
    } else {
      if (targetSession.runtime !== 'pi') {
        throw new Error(t('agent.superAgent.dshSidebarOnly'));
      }
      verifyBeforeDelivery();
      deliveryAttempted = true;
      const delivery = await activeDrivers.sendCodexSessionPrompt({
        workspaceRoot: targetSession.workspaceRoot,
        threadId: targetSession.nativeSessionId,
        specText: parsedSpecText,
        requiresColdResume: targetSession.controlMode === 'resumable',
      });
      assertAccount();
      savedSession = await useWorkLedger.getState().upsertSession({
        ...targetSession,
        controlMode: 'controllable',
        controlReason: 'owned_live_controller',
        runtimeStatus: 'running',
        lastEventSeq: (targetSession.lastEventSeq ?? 0) + 1,
        lastTurnId: delivery.turnMarker,
      });
      receiptRef = `${targetSession.runtime}:${targetSession.nativeSessionId}:${delivery.turnMarker}`;
    }

    const currentCard = useWorkLedger.getState().cards.find((item) => item.id === card.id);
    if (currentCard && currentCard.state.requirementsVersion === card.state.requirementsVersion
      && currentCard.state.contentVersion === card.state.contentVersion) {
      await useWorkLedger.getState().updateCard(card.id, {
        stage: currentCard.state.stage === 'triage' || currentCard.state.stage === 'ready' ? 'in_progress' : currentCard.state.stage,
        ownerKind: 'ai_dispatched', consecutiveFailures: 0,
        expectedRequirementsVersion: currentCard.state.requirementsVersion ?? 0,
        expectedContentVersion: currentCard.state.contentVersion ?? 0,
      });
    }

    const completedAction = await useWorkLedger
      .getState()
      .transitionDispatchAction({
        id: options.action.id,
        state: 'acknowledged',
        receiptRef,
      });

    return {
      ok: true,
      action: completedAction,
      session: savedSession,
      worktree: worktreeInfo,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!sameAccount()) return { ok: false, action: options.action, error: message };
    const failedAction = await useWorkLedger
      .getState()
      .transitionDispatchAction({
        id: options.action.id,
        state: deliveryAttempted ? 'verifying_delivery' : 'failed',
        errorMessage: message,
      });
    const currentCard = useWorkLedger.getState().cards.find((item) => item.id === card.id) ?? card;
    const failures = currentCard.state.consecutiveFailures + 1;
    await useWorkLedger.getState().updateCard(card.id, {
      consecutiveFailures: failures,
      waitState: deliveryAttempted ? 'waiting_input' : failures >= 2 ? 'blocked' : currentCard.state.waitState,
      waitReason:
        deliveryAttempted ? t('agent.superAgent.deliveryUnconfirmed', { message }) : failures >= 2
          ? t('agent.superAgent.consecutiveFailuresLimit', { message })
          : currentCard.state.waitReason,
    });
    return {
      ok: false,
      action: failedAction,
      error: message,
    };
  }
}

export interface SpawnCardWorkerOptions {
  todoId: string;
  instruction?: string;
  isolateWorktree?: boolean;
  importFromSessionId?: string | null;
  repoRootOverride?: string;
  runtime?: 'codex' | 'pi' | 'acp';
  acpAgentId?: string;
}

/**
 * 一键为指定工作卡片拉起受管 Worker（支持基于 Git Worktree 隔离并发，或从只读会话安全导入上下文）
 */
export async function spawnCardWorkerInWorktree(
  options: SpawnCardWorkerOptions,
): Promise<ExecuteSuperAgentDispatchResult> {
  const ledger = useWorkLedger.getState();
  const card = ledger.cards.find((c) => c.id === options.todoId);
  if (!card) {
    throw new Error(t('agent.superAgent.targetCardMissing'));
  }
  if (isNativeHostWork(card.id, ledger.sessions)) throw new Error(nativeHostControlReason());
  const workspaceRoot = resolveBaseRepoRoot(card, ledger.sessions, ledger.links, options.repoRootOverride);
  if (!workspaceRoot) throw new Error(t('agent.superAgent.noWorkspaceBound'));

  const sourceSession = options.importFromSessionId
    ? ledger.sessions.find((s) => s.id === options.importFromSessionId)
    : undefined;

  const instruction =
    options.instruction?.trim() ||
    card.state.nextStep?.trim() ||
    t('agent.superAgent.defaultSpawnInstruction');

  const specText = sourceSession
    ? buildSessionContextImportSpec({
        sourceSession,
        cardGoal: card.state.goal || card.title,
        acceptance: card.state.acceptance,
        boundaries: card.state.boundaries,
        recentTranscriptExcerpt: t('agent.superAgent.importExcerpt', { runtime: sourceSession.runtime, sessionId: sourceSession.nativeSessionId }),
        nextInstruction: instruction,
      })
    : renderDispatchSpec({
        title: card.title,
        goal: t('agent.superAgent.spawnGoal', { goal: card.state.goal || card.title, instruction }),
        acceptance:
          card.state.acceptance.length > 0
            ? card.state.acceptance
            : [t('agent.superAgent.defaultAcceptance')],
        boundaries: [
          ...card.state.boundaries,
          t('agent.superAgent.adoBoundary'),
        ],
        evidence: card.note
          ? [{ label: t('agent.superAgent.cardNoteLabel'), text: card.note }]
          : [],
      });

  const action = await ledger.prepareDispatchAction({
    idempotencyKey: `manual-spawn:${card.id}:${Date.now()}`,
    todoId: card.id,
    actionKind: 'session_create',
    specJson: JSON.stringify({
      specText,
      isolateWorktree: Boolean(options.isolateWorktree),
      workspaceRoot,
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(options.acpAgentId ? { acpAgentId: options.acpAgentId } : {}),
    }),
    requireConfirmation: false,
  });

  return executeSuperAgentDispatch({
    action,
    specText,
    isolateWorktree: options.isolateWorktree ?? true,
    repoRootOverride: options.repoRootOverride,
    preferredRuntime: options.runtime,
    acpAgentId: options.acpAgentId,
  });
}

export async function pauseCardAcpWorkflow(
  todoId: string,
  reason = t('agent.superAgent.manualPauseReason'),
): Promise<NativeWorkCard> {
  const accountScope = currentSupervisorScope();
  const ledger = useWorkLedger.getState();
  const nativeAccount = ledger.sessions.some((session) => session.todoId === todoId && isNativeHostSession(session))
    ? captureButlerRuntimeAccountContext() : null;
  const assertWorkAccount = captureWorkLedgerAccount();
  const assertAccount = () => {
    assertWorkAccount();
    if (currentSupervisorScope() !== accountScope) throw new Error(t('agent.superAgent.accountSwitchedStopStatus'));
    if (nativeAccount) {
      const current = captureButlerRuntimeAccountContext();
      if (current.accountScope !== nativeAccount.accountScope || current.generation !== nativeAccount.generation) {
        throw new Error(t('agent.superAgent.accountSwitchedStopStatus'));
      }
    }
  };
  const paused = await ledger.pauseCardAutomation(todoId, reason);
  assertAccount();
  const acp = useAcpAgents.getState();
  const running = useWorkLedger.getState().sessions.filter((session) => session.todoId === todoId
    && (isNativeHostSession(session) || ['running', 'waiting_input', 'waiting_approval'].includes(session.runtimeStatus)));
  const outcomes = await Promise.allSettled(running.map(async (session) => {
    if (isNativeHostSession(session)) {
      if (!nativeAccount) throw new Error(t('agent.superAgent.nativeOwnershipChanged'));
      const account = nativeAccount;
      assertAccount();
      const snapshot = await readNativeWorkSnapshot({ account, sessionId: session.id });
      assertAccount();
      if (!snapshot.activeTurnId) {
        if (snapshot.runtimeStatus === 'idle' || snapshot.runtimeStatus === 'interrupted') return;
        throw new Error(t('agent.superAgent.turnUnverifiedStop', { name: session.title || session.nativeSessionId }));
      }
      const card = useWorkLedger.getState().cards.find((item) => item.id === todoId);
      if (!card || snapshot.todoId !== todoId || snapshot.sessionId !== session.id) throw new Error(t('agent.superAgent.nativeBindingChanged'));
      const command = await submitNativeWork({ account, command: {
        requestId: crypto.randomUUID(), todoId, sessionId: session.id,
        expectedRequirementsVersion: card.state.requirementsVersion ?? 0,
        expectedContentVersion: card.state.contentVersion ?? 0,
        expectedBindingVersion: snapshot.bindingVersion,
        nativeTurnId: snapshot.activeTurnId, intent: { kind: 'interrupt' }, submittedBy: 'user',
      } });
      assertAccount();
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const latest = await readNativeWorkSnapshot({ account, sessionId: session.id });
        assertAccount();
        const receipt = latest.commands.find((item) => item.id === command.id);
        if (receipt?.state === 'completed') return;
        if (receipt && ['failed', 'canceled', 'verifying_delivery'].includes(receipt.state)) {
          throw new Error(receipt.errorMessage || t('agent.superAgent.nativeStopPending'));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assertAccount();
      await useWorkLedger.getState().updateCard(todoId, { waitReason: t('agent.superAgent.waitingStopReceipt', { reason }) });
      return;
    }
    if (session.runtime === 'pi') {
      await useCodexWorkspace.getState().interruptThread(session.nativeSessionId);
    } else {
      const agentId = session.controlEndpoint?.startsWith('acp://') ? resolveAcpAgentIdFromSession(session) : null;
      const managed = Object.values(acp.sessions).find((item) => item.agentId === agentId
        && matchesAcpWorkSession(session, item, resolveButlerAccountScope()));
      if (!managed) throw new Error(t('agent.superAgent.notConnectedStop', { name: session.title || session.nativeSessionId }));
      await acp.cancelTurn(managed.sessionKey);
    }
    assertAccount();
    await useWorkLedger.getState().upsertSession({ ...session, runtimeStatus: 'interrupted' });
  }));
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  assertAccount();
  if (failures.length) {
    const message = t('agent.superAgent.pausedWithErrors', { details: failures.map((outcome) => String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason)).join(t('agent.common.semicolonSep')) });
    await useWorkLedger.getState().updateCard(todoId, { waitReason: message });
    throw new Error(message);
  }
  return useWorkLedger.getState().cards.find((card) => card.id === todoId) ?? paused;
}

export async function resumeCardAcpWorkflow(todoId: string): Promise<NativeWorkCard> {
  return useWorkLedger.getState().resumeCardAutomation(todoId);
}

export async function steerAcpSessionForCard(
  todoId: string,
  instruction: string,
  acpAgentId?: string,
): Promise<ExecuteSuperAgentDispatchResult> {
  const ledger = useWorkLedger.getState();
  if (isNativeHostWork(todoId, ledger.sessions)) throw new Error(nativeHostControlReason());
  const acpSession = ledger.sessions.find(
    (s) => s.todoId === todoId && s.runtime === 'acp',
  );
  if (!acpSession) {
    return spawnCardWorkerInWorktree({
      todoId,
      instruction,
      isolateWorktree: false,
      runtime: 'acp',
      acpAgentId,
    });
  }
  const action = await ledger.prepareDispatchAction({
    idempotencyKey: `manual-steer:${todoId}:${Date.now()}`,
    todoId,
    sessionId: acpSession.id,
    actionKind: 'session_steer',
    specJson: JSON.stringify({
      specText: instruction,
      runtime: 'acp',
      ...(acpAgentId ? { acpAgentId } : {}),
    }),
    requireConfirmation: false,
  });
  return executeSuperAgentDispatch({
    action,
    specText: instruction,
    isolateWorktree: false,
    preferredRuntime: 'acp',
    acpAgentId,
  });
}

let superAgentCleanup: (() => void) | null = null;
let superAgentStart: Promise<() => void> | null = null;

interface SupervisorStorage {
  watermarks: Record<string, MessageWatermark>;
  notices: Record<string, string>;
}

function currentSupervisorScope(): string {
  return `${getServerBase() || 'local'}:${useAuth.getState().user?._id || 'local'}`;
}

/**
 * 启动 Super Agent 常驻协调桥：
 * 1. 加载统一工作账本并执行崩溃恢复对账（reconcileStartupActions）
 * 2. 同步现有共享会话与本地 Codex 线程
 * 3. 监听实时聊天流中的外部研发反馈（ADO / CI / PR），执行确定性预过滤 -> 三级关联 -> 受控自动派发或生成待确认动作
 */
export async function startSuperAgentBridge(): Promise<() => void> {
  if (superAgentCleanup) return superAgentCleanup;
  if (superAgentStart) return superAgentStart;
  superAgentStart = startWorkSupervision().finally(() => { superAgentStart = null; });
  return superAgentStart;
}

async function startWorkSupervision(): Promise<() => void> {
  const scope = currentSupervisorScope();
  const storageKey = `rocketx.work-supervisor.v1:${encodeURIComponent(scope)}`;
  let persisted: SupervisorStorage = { watermarks: {}, notices: {} };
  const raw = localStorage.getItem(storageKey);
  if (raw) persisted = { ...persisted, ...JSON.parse(raw) } as SupervisorStorage;
  const save = (patch: Partial<SupervisorStorage>) => {
    const next = { ...persisted, ...patch };
    localStorage.setItem(storageKey, JSON.stringify(next));
    persisted = next;
  };
  let active = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let backfilling: Promise<void> | undefined;
  let ready = false;
  let needsBackfill = true;
  let recovering = true;
  const reportedErrors = new Set<string>();
  const pendingMessages = new Map<string, Map<string, RcMessage>>();
  const current = () => active && currentSupervisorScope() === scope;
  const reportError = (error: unknown) => {
    if (!current()) return;
    const reason = t('agent.superAgent.supervisorCheck', { error: error instanceof Error ? error.message : String(error) });
    useWorkLedger.setState({ lastError: reason });
    if (!reportedErrors.has(reason)) {
      reportedErrors.add(reason);
      toast.error(reason);
    }
  };
  const supervisor = createWorkSupervisor({
    snapshot: () => useWorkLedger.getState(), now: Date.now,
    updateCard: (id, patch) => {
      const ledger = useWorkLedger.getState();
      if (isNativeHostWork(id, ledger.sessions)) return Promise.resolve(ledger.cards.find((card) => card.id === id)!);
      return ledger.updateCard(id, patch);
    },
    prepare: (input) => useWorkLedger.getState().prepareDispatchAction(input),
    transition: (input) => useWorkLedger.getState().transitionDispatchAction(input),
    execute: (action) => current() ? executeSuperAgentDispatch({ action, shouldContinue: current }) : Promise.resolve(),
    notify: async (card, reason) => {
      if (!current()) return;
      toast.info(`${card.title}：${reason}`);
      await desktopNotify({ title: card.title, body: reason, tag: `rocketx-work:${card.id}` });
    },
    readNotices: () => persisted.notices,
    writeNotices: (notices) => save({ notices }),
    eventsReady: () => !recovering,
  });
  const wake = () => {
    if (!current() || !ready || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      if (current() && ready) void supervisor.tick().catch(reportError);
    }, 50);
  };
  const intake = createMessageWatermarks<{ id: string; at: number; message: RcMessage }>({
    read: () => persisted.watermarks,
    write: (watermarks) => save({ watermarks }), now: Date.now,
    ingest: async ({ message }) => {
      if (!current()) throw new Error(t('agent.superAgent.watermarkBlocked'));
      const input = parseChatMessageAsExternalEvent(message);
      if (input) await useWorkLedger.getState().ingestExternalEvent(input);
    },
  });
  const observe = (rid: string, messages: RcMessage[], history: boolean) => intake.observe(rid,
    messages.filter((message) => !message.pending).map((message) => ({ id: message._id, at: tsMs(message.ts), message })), history);

  const backfill = () => {
    if (backfilling) return backfilling;
    recovering = true;
    backfilling = (async () => {
      if (!current()) return;
      if (useAuth.getState().localMode) { needsBackfill = false; recovering = false; return; }
      if (useChat.getState().connection !== 'connected') return;
      const state = useWorkLedger.getState();
      const roomIds = new Set([
        ...state.events.flatMap((event) => event.rid ? [event.rid] : []),
        ...state.cards.filter((card) => (card.state.requirementsVersion ?? 0) > 0).flatMap((card) => card.rid ? [card.rid] : []),
        ...state.links.filter((link) => state.cards.some((card) => card.id === link.todoId && (card.state.requirementsVersion ?? 0) > 0))
          .flatMap((link) => link.rid ? [link.rid] : []),
      ]);
      let incomplete = false;
      for (const rid of roomIds) {
        if (!current()) return;
        const subscription = useChat.getState().subscriptions[rid];
        if (!subscription || !['c', 'p', 'd', 'l'].includes(subscription.t)) {
          incomplete = true;
          reportError(t('agent.superAgent.backfillRoomAccess', { rid }));
          continue;
        }
        const cursor = persisted.watermarks[rid];
        const collected: RcMessage[] = [];
        let latest: string | undefined;
        while (current()) {
          const page = await rest.getHistory(rid, subscription.t as RoomType, 100, latest);
          collected.push(...page);
          if (!cursor || page.length < 100 || (page[0] && tsMs(page[0].ts) <= cursor.at)) break;
          const next = new Date(tsMs(page[0].ts)).toISOString();
          if (next === latest) throw new Error(t('agent.superAgent.backfillPaginationStalled', { room: subscription.fname || subscription.name }));
          latest = next;
        }
        if (current()) await observe(rid, collected, true);
      }
      for (const [rid, messages] of pendingMessages) {
        while (messages.size && current()) {
          const batch = [...messages.values()];
          messages.clear();
          await observe(rid, batch, false);
        }
      }
      pendingMessages.clear();
      needsBackfill = incomplete;
      recovering = false;
      wake();
    })().finally(() => { backfilling = undefined; });
    return backfilling;
  };
  const unsubscribeChat = useChat.subscribe((state, previous) => {
    if (!current()) return;
    if (state.connection !== 'connected' && previous.connection === 'connected') { needsBackfill = true; recovering = true; }
    if (state.connection === 'connected' && previous.connection !== 'connected') {
      needsBackfill = true;
      void backfill().catch(reportError);
    }
    for (const [rid, messages] of Object.entries(state.messages)) {
      const before = previous.messages[rid] ?? [];
      if (messages === before) continue;
      const history = !previous.historyLoaded[rid] && Boolean(state.historyLoaded[rid]);
      const changes = agentMessageBridgeChanges(messages, before, history);
      if (recovering) {
        const queued = pendingMessages.get(rid) ?? new Map<string, RcMessage>();
        for (const message of history ? changes.ingestOnly : changes.handle) queued.set(message._id, message);
        pendingMessages.set(rid, queued);
        continue;
      }
      void observe(rid, history ? changes.ingestOnly : changes.handle, history).then(wake).catch(reportError);
    }
  });
  const unsubscribeLedger = useWorkLedger.subscribe(wake);
  const cleanup = () => {
    if (!active) return;
    active = false;
    supervisor.stop();
    if (timer) clearInterval(timer);
    if (wakeTimer) clearTimeout(wakeTimer);
    unsubscribeChat(); unsubscribeLedger();
    if (superAgentCleanup === cleanup) superAgentCleanup = null;
  };
  superAgentCleanup = cleanup;
  const poll = () => {
    if (polling || !current()) return polling;
    polling = (async () => {
      if (!ready) {
        await useWorkLedger.getState().hydrate();
        if (useWorkLedger.getState().lastError) return;
      }
      await syncLiveSessionsIntoLedger();
      if (!current()) return;
      await useWorkLedger.getState().reconcileStartupActions();
      const { observeWorkArtifacts } = await import('./workArtifacts');
      const artifactSnapshots = new Map<string, Promise<NativeWorkspaceGitSnapshot>>();
      const inspect = (workspaceRoot: string) => {
        const key = workContextPathKey(workspaceRoot);
        let snapshot = artifactSnapshots.get(key);
        if (!snapshot) {
          snapshot = activeDrivers.inspectWorkspaceGit(workspaceRoot);
          artifactSnapshots.set(key, snapshot);
        }
        return snapshot;
      };
      for (const card of useWorkLedger.getState().cards) {
        if (!current()) return;
        if (activeDrivers.isDesktop() && (card.state.requirementsVersion ?? 0) > 0
          && useWorkLedger.getState().sessions.some((session) => session.todoId === card.id && session.workspaceRoot)) {
          await observeWorkArtifacts(card.id, { inspect }).catch((error) => {
            reportError(t('agent.superAgent.artifactObserveFailed', { title: card.title, error: error instanceof Error ? error.message : String(error) }));
          });
        }
      }
      ready = true;
      if (needsBackfill) await backfill().catch(reportError);
      if (!current()) return;
      await supervisor.tick();
      const { reconcileExternalWorkActions } = await import('./externalWorkActions');
      await reconcileExternalWorkActions();
    })().catch(reportError).finally(() => { polling = undefined; });
    return polling;
  };
  try {
    for (const rid of Object.keys(useChat.getState().subscriptions)) {
      if (!persisted.watermarks[rid]) await observe(rid, [], true);
    }
    await useWorkLedger.getState().hydrate();
    if (!current()) return cleanup;
    for (const [rid, messages] of Object.entries(useChat.getState().messages)) {
      if (!persisted.watermarks[rid]) await observe(rid, messages, true);
    }
    void poll();
    if (current()) timer = setInterval(() => { void poll(); }, 15_000);
    return cleanup;
  } catch (error) {
    reportError(error);
    // 暂时断线不注销后台；下一次重连或定时检查继续原账本，不重复创建动作。
    if (current()) timer = setInterval(() => { void backfill().catch(reportError); void poll(); }, 15_000);
    return cleanup;
  }
}

export function stopSuperAgentBridge(): void {
  superAgentCleanup?.();
}
