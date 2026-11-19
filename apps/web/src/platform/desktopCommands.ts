import { invoke } from '@tauri-apps/api/core';
import { beginButlerAccountSelection, captureButlerRuntimeAccountContext, isButlerAccountReady, runWithButlerAccount } from './butlerAccountReady';
import type { RuntimeAccountContext } from './butlerAccountReady';
import type { WorkRuntimeEventsPage } from './workRuntimeEvents';
import type { NativeWorkSnapshot, NativeWorkSnapshotInput, NativeWorkStartInput, NativeWorkResumeInput, NativeWorkSubmitInput, NativeWorkAnswerInput, NativeWorkCancelQueuedInput } from './nativeWorkRuntime';

export interface AgentBotConfigStatus {
  enabled: boolean;
  serverUrl?: string;
  userId?: string;
  username?: string;
}

export interface ReverseMcpConfigStatus {
  enabled: boolean;
  serverUrl?: string;
  userId?: string;
  command?: string;
}

export interface NativeTodoRecord {
  id: string;
  source: 'manual' | 'message' | 'ado';
  rid: string | null;
  mid: string | null;
  adoWorkItemId: number | null;
  adoProject: string | null;
  title: string;
  note: string | null;
  roomName: string | null;
  author: string | null;
  done: boolean;
  priority: number;
  due: string | null;
  createdAt: number;
  doneAt: number | null;
  updatedAt: number;
  committedTo: string | null;
  waitingFor: string | null;
}

export async function readAgentBotConfig(): Promise<AgentBotConfigStatus> {
  return invoke<AgentBotConfigStatus>('agent_bot_config_status');
}

export async function saveAgentBotConfig(input: {
  serverUrl: string;
  userId: string;
  username: string;
  authToken: string;
}): Promise<void> {
  await invoke('agent_bot_config_set', input);
}

export async function deleteAgentBotConfig(): Promise<void> {
  await invoke('agent_bot_config_delete');
}

export async function readReverseMcpConfig(): Promise<ReverseMcpConfigStatus> {
  return invoke<ReverseMcpConfigStatus>('mcp_config_status');
}

export async function enableReverseMcp(input: {
  serverUrl: string;
  userId: string;
  authToken: string;
}): Promise<void> {
  await invoke('mcp_config_enable', input);
}

export async function disableReverseMcp(): Promise<void> {
  await invoke('mcp_config_disable');
}

export async function openDownloadedPath(path: string, reveal: boolean): Promise<void> {
  await invoke(reveal ? 'download_history_reveal' : 'download_history_open', { path });
}

export async function readCodexDefaultWorkspace(): Promise<string> {
  return invoke<string>('codex_default_workspace');
}

export async function readCodexButlerWorkspace(): Promise<string> {
  return invoke<string>('codex_butler_workspace');
}

export async function readCodexArtifact(workspaceRoot: string, path: string): Promise<string> {
  return invoke<string>('codex_artifact_read', { workspaceRoot, path });
}

export async function openCodexArtifact(workspaceRoot: string, path: string): Promise<void> {
  await invoke('codex_artifact_open', { workspaceRoot, path });
}

export async function revealCodexArtifact(workspaceRoot: string, path: string): Promise<void> {
  await invoke('codex_artifact_reveal', { workspaceRoot, path });
}

export async function addNativeTodo(todo: Record<string, unknown>): Promise<NativeTodoRecord> {
  return runWithButlerAccount(() => invoke<NativeTodoRecord>('butler_todo_add', { todo }));
}

export async function createNativeWorkCard(input: Record<string, unknown>): Promise<NativeWorkCard> {
  return invoke<NativeWorkCard>('butler_work_card_create', { input });
}

export async function updateNativeTodo(
  id: string,
  patch: Record<string, unknown>,
): Promise<NativeTodoRecord> {
  return runWithButlerAccount(() => invoke<NativeTodoRecord>('butler_todo_update', { id, patch }));
}

export async function deleteNativeTodo(id: string): Promise<void> {
  await runWithButlerAccount(() => invoke('butler_todo_delete', { id }));
}

export async function listNativeTodos(): Promise<NativeTodoRecord[]> {
  return runWithButlerAccount(() => invoke<NativeTodoRecord[]>('butler_todo_list', { filter: {} }));
}

