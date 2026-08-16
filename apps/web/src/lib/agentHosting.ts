import { fetchWorkItem } from './ado';
import type { AgentBackend } from '../agent/session';
import { getServerBase } from './client';
import { workItemIdFromRoomTitle } from '../agent/context';
import { useAuth } from '../stores/auth';
import {
  agentRoomSessionKey,
  environmentIsBusy,
  findEnvironmentByPath,
  proposedAgentBranch,
  selectEnvironmentForProject,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { isSystemCodexWorkspace, useCodexWorkspace } from '../stores/codexWorkspace';
import { useSharedAgent } from '../stores/sharedAgent';
import { useUI } from '../stores/ui';

const AUTO_HOST_STORAGE_KEY = 'rcx-agent-auto-host-rooms';
const ROOM_WORKSPACE_STORAGE_KEY = 'rcx-agent-room-workspaces-v1';

function roomScope(rid: string): string {
  const userId = useAuth.getState().user?._id ?? 'guest';
  return `${userId}@${getServerBase() || 'same-origin'}:${rid}`;
}

function loadRoomMap(storageKey: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as unknown;
    return value && typeof value === 'object' ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

function setRoomValue(storageKey: string, rid: string, value?: string): void {
  const rooms = loadRoomMap(storageKey);
  const key = roomScope(rid);
  if (value) rooms[key] = value;
  else delete rooms[key];
  try {
    localStorage.setItem(storageKey, JSON.stringify(rooms));
  } catch {
    // 本地存储不可用时不影响当前已经启动的托管会话。
  }
}

export function autoHostEnvironmentId(rid: string): string | undefined {
  return loadRoomMap(AUTO_HOST_STORAGE_KEY)[roomScope(rid)];
}

export function setRoomAutoHosting(rid: string, environmentId?: string): void {
  setRoomValue(AUTO_HOST_STORAGE_KEY, rid, environmentId);
}

export function roomHostingWorkspaceRoot(rid: string): string | undefined {
  return loadRoomMap(ROOM_WORKSPACE_STORAGE_KEY)[roomScope(rid)];
}

export function setRoomHostingWorkspace(rid: string, workspaceRoot?: string): void {
  setRoomValue(ROOM_WORKSPACE_STORAGE_KEY, rid, workspaceRoot);
}

export function defaultHostingBackend(): AgentBackend {
  const provider = useUI.getState().aiRuntimeProvider;
  if (provider === 'none') throw new Error('当前未启用 AI');
  return provider;
}

export async function startRoomAgentHosting(
  rid: string,
  roomTitle: string,
  options: { preferredEnvironmentId?: string; workspaceRoot?: string } = {},
): Promise<void> {
  const workspaceState = useCodexWorkspace.getState();
  const defaultWorkspaceRoot = workspaceState.defaultWorkspaceRoot
    || await workspaceState.ensureDefaultWorkspace();
  const butlerWorkspaceRoot = useCodexWorkspace.getState().butlerWorkspaceRoot;
  const environmentState = useAgentEnvironments.getState();
  const workItemId = workItemIdFromRoomTitle(roomTitle);
  const fetchedWorkItem = workItemId ? await fetchWorkItem(workItemId) : null;
  const workspaceEnvironment = options.workspaceRoot
    ? findEnvironmentByPath(environmentState.environments, options.workspaceRoot)
    : undefined;
  const preferredEnvironment = options.preferredEnvironmentId
    ? environmentState.environments.find(
        (environment) =>
          environment.id === options.preferredEnvironmentId &&
          environment.enabled &&
          !environmentIsBusy(environment.id, environmentState.bindings),
      )
    : undefined;
  if (options.preferredEnvironmentId && !preferredEnvironment) {
    throw new Error('这个 AI 托管工作区不可用，请在 AI 管家中重新选择');
  }
  const environment = preferredEnvironment
    ?? (workspaceEnvironment?.enabled && !environmentIsBusy(workspaceEnvironment.id, environmentState.bindings)
      ? workspaceEnvironment
      : undefined)
    ?? (!options.workspaceRoot
      ? selectEnvironmentForProject(
        environmentState.environments,
        environmentState.bindings,
        fetchedWorkItem?.project ?? '',
        environmentState.lastEnvironmentByProject,
      )
      : undefined);
  const workspaceRoot = options.workspaceRoot ?? environment?.path;
  const configured = Boolean(workspaceRoot && environment && findEnvironmentByPath([environment], workspaceRoot));
  if (
    !workspaceRoot
    || !environment
    || isSystemCodexWorkspace(workspaceRoot, defaultWorkspaceRoot, butlerWorkspaceRoot)
    || !configured
  ) {
    throw new Error('请先在 AI 管家中添加专用工作项目，再开启 AI 托管');
  }
  const workItem = workItemId
    ? {
        id: workItemId,
        project: fetchedWorkItem?.project,
        title: fetchedWorkItem?.title ?? roomTitle,
      }
    : undefined;
  const backend = defaultHostingBackend();

  const startOptions = {
    workspaceRoot,
    environmentId: environment.id,
    environmentName: environment.name,
    workItem,
    proposedBranch: workItem
      ? proposedAgentBranch(environment.branchPrefix, workItem.id, workItem.title)
      : undefined,
    baseBranch: environment.defaultBaseBranch,
    backend,
  };
  await useSharedAgent.getState().startSession(rid, agentRoomSessionKey(rid), startOptions);
}
