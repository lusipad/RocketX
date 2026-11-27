import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import {
  beginButlerAccountSelection,
  captureButlerRuntimeAccountContext,
  isButlerAccountReady,
  runWithButlerAccount,
  runWithButlerAccountIfManaged,
} from './butlerAccountReady';
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
    throw new Error(t('nav.desktopCommands.invalidEventCursor'));
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

export interface GitDiffFileSummary {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
}

export interface GitWorkspaceDiff {
  workspaceRoot: string;
  repoTopLevel: string;
  branch: string | null;
  headSha: string | null;
  baseRef: string | null;
  compareRef: string | null;
  ahead: number;
  behind: number;
  totalAdditions: number;
  totalDeletions: number;
  files: GitDiffFileSummary[];
  truncatedTotal: boolean;
}

export interface GitCheckpointRecord {
  id: string;
  refName: string;
  commitSha: string;
  treeSha: string;
  label: string;
  turnId: string | null;
  createdAt: number;
  changedFiles: number;
}

export interface GitCommitResult {
  commitSha: string;
  branch: string | null;
  summary: string;
}

export interface GitPushResult {
  remote: string;
  branch: string;
  output: string;
}

export interface GitCreatePrResult {
  created: boolean;
  url: string | null;
  fallbackCompareUrl: string | null;
  message: string;
}

export interface GitWorktreeItem {
  path: string;
  headSha: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isCurrent: boolean;
  isManaged: boolean;
}

export interface GitBranchItem {
  name: string;
  current: boolean;
  upstream: string | null;
}

export async function diffWorkspaceGit(
  workspaceRoot: string,
  baseRef?: string | null,
): Promise<GitWorkspaceDiff> {
  return invoke<GitWorkspaceDiff>('butler_git_diff_workspace', {
    workspaceRoot,
    baseRef: baseRef ?? null,
  });
}

export async function createGitCheckpoint(
  workspaceRoot: string,
  label: string,
  turnId?: string | null,
): Promise<GitCheckpointRecord> {
  return invoke<GitCheckpointRecord>('butler_git_checkpoint_create', {
    workspaceRoot,
    label,
    turnId: turnId ?? null,
  });
}

export async function listGitCheckpoints(
  workspaceRoot: string,
): Promise<GitCheckpointRecord[]> {
  const res = await invoke<GitCheckpointRecord[] | null>('butler_git_checkpoint_list', { workspaceRoot });
  return Array.isArray(res) ? res : [];
}

export async function diffGitCheckpoints(
  workspaceRoot: string,
  fromRef: string,
  toRef?: string | null,
): Promise<GitWorkspaceDiff> {
  return invoke<GitWorkspaceDiff>('butler_git_checkpoint_diff', {
    workspaceRoot,
    fromRef,
    toRef: toRef ?? null,
  });
}

export async function revertGitCheckpoint(
  workspaceRoot: string,
  checkpointId: string,
  mode: 'working_tree' = 'working_tree',
): Promise<GitCheckpointRecord> {
  return invoke<GitCheckpointRecord>('butler_git_checkpoint_revert', {
    workspaceRoot,
    checkpointId,
    mode,
  });
}

export async function stageGitFile(workspaceRoot: string, path: string): Promise<void> {
  await invoke('butler_git_stage_file', { workspaceRoot, path });
}

export async function unstageGitFile(workspaceRoot: string, path: string): Promise<void> {
  await invoke('butler_git_unstage_file', { workspaceRoot, path });
}

export async function discardGitFile(workspaceRoot: string, path: string): Promise<void> {
  await invoke('butler_git_discard_file', { workspaceRoot, path });
}

export async function commitGitChanges(
  workspaceRoot: string,
  message: string,
  stageAll = false,
): Promise<GitCommitResult> {
  return invoke<GitCommitResult>('butler_git_commit', { workspaceRoot, message, stageAll });
}

export async function pushGitBranch(input: {
  workspaceRoot: string;
  remote?: string | null;
  branch?: string | null;
  setUpstream?: boolean;
}): Promise<GitPushResult> {
  return invoke<GitPushResult>('butler_git_push', {
    workspaceRoot: input.workspaceRoot,
    remote: input.remote ?? null,
    branch: input.branch ?? null,
    setUpstream: input.setUpstream ?? true,
  });
}

export async function createGitPullRequest(input: {
  workspaceRoot: string;
  title: string;
  body?: string | null;
  base?: string | null;
  draft?: boolean;
}): Promise<GitCreatePrResult> {
  return invoke<GitCreatePrResult>('butler_git_create_pr', {
    workspaceRoot: input.workspaceRoot,
    title: input.title,
    body: input.body ?? null,
    base: input.base ?? null,
    draft: input.draft ?? false,
  });
}