let butlerAccountSelectionQueue: Promise<void> = Promise.resolve();
export async function readNativeButlerRuntimeAccountContext(): Promise<RuntimeAccountContext> {
  return invoke<RuntimeAccountContext>('butler_runtime_account_context');
}

// Native work owns execution; these calls only submit intent or read its projection.
export function readNativeWorkSnapshot(input: NativeWorkSnapshotInput): Promise<NativeWorkSnapshot> {
  return runWithButlerAccount(() => invoke<NativeWorkSnapshot>('butler_native_work_snapshot', { input }));
}

export function startNativeWork(input: NativeWorkStartInput): Promise<NativeWorkSnapshot> {
  return runWithButlerAccount(() => invoke<NativeWorkSnapshot>('butler_native_work_start', { input }));
}

export function resumeNativeWork(input: NativeWorkResumeInput): Promise<NativeWorkSnapshot> {
  return runWithButlerAccount(() => invoke<NativeWorkSnapshot>('butler_native_work_resume', { input }));
}

export function submitNativeWork(input: NativeWorkSubmitInput): Promise<NativeDispatchActionRecord> {
  return runWithButlerAccount(() => invoke<NativeDispatchActionRecord>('butler_native_work_submit', { input }));
}

export function answerNativeWork(input: NativeWorkAnswerInput): Promise<NativeWorkSnapshot> {
  return runWithButlerAccount(() => invoke<NativeWorkSnapshot>('butler_native_work_answer', { input }));
}

export function cancelQueuedNativeWork(input: NativeWorkCancelQueuedInput): Promise<NativeDispatchActionRecord> {
  return runWithButlerAccount(() => invoke<NativeDispatchActionRecord>('butler_native_work_cancel_queued', { input }));
}

export async function readWorkRuntimeEvents(query: {
  afterSequence: number;
  limit?: number;
  todoId?: string;
}): Promise<WorkRuntimeEventsPage> {
  if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0
    || !Number.isInteger(query.limit ?? 100) || (query.limit ?? 100) < 1 || (query.limit ?? 100) > 500) {
    throw new Error('事件游标必须非负，每页范围为 1–500');
  }
  const account = captureButlerRuntimeAccountContext();
  return runWithButlerAccount(() => invoke<WorkRuntimeEventsPage>('butler_work_runtime_events', {
    query: { account, afterSequence: query.afterSequence, limit: query.limit ?? 100, todoId: query.todoId ?? null },
  }));
}

export async function selectNativeButlerAccount(accountScope: string): Promise<void> {
  if (isButlerAccountReady(accountScope)) return;
  const selection = beginButlerAccountSelection(accountScope);
  const selected = butlerAccountSelectionQueue.then(async () => {
    selection.assertCurrent();
    try {
      const context = await invoke<RuntimeAccountContext>('butler_db_select_account', { accountScope });
      selection.activate(context);
    } catch (error) {
      selection.fail(error);
      throw error;
    }
  });
  butlerAccountSelectionQueue = selected.catch(() => undefined);
  await selected;
}

export async function migrateNativeTodos(json: string): Promise<number> {
  return runWithButlerAccount(() => invoke<number>('butler_todo_migrate_from_json', { json }));
}

export async function showMainWindow(): Promise<void> {
  await invoke('show_main_window');
}

export async function takePendingNotificationNavigation(): Promise<unknown | null> {
  return invoke<unknown | null>('take_pending_notification_navigation');
}

export async function sendAgentBotMessage(input: Record<string, unknown>): Promise<unknown | null> {
  return invoke<unknown | null>('agent_bot_send', input);
}

export type WorkCardVisibility = 'private' | 'room_shared';
export type WorkCardStage = 'triage' | 'ready' | 'in_progress' | 'verifying' | 'done';
export type WorkCardWaitState =
  | 'none'
  | 'waiting_input'
  | 'waiting_approval'
  | 'waiting_external'
  | 'blocked'
  | 'paused'
  | 'canceled';
export type WorkCardOwnerKind = 'human' | 'ai_suggested' | 'ai_dispatched';
export type WorkCardAutonomyMode = 'readonly' | 'confirm' | 'autonomous';

