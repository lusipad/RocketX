import { invoke } from '@tauri-apps/api/core';

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
  return invoke<NativeTodoRecord>('butler_todo_add', { todo });
}

export async function updateNativeTodo(
  id: string,
  patch: Record<string, unknown>,
): Promise<NativeTodoRecord> {
  return invoke<NativeTodoRecord>('butler_todo_update', { id, patch });
}

export async function deleteNativeTodo(id: string): Promise<void> {
  await invoke('butler_todo_delete', { id });
}

export async function listNativeTodos(): Promise<NativeTodoRecord[]> {
  return invoke<NativeTodoRecord[]>('butler_todo_list', { filter: {} });
}

export async function migrateNativeTodos(json: string): Promise<number> {
  return invoke<number>('butler_todo_migrate_from_json', { json });
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