export async function listGitWorktrees(workspaceRoot: string): Promise<GitWorktreeItem[]> {
  const res = await invoke<GitWorktreeItem[] | null>('butler_worktree_list', { workspaceRoot });
  return Array.isArray(res) ? res : [];
}

export async function listGitBranches(workspaceRoot: string): Promise<GitBranchItem[]> {
  const res = await invoke<GitBranchItem[] | null>('butler_git_branch_list', { workspaceRoot });
  return Array.isArray(res) ? res : [];
}

export async function checkoutGitBranch(
  workspaceRoot: string,
  branch: string,
  create = false,
): Promise<void> {
  await invoke('butler_git_branch_checkout', { workspaceRoot, branch, create });
}

export interface ButlerTerminalOutputSnapshot {
  output: string;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}

export async function startButlerTerminal(input: {
  workspaceRoot: string;
  shell?: string | null;
  cwd?: string | null;
}): Promise<string> {
  return invoke<string>('butler_terminal_start', {
    workspaceRoot: input.workspaceRoot,
    shell: input.shell ?? null,
    cwd: input.cwd ?? null,
  });
}

export async function writeButlerTerminal(terminalId: string, data: string): Promise<void> {
  await invoke('butler_terminal_write', { terminalId, data });
}

export async function readButlerTerminalOutput(
  terminalId: string,
): Promise<ButlerTerminalOutputSnapshot> {
  return invoke<ButlerTerminalOutputSnapshot>('butler_terminal_output', { terminalId });
}

export async function killButlerTerminal(terminalId: string): Promise<void> {
  await invoke('butler_terminal_kill', { terminalId });
}

export async function releaseButlerTerminal(terminalId: string): Promise<void> {
  await invoke('butler_terminal_release', { terminalId });
}

export async function listWorkspaceFiles(
  workspaceRoot: string,
  query?: string,
  limit = 60,
): Promise<string[]> {
  const res = await invoke<string[] | null>('butler_workspace_list_files', {
    workspaceRoot,
    query: query ?? null,
    limit,
  });
  return Array.isArray(res) ? res : [];
}

export type PiProviderPreset =
  | 'deepseek'
  | 'custom-openai'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter';

export type PiApiProtocol =
  | 'auto'
  | 'openai-responses'
  | 'openai-completions'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'azure-openai-responses'
  | 'mistral-conversations'
  | 'bedrock-converse-stream';

export interface PiConfigView {
  provider: PiProviderPreset;
  apiProtocol?: PiApiProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint?: string | null;
  defaultModel: string;
  extraModels: string[];
  manualPath?: string | null;
}

export interface PiConfigWriteInput {
  provider?: PiProviderPreset;
  apiProtocol?: PiApiProtocol;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  extraModels?: string[];
  manualPath?: string;
}

export interface PiEndpointProbeInput {
  baseUrl: string;
  apiKey?: string;
  provider?: PiProviderPreset;
  apiProtocol?: PiApiProtocol;
  preferredModel?: string;
}

export interface PiProtocolProbeDetail {
  protocol: string;
  status: 'verified' | 'detected' | 'unsupported' | 'error' | string;
  httpStatus?: number | null;
  message?: string | null;
}

export interface PiEndpointProbeResult {
  ok: boolean;
  normalizedBaseUrl: string;
  detectedProtocol: PiApiProtocol;
  supportedProtocols: PiApiProtocol[];
  probeDetails: PiProtocolProbeDetail[];
  discoveredModels: string[];
  suggestedModel?: string | null;
  latencyMs: number;
  summary: string;
}