export interface NativeWorkCardState {
  todoId: string;
  /** 0/absent keeps ordinary todos outside managed execution. */
  requirementsVersion?: number;
  contentVersion?: number;
  deadlineAt?: number | null;
  visibility: WorkCardVisibility;
  stage: WorkCardStage;
  waitState: WorkCardWaitState;
  waitReason: string | null;
  goal: string | null;
  ownerKind: WorkCardOwnerKind;
  projectKey: string | null;
  environmentId: string | null;
  acceptance: string[];
  boundaries: string[];
  dependsOn: string[];
  nextStep: string | null;
  nextCheckAt: number | null;
  lastVerifiedAt: number | null;
  autonomyMode: WorkCardAutonomyMode;
  maxAutoTurns: number;
  autoTurnsUsed: number;
  consecutiveFailures: number;
  revokedAt: number | null;
  updatedAt: number;
}

export interface NativeWorkCard extends NativeTodoRecord {
  state: NativeWorkCardState;
}

export type WorkLinkKind =
  | 'message'
  | 'discussion'
  | 'kanban_card'
  | 'ado_work_item'
  | 'ado_pr'
  | 'ci_build'
  | 'git_branch';

export interface NativeWorkLink {
  id: string;
  todoId: string;
  kind: WorkLinkKind;
  externalId: string;
  project: string | null;
  repo: string | null;
  rid: string | null;
  headSha: string | null;
  title: string | null;
  webUrl: string | null;
  stateSnapshot: string | null;
  lastVerifiedAt: number;
  createdAt: number;
}

export type WorkSessionControlMode = 'readonly' | 'resumable' | 'controllable';
export type WorkSessionRuntime = 'codex' | 'deepseek' | 'dsh' | 'pi' | 'acp';