export interface PiLocalGatewayCandidate {
  id: string;
  label: string;
  baseUrl: string;
  protocol: PiApiProtocol;
  models: string[];
  latencyMs: number;
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

export async function probePiEndpoint(input: PiEndpointProbeInput): Promise<PiEndpointProbeResult> {
  return invoke<PiEndpointProbeResult>('pi_endpoint_probe', { input });
}

export async function scanLocalPiGateways(): Promise<PiLocalGatewayCandidate[]> {
  const res = await invoke<PiLocalGatewayCandidate[] | null>('pi_local_gateways_scan');
  return Array.isArray(res) ? res : [];
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
  const res = await invoke<AcpAgentProfile[] | null>('acp_agent_list');
  return Array.isArray(res) ? res : [];
}

export async function acpAgentDiscover(): Promise<AcpDiscoveredCandidate[]> {
  const res = await invoke<AcpDiscoveredCandidate[] | null>('acp_agent_discover');
  return Array.isArray(res) ? res : [];
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
  const res = await invoke<AcpProcessInfo[] | null>('acp_process_list');
  return Array.isArray(res) ? res : [];
}

export async function acpLocalSessionsDiscover(
  limit = 120,
): Promise<DiscoveredLocalSession[]> {
  const res = await invoke<DiscoveredLocalSession[] | null>('acp_local_sessions_discover', { limit });
  return Array.isArray(res) ? res : [];
}

export async function acpLocalSessionMessages(input: {
  provider: string;
  sessionId: string;
  sourcePath?: string | null;
  sourceScope?: string;
  limit?: number;
}): Promise<LocalSessionMessage[]> {
  const res = await invoke<LocalSessionMessage[] | null>('acp_local_session_messages', {
    provider: input.provider,
    sessionId: input.sessionId,
    sourcePath: input.sourcePath ?? null,
    sourceScope: input.sourceScope ?? null,
    limit: input.limit ?? 24,
  });
  return Array.isArray(res) ? res : [];
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
  const res = await runWithButlerAccountIfManaged(() =>
    invoke<ButlerMemoryEntry[] | null>('butler_memory_list', {
      accountScope: filter.accountScope,
      category: filter.category ?? null,
      workspaceRoot: filter.workspaceRoot ?? null,
      query: filter.query ?? null,
      enabledOnly: filter.enabledOnly ?? null,
    }),
  );
  return Array.isArray(res) ? res : [];
}

export async function butlerMemoryUpsert(
  input: ButlerMemoryUpsertInput,
): Promise<ButlerMemoryEntry> {
  return runWithButlerAccountIfManaged(() =>
    invoke<ButlerMemoryEntry>('butler_memory_upsert', { input }),
  );
}

export async function butlerMemoryDelete(
  id: string,
  accountScope?: string,
): Promise<boolean> {
  return runWithButlerAccountIfManaged(() =>
    invoke<boolean>('butler_memory_delete', { id, accountScope: accountScope ?? null }),
  );
}

export async function butlerMemoryMarkRecalled(
  ids: string[],
  accountScope?: string,
): Promise<number> {
  return runWithButlerAccountIfManaged(() =>
    invoke<number>('butler_memory_mark_recalled', { ids, accountScope: accountScope ?? null }),
  );
}

export async function butlerMemoryClearScope(accountScope: string): Promise<number> {
  return runWithButlerAccountIfManaged(() =>
    invoke<number>('butler_memory_clear_scope', { accountScope }),
  );
}

export async function butlerAssistantDigestList(input: {
  accountScope: string;
  kind?: ButlerAssistantDigestKind | null;
  limit?: number | null;
}): Promise<ButlerAssistantDigest[]> {
  const res = await runWithButlerAccountIfManaged(() =>
    invoke<ButlerAssistantDigest[] | null>('butler_assistant_digest_list', {
      accountScope: input.accountScope,
      kind: input.kind ?? null,
      limit: input.limit ?? null,
    }),
  );
  return Array.isArray(res) ? res : [];
}

export async function butlerAssistantDigestSave(
  input: ButlerAssistantDigestInput,
): Promise<ButlerAssistantDigest> {
  return runWithButlerAccountIfManaged(() =>
    invoke<ButlerAssistantDigest>('butler_assistant_digest_save', { input }),
  );
}

export async function butlerAssistantDigestDelete(
  id: string,
  accountScope?: string,
): Promise<boolean> {
  return runWithButlerAccountIfManaged(() =>
    invoke<boolean>('butler_assistant_digest_delete', { id, accountScope: accountScope ?? null }),
  );
}

export type ButlerSkillApprovalPolicy = 'auto' | 'confirm_write' | 'confirm_all';

export interface ButlerSkillEntry {
  id: string;
  accountScope: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  instructionsMd: string;
  triggers: string[];
  allowedTools: string[];
  approvalPolicy: ButlerSkillApprovalPolicy | string;
  workspaceRoot: string | null;
  enabled: boolean;
  pinned: boolean;
  runCount: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ButlerSkillUpsertInput {
  id?: string | null;
  accountScope: string;
  slug?: string | null;
  name: string;
  description?: string | null;
  category?: string | null;
  instructionsMd: string;
  triggers?: string[];
  allowedTools?: string[];
  approvalPolicy?: ButlerSkillApprovalPolicy | string;
  workspaceRoot?: string | null;
  enabled?: boolean;
  pinned?: boolean;
}

export async function butlerSkillList(input: {
  accountScope: string;
  workspaceRoot?: string | null;
  includeDisabled?: boolean;
}): Promise<ButlerSkillEntry[]> {
  const res = await runWithButlerAccountIfManaged(() =>
    invoke<ButlerSkillEntry[] | null>('butler_skill_list', {
      accountScope: input.accountScope,
      workspaceRoot: input.workspaceRoot ?? null,
      includeDisabled: input.includeDisabled ?? true,
    }),
  );
  return Array.isArray(res) ? res : [];
}

export async function butlerSkillUpsert(
  input: ButlerSkillUpsertInput,
): Promise<ButlerSkillEntry> {
  return runWithButlerAccountIfManaged(() =>
    invoke<ButlerSkillEntry>('butler_skill_upsert', { input }),
  );
}

export async function butlerSkillDelete(
  id: string,
  accountScope?: string,
): Promise<boolean> {
  return runWithButlerAccountIfManaged(() =>
    invoke<boolean>('butler_skill_delete', { id, accountScope: accountScope ?? null }),
  );
}

export async function butlerSkillRecordRun(
  id: string,
  accountScope?: string,
): Promise<ButlerSkillEntry> {
  return runWithButlerAccountIfManaged(() =>
    invoke<ButlerSkillEntry>('butler_skill_record_run', { id, accountScope: accountScope ?? null }),
  );
}

export async function butlerSkillImportMarkdown(input: {
  accountScope: string;
  markdown: string;
  workspaceRoot?: string | null;
}): Promise<ButlerSkillEntry> {
  return runWithButlerAccountIfManaged(() =>
    invoke<ButlerSkillEntry>('butler_skill_import_markdown', {
      accountScope: input.accountScope,
      markdown: input.markdown,
      workspaceRoot: input.workspaceRoot ?? null,
    }),
  );
}

export async function butlerSkillExportMarkdown(
  id: string,
  accountScope?: string,
): Promise<string> {
  return runWithButlerAccountIfManaged(() =>
    invoke<string>('butler_skill_export_markdown', { id, accountScope: accountScope ?? null }),
  );
}

export interface ProjectPolicyConfig {
  version: number;
  allowedCommands: string[];
  deniedCommands: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  requireApprovalForExternal: boolean;
  maxAutonomyMode: 'readonly' | 'confirm' | 'autonomous' | string;
  allowNetworkTools: boolean;
}

export interface ProjectPolicyDecision {
  verdict: 'allow' | 'confirm' | 'deny' | string;
  reason: string;
  matchedRule: string | null;
}

export async function butlerPolicyGet(workspaceRoot: string): Promise<ProjectPolicyConfig> {
  return invoke<ProjectPolicyConfig>('butler_policy_get', { workspaceRoot });
}

export async function butlerPolicySave(
  workspaceRoot: string,
  policy: ProjectPolicyConfig,
): Promise<ProjectPolicyConfig> {
  return invoke<ProjectPolicyConfig>('butler_policy_save', { workspaceRoot, policy });
}

export async function butlerPolicyEvaluate(input: {
  workspaceRoot: string;
  actionKind: string;
  target: string;
}): Promise<ProjectPolicyDecision> {
  return invoke<ProjectPolicyDecision>('butler_policy_evaluate', input);
}

export interface ButlerMcpServerView {
  id: string;
  name: string;
  transport: string;
  command: string;
  args: string[];
  publicEnv: Record<string, string>;
  secretEnvKeys: string[];
  hasSecrets: boolean;
  enabled: boolean;
  scope: string;
  workspaceRoot: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ButlerMcpServerUpsertInput {
  id?: string | null;
  name: string;
  command: string;
  args?: string[];
  publicEnv?: Record<string, string>;
  secretEnv?: Record<string, string>;
  clearSecretKeys?: string[];
  enabled?: boolean;
  scope?: 'global' | 'workspace';
  workspaceRoot?: string | null;
}

export interface ButlerMcpHealthCheckResult {
  ok: boolean;
  latencyMs: number;
  toolCount: number;
  tools: string[];
  error: string | null;
}

export interface ButlerMcpLaunchConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export async function butlerMcpList(workspaceRoot?: string | null): Promise<ButlerMcpServerView[]> {
  const res = await invoke<ButlerMcpServerView[] | null>('butler_mcp_list', { workspaceRoot: workspaceRoot ?? null });
  return Array.isArray(res) ? res : [];
}

export async function butlerMcpUpsert(input: ButlerMcpServerUpsertInput): Promise<ButlerMcpServerView> {
  return invoke<ButlerMcpServerView>('butler_mcp_upsert', { input });
}

export async function butlerMcpDelete(id: string): Promise<boolean> {
  return invoke<boolean>('butler_mcp_delete', { id });
}

export async function butlerMcpHealthCheck(id: string): Promise<ButlerMcpHealthCheckResult> {
  return invoke<ButlerMcpHealthCheckResult>('butler_mcp_health_check', { id });
}

export async function butlerMcpLaunchConfigs(
  workspaceRoot?: string | null,
): Promise<ButlerMcpLaunchConfig[]> {
  const res = await invoke<ButlerMcpLaunchConfig[] | null>('butler_mcp_launch_configs', {
    workspaceRoot: workspaceRoot ?? null,
  });
  return Array.isArray(res) ? res : [];
}

export interface GitHubConnectorStatus {
  configured: boolean;
  apiBaseUrl: string;
  hasToken: boolean;
  tokenHint: string | null;
  ghCliAvailable: boolean;
  ghCliAuthenticated?: boolean;
}

export interface GitHubRepoIdentity {
  owner: string;
  repo: string;
  remoteUrl: string;
}

export interface GitHubIssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface GitHubIssueDetail {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  bodyTruncated: boolean;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  comments: GitHubIssueComment[];
}

export interface GitHubPullSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  htmlUrl: string;
  updatedAt: string;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  htmlUrl: string;
  updatedAt: string;
}

export interface GitHubPrDiffResult {
  owner: string;
  repo: string;
  number: number;
  diff: string;
  truncated: boolean;
}

export async function butlerGithubStatus(): Promise<GitHubConnectorStatus> {
  return invoke<GitHubConnectorStatus>('butler_github_status');
}

export async function butlerGithubSaveConfig(input: {
  apiBaseUrl?: string | null;
  token?: string | null;
}): Promise<GitHubConnectorStatus> {
  return invoke<GitHubConnectorStatus>('butler_github_save_config', {
    apiBaseUrl: input.apiBaseUrl ?? null,
    token: input.token ?? null,
  });
}

export async function butlerGithubClearConfig(): Promise<void> {
  return invoke<void>('butler_github_clear_config');
}

export async function butlerGithubTestConnection(): Promise<{
  ok: boolean;
  login: string;
  name: string;
  apiBaseUrl: string;
}> {
  return invoke('butler_github_test_connection');
}

export async function butlerGithubListPrs(input: {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}): Promise<GitHubPullSummary[]> {
  const res = await invoke<GitHubPullSummary[] | null>('butler_github_list_prs', {
    owner: input.owner,
    repo: input.repo,
    state: input.state ?? 'open',
    limit: input.limit ?? 20,
  });
  return Array.isArray(res) ? res : [];
}

export async function butlerGithubListIssues(input: {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}): Promise<GitHubIssueSummary[]> {
  const res = await invoke<GitHubIssueSummary[] | null>('butler_github_list_issues', {
    owner: input.owner,
    repo: input.repo,
    state: input.state ?? 'open',
    limit: input.limit ?? 20,
  });
  return Array.isArray(res) ? res : [];
}

export async function butlerGithubGetPrDiff(input: {
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPrDiffResult> {
  return invoke<GitHubPrDiffResult>('butler_github_get_pr_diff', input);
}

export async function butlerGithubCreateComment(input: {
  owner: string;
  repo: string;
  number: number;
  body: string;
}): Promise<unknown> {
  return invoke('butler_github_create_comment', input);
}

export async function butlerGithubDetectWorkspaceRepo(
  workspaceRoot: string,
): Promise<GitHubRepoIdentity | null> {
  return invoke<GitHubRepoIdentity | null>('butler_github_detect_workspace_repo', {
    workspaceRoot,
  });
}

export async function butlerGithubGetIssueDetail(input: {
  owner: string;
  repo: string;
  number: number;
  commentLimit?: number;
}): Promise<GitHubIssueDetail> {
  return invoke<GitHubIssueDetail>('butler_github_get_issue_detail', {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    commentLimit: input.commentLimit ?? 20,
  });
}

export interface BrowserInspectResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  title: string | null;
  headings: string[];
  textExcerpt: string;
  links: Array<{ text: string; href: string }>;
  durationMs: number;
}

export async function butlerBrowserInspect(input: {
  url: string;
  maxChars?: number;
  allowInsecureLan?: boolean;
}): Promise<BrowserInspectResult> {
  return invoke<BrowserInspectResult>('butler_browser_inspect', {
    url: input.url,
    maxChars: input.maxChars ?? null,
    allowInsecureLan: input.allowInsecureLan ?? false,
  });
}