export interface NativeWorkSessionRecord {
  id: string;
  sourceScope?: string;
  todoId: string | null;
  visibility: WorkCardVisibility;
  runtime: WorkSessionRuntime;
  origin:
    | 'rocketx_managed'
    | 'native_cli'
    | 'native_desktop'
    | 'butler'
    | 'shared_room'
    | 'scheduled'
    | 'external_discovered';
  nativeSessionId: string;
  title: string | null;
  workspaceRoot: string;
  environmentId: string | null;
  accountScope: string | null;
  controlEndpoint: string | null;
  controlMode: WorkSessionControlMode;
  controlReason: string | null;
  hostDeviceId: string | null;
  writerLeaseOwner: string | null;
  writerLeaseExpiresAt: number | null;
  runtimeStatus:
    | 'idle'
    | 'running'
    | 'waiting_input'
    | 'waiting_approval'
    | 'stopped'
    | 'error'
    | 'ended'
    | 'interrupted'
    | 'unknown';
  configSnapshotJson: string | null;
  lastEventSeq: number | null;
  lastTurnId: string | null;
  lastVerifiedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type WorkEvidenceKind =
  | 'test_run'
  | 'ci_build'
  | 'pr_status'
  | 'diff_check'
  | 'manual_note'
  | 'agent_report'
  | 'pull_request'
  | 'git_commit'
  | 'manual_ack';

export interface NativeWorkEvidence {
  id: string;
  todoId: string;
  sessionId: string | null;
  kind: WorkEvidenceKind;
  title: string;
  summary: string | null;
  headSha: string | null;
  workspaceRoot: string | null;
  webUrl: string | null;
  passed: boolean;
  stale: boolean;
  staleReason: string | null;
  verifiedAt: number;
  createdAt: number;
  criterionIds?: string[];
  requirementsVersion?: number;
  contentVersion?: number;
  acceptedBy?: string | null;
  acceptanceScope?: string[];
}

export type ExternalEventCorrelationTier = 'exact' | 'heuristic' | 'unmatched';
export type ExternalEventStatus =
  | 'received'
  | 'superseded'
  | 'correlated'
  | 'verified_stale'
  | 'pending_approval'
  | 'dispatched'
  | 'done'
  | 'failed';

export interface NativeExternalEventRecord {
  id: string;
  dedupeKey: string;
  source: string;
  eventType: string;
  resourceKey: string;
  resourceVersion: number;
  project: string | null;
  repo: string | null;
  branch: string | null;
  commitSha: string | null;
  workItemId: number | null;
  prId: number | null;
  buildId: number | null;
  rid: string | null;
  todoId: string | null;
  correlationTier: ExternalEventCorrelationTier;
  payloadJson: string;
  status: ExternalEventStatus;
  statusDetail: string | null;
  occurredAt: number;
  processedAt: number | null;
}

export interface NativeExternalEventIngestResult {
  duplicate: boolean;
  event: NativeExternalEventRecord;
}

export type DispatchActionKind =
  | 'session_create'
  | 'session_resume'
  | 'session_prompt'
  | 'session_steer'
  | 'session_interrupt'
  | 'ado_comment'
  | 'ado_state_write'
  | 'rc_report';

export type DispatchActionState =
  | 'awaiting_approval'
  | 'prepared'
  | 'dispatched'
  | 'verifying_delivery'
  | 'acknowledged'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface NativeDispatchActionRecord {
  id: string;
  idempotencyKey: string;
  todoId: string;
  eventId: string | null;
  sessionId: string | null;
  actionKind: DispatchActionKind;
  specJson: string;
  baselineMarker: string | null;
  state: DispatchActionState;
  receiptRef: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NativeWorkLedgerSnapshot {
  cards: NativeWorkCard[];
  links: NativeWorkLink[];
  sessions: NativeWorkSessionRecord[];
  evidences: NativeWorkEvidence[];
  events: NativeExternalEventRecord[];
  actions: NativeDispatchActionRecord[];
}

export async function readNativeWorkLedgerSnapshot(): Promise<NativeWorkLedgerSnapshot> {
  return invoke<NativeWorkLedgerSnapshot>('butler_work_ledger_snapshot');
}

export async function updateNativeWorkCard(
  todoId: string,
  patch: Record<string, unknown>,
): Promise<NativeWorkCard> {
  return invoke<NativeWorkCard>('butler_work_card_update', { id: todoId, patch });
}

export async function upsertNativeWorkLink(
  input: Record<string, unknown>,
): Promise<NativeWorkLink> {
  return invoke<NativeWorkLink>('butler_work_link_upsert', { link: input });
}

export async function upsertNativeWorkSession(
  input: Record<string, unknown>,
): Promise<NativeWorkSessionRecord> {
  return invoke<NativeWorkSessionRecord>('butler_work_session_upsert', { session: input });
}

export async function addNativeWorkEvidence(
  input: Record<string, unknown>,
): Promise<NativeWorkEvidence> {
  return invoke<NativeWorkEvidence>('butler_work_evidence_add', { evidence: input });
}

export async function ingestNativeExternalEvent(
  input: Record<string, unknown>,
): Promise<NativeExternalEventIngestResult> {
  return invoke<NativeExternalEventIngestResult>('butler_external_event_ingest', { event: input });
}

export async function prepareNativeDispatchAction(
  input: Record<string, unknown>,
): Promise<NativeDispatchActionRecord> {
  return invoke<NativeDispatchActionRecord>('butler_dispatch_action_prepare', { action: input });
}

export async function transitionNativeDispatchAction(
  input: Record<string, unknown>,
): Promise<NativeDispatchActionRecord> {
  return invoke<NativeDispatchActionRecord>('butler_dispatch_action_transition', { transition: input });
}


export interface NativeWorkspaceGitSnapshot {
  contentFingerprint: string;
  workspaceRoot: string;
  repoTopLevel: string;
  branch: string | null;
  headSha: string | null;
  isWorktree: boolean;
  dirtyFiles: string[];
  diffStat: string | null;
  recentCommits: string[];
}

export interface NativeManagedWorktreeInfo {
  worktreePath: string;
  repoTopLevel: string;
  branch: string;
  headSha: string;
  reused: boolean;
}

export async function inspectNativeWorkspaceGit(
  workspaceRoot: string,
): Promise<NativeWorkspaceGitSnapshot> {
  return invoke<NativeWorkspaceGitSnapshot>('butler_workspace_git_inspect', { workspaceRoot });
}

export async function prepareNativeWorktree(input: {
  repoRoot: string;
  branchName: string;
  baseRef?: string | null;
  slug?: string | null;
}): Promise<NativeManagedWorktreeInfo> {
  return invoke<NativeManagedWorktreeInfo>('butler_worktree_prepare', { input });
}

export async function removeNativeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  await invoke('butler_worktree_remove', { repoRoot, worktreePath });
}

export type PiProviderPreset =
  | 'deepseek'
  | 'custom-openai'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter';

export interface PiConfigView {
  provider: PiProviderPreset;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint?: string | null;
  defaultModel: string;
  extraModels: string[];
  manualPath?: string | null;
}

export interface PiConfigWriteInput {
  provider?: PiProviderPreset;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  extraModels?: string[];
  manualPath?: string;
}

export interface PiRuntimeProbe {
  ready: boolean;
  version?: string | null;
  nodePath?: string | null;
  nodeVersion?: string | null;
  packagePath?: string | null;
  source?: 'manual' | 'bundled' | 'standard' | 'system' | null;
  configuredProvider: string;
  defaultModel: string;
  hasCredentials: boolean;
  reason?: string | null;
}

export async function probePiRuntime(manualPath?: string | null): Promise<PiRuntimeProbe> {
  return invoke<PiRuntimeProbe>('pi_runtime_probe', { manualPath: manualPath ?? null });
}

export async function readPiConfig(): Promise<PiConfigView> {
  return invoke<PiConfigView>('pi_config_read');
}

export async function writePiConfig(input: PiConfigWriteInput): Promise<PiConfigView> {
  return invoke<PiConfigView>('pi_config_write', { input });
}

// ============================================================================
// ACP (Agent Client Protocol) 本地 Agent 客户端与托管进程 / 工作区能力
// ============================================================================

export type AcpAgentPreset =
  | 'codex-acp'
  | 'antigravity'
  | 'claude-code'
  | 'kimi-cli'
  | 'copilot-cli'
  | 'gemini-cli'
  | 'opencode'
  | 'goose'
  | 'qwen-code'
  | 'dsh'
  | 'custom';

export interface AcpAgentProfile {
  id: string;
  sourceScope?: string | null;
  name: string;
  preset: string;
  command: string;
  args: string[];
  cwd: string | null;
  envKeys: string[];
  enabled: boolean;
  autoApproveSafeReads: boolean;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AcpAgentUpsertInput {
  id?: string | null;
  name: string;
  preset: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  clearEnvKeys?: string[];
  enabled?: boolean;
  autoApproveSafeReads?: boolean;
  description?: string | null;
}

export interface AcpDiscoveredCandidate {
  preset: string;
  name: string;
  command: string;
  args: string[];
  resolvedPath: string;
  version: string | null;
  alreadyRegistered: boolean;
}

export interface AcpAgentProbeResult {
  agentId: string;
  ready: boolean;
  resolvedPath: string | null;
  version: string | null;
  reason: string | null;
}

export interface AcpProcessInfo {
  processId: string;
  agentId: string;
  agentName: string;
  workspaceRoot: string;
  startedAt: number;
}

export interface DiscoveredLocalSession {
  provider: 'antigravity' | 'codex' | 'claude' | 'pi' | string;
  preset: string;
  nativeSessionId: string;
  title: string;
  preview: string | null;
  workspaceRoot: string;
  runtimeStatus: 'running' | 'idle' | string;
  createdAt: number;
  updatedAt: number;
  stepCount: number | null;
  sourcePath: string | null;
  sourceScope?: string;
  executionProfileId?: string | null;
}

export interface NativeResumeAuthorization {
  token: string;
  sessionId: string;
  sourceScope: string;
  accountScope: string;
  hostDeviceId: string;
}

export interface LocalSessionMessage {
  id: string;
  role: 'user' | 'assistant' | string;
  text: string;
  timestamp: number;
}

export interface AcpTerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface AcpTerminalOutputSnapshot {
  output: string;
  truncated: boolean;
  exitStatus: AcpTerminalExitStatus | null;
}

export async function acpAgentList(): Promise<AcpAgentProfile[]> {
  return invoke<AcpAgentProfile[]>('acp_agent_list');
}

export async function acpAgentDiscover(): Promise<AcpDiscoveredCandidate[]> {
  return invoke<AcpDiscoveredCandidate[]>('acp_agent_discover');
}

export async function acpAgentUpsert(input: AcpAgentUpsertInput): Promise<AcpAgentProfile> {
  return invoke<AcpAgentProfile>('acp_agent_upsert', { input });
}

export async function acpAgentDelete(agentId: string): Promise<boolean> {
  return invoke<boolean>('acp_agent_delete', { agentId });
}

export async function acpAgentProbe(agentId: string): Promise<AcpAgentProbeResult> {
  return invoke<AcpAgentProbeResult>('acp_agent_probe', { agentId });
}

export async function acpProcessStart(
  agentId: string,
  workspaceRoot: string,
  nativeResume?: NativeResumeAuthorization,
): Promise<AcpProcessInfo> {
  return invoke<AcpProcessInfo>('acp_process_start', { agentId, workspaceRoot, nativeResume: nativeResume ?? null });
}

/** Only call after the user explicitly confirms the original Codex has stopped. */
export async function acpLocalSessionHandoff(input: Omit<NativeResumeAuthorization, 'token'> & { workspaceRoot: string; profileId: string }): Promise<NativeResumeAuthorization> {
  const token = await invoke<string>('acp_local_session_handoff', input);
  return { ...input, token };
}

export async function acpProcessWrite(processId: string, line: string): Promise<void> {
  await invoke('acp_process_write', { processId, line });
}

export async function acpProcessStop(processId: string): Promise<void> {
  await invoke('acp_process_stop', { processId });
}

export async function acpProcessList(): Promise<AcpProcessInfo[]> {
  return invoke<AcpProcessInfo[]>('acp_process_list');
}

export async function acpLocalSessionsDiscover(
  limit = 120,
): Promise<DiscoveredLocalSession[]> {
  return invoke<DiscoveredLocalSession[]>('acp_local_sessions_discover', { limit });
}

export async function acpLocalSessionMessages(input: {
  provider: string;
  sessionId: string;
  sourcePath?: string | null;
  sourceScope?: string;
  limit?: number;
}): Promise<LocalSessionMessage[]> {
  return invoke<LocalSessionMessage[]>('acp_local_session_messages', {
    provider: input.provider,
    sessionId: input.sessionId,
    sourcePath: input.sourcePath ?? null,
    sourceScope: input.sourceScope ?? null,
    limit: input.limit ?? 24,
  });
}

export async function acpFsReadTextFile(
  workspaceRoot: string,
  path: string,
  line?: number | null,
  limit?: number | null,
): Promise<string> {
  return invoke<string>('acp_fs_read_text_file', {
    workspaceRoot,
    path,
    line: line ?? null,
    limit: limit ?? null,
  });
}

export async function acpFsWriteTextFile(
  workspaceRoot: string,
  path: string,
  content: string,
): Promise<void> {
  await invoke('acp_fs_write_text_file', { workspaceRoot, path, content });
}

export async function acpTerminalCreate(input: {
  workspaceRoot: string;
  command: string;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  outputByteLimit?: number | null;
}): Promise<string> {
  return invoke<string>('acp_terminal_create', {
    workspaceRoot: input.workspaceRoot,
    command: input.command,
    args: input.args ?? null,
    cwd: input.cwd ?? null,
    env: input.env ?? null,
    outputByteLimit: input.outputByteLimit ?? null,
  });
}

export async function acpTerminalOutput(
  terminalId: string,
): Promise<AcpTerminalOutputSnapshot> {
  return invoke<AcpTerminalOutputSnapshot>('acp_terminal_output', { terminalId });
}

export async function acpTerminalWaitForExit(
  terminalId: string,
  timeoutMs?: number | null,
): Promise<AcpTerminalExitStatus> {
  return invoke<AcpTerminalExitStatus>('acp_terminal_wait_for_exit', {
    terminalId,
    timeoutMs: timeoutMs ?? null,
  });
}

export async function acpTerminalKill(terminalId: string): Promise<void> {
  await invoke('acp_terminal_kill', { terminalId });
}

export async function acpTerminalRelease(terminalId: string): Promise<void> {
  await invoke('acp_terminal_release', { terminalId });
}

// ============================================================================
// 管家长期记忆与个人助理摘要 (Butler Memory & Assistant Digests)
// ============================================================================

export type ButlerMemoryCategory =
  | 'preference'
  | 'project_fact'
  | 'workflow_habit'
  | 'person_context'
  | 'episodic_summary';

export type ButlerMemorySourceKind =
  | 'manual'
  | 'conversation'
  | 'workflow_report'
  | 'assistant_review';

export interface ButlerMemoryEntry {
  id: string;
  accountScope: string;
  category: ButlerMemoryCategory;
  title: string;
  content: string;
  tags: string[];
  workspaceRoot: string | null;
  sourceKind: ButlerMemorySourceKind;
  sourceRef: string | null;
  pinned: boolean;
  confidence: number;
  enabled: boolean;
  recallCount: number;
  lastRecalledAt: number | null;
  createdAt: number;
  updatedAt: number;
  supersededBy?: string | null;
  expiresAt?: number | null;
}

export interface ButlerMemoryUpsertInput {
  id?: string | null;
  accountScope: string;
  category: ButlerMemoryCategory;
  title: string;
  content: string;
  tags?: string[];
  workspaceRoot?: string | null;
  sourceKind: ButlerMemorySourceKind;
  sourceRef?: string | null;
  pinned?: boolean;
  confidence?: number;
  enabled?: boolean;
  supersedesId?: string | null;
  expiresAt?: number | null;
}

export interface ButlerMemoryFilter {
  accountScope: string;
  category?: ButlerMemoryCategory | null;
  workspaceRoot?: string | null;
  query?: string | null;
  enabledOnly?: boolean;
}

export type ButlerAssistantDigestKind =
  | 'morning_brief'
  | 'evening_review'
  | 'workflow_report'
  | 'focus_digest';

export interface ButlerAssistantDigest {
  id: string;
  accountScope: string;
  kind: ButlerAssistantDigestKind;
  dateKey: string;
  title: string;
  summaryMd: string;
  metricsJson: string;
  actionItemsJson: string;
  relatedTodoId: string | null;
  relatedSessionId: string | null;
  createdAt: number;
}

export interface ButlerAssistantDigestInput {
  id?: string | null;
  accountScope: string;
  kind: ButlerAssistantDigestKind;
  dateKey: string;
  title: string;
  summaryMd: string;
  metricsJson?: string;
  actionItemsJson?: string;
  relatedTodoId?: string | null;
  relatedSessionId?: string | null;
}

export async function butlerMemoryList(
  filter: ButlerMemoryFilter,
): Promise<ButlerMemoryEntry[]> {
  return invoke<ButlerMemoryEntry[]>('butler_memory_list', {
    accountScope: filter.accountScope,
    category: filter.category ?? null,
    workspaceRoot: filter.workspaceRoot ?? null,
    query: filter.query ?? null,
    enabledOnly: filter.enabledOnly ?? null,
  });
}

export async function butlerMemoryUpsert(
  input: ButlerMemoryUpsertInput,
): Promise<ButlerMemoryEntry> {
  return invoke<ButlerMemoryEntry>('butler_memory_upsert', { input });
}

export async function butlerMemoryDelete(id: string): Promise<boolean> {
  return invoke<boolean>('butler_memory_delete', { id });
}

export async function butlerMemoryMarkRecalled(ids: string[]): Promise<number> {
  return invoke<number>('butler_memory_mark_recalled', { ids });
}

export async function butlerMemoryClearScope(accountScope: string): Promise<number> {
  return invoke<number>('butler_memory_clear_scope', { accountScope });
}

export async function butlerAssistantDigestList(input: {
  accountScope: string;
  kind?: ButlerAssistantDigestKind | null;
  limit?: number | null;
}): Promise<ButlerAssistantDigest[]> {
  return invoke<ButlerAssistantDigest[]>('butler_assistant_digest_list', {
    accountScope: input.accountScope,
    kind: input.kind ?? null,
    limit: input.limit ?? null,
  });
}

export async function butlerAssistantDigestSave(
  input: ButlerAssistantDigestInput,
): Promise<ButlerAssistantDigest> {
  return invoke<ButlerAssistantDigest>('butler_assistant_digest_save', { input });
}

export async function butlerAssistantDigestDelete(id: string): Promise<boolean> {
  return invoke<boolean>('butler_assistant_digest_delete', { id });
}
