import { fetchWorkItem } from './ado';
import { getServerBase } from './client';
import { workItemIdFromRoomTitle } from '../agent/context';
import { useAuth } from '../stores/auth';
import {
  agentRoomSessionKey,
  environmentIsBusy,
  proposedAgentBranch,
  selectEnvironmentForProject,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { useSharedAgent } from '../stores/sharedAgent';

const AUTO_HOST_STORAGE_KEY = 'rcx-agent-auto-host-rooms';

function roomScope(rid: string): string {
  const userId = useAuth.getState().user?._id ?? 'guest';
  return `${userId}@${getServerBase() || 'same-origin'}:${rid}`;
}

function loadAutoHostRooms(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(AUTO_HOST_STORAGE_KEY) ?? '{}') as unknown;
    return value && typeof value === 'object' ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function autoHostEnvironmentId(rid: string): string | undefined {
  return loadAutoHostRooms()[roomScope(rid)];
}

export function setRoomAutoHosting(rid: string, environmentId?: string): void {
  const rooms = loadAutoHostRooms();
  const key = roomScope(rid);
  if (environmentId) rooms[key] = environmentId;
  else delete rooms[key];
  try {
    localStorage.setItem(AUTO_HOST_STORAGE_KEY, JSON.stringify(rooms));
  } catch {
    // 本地存储不可用时不影响当前已经启动的托管会话。
  }
}

export async function startRoomAgentHosting(
  rid: string,
  roomTitle: string,
  preferredEnvironmentId?: string,
): Promise<void> {
  const environmentState = useAgentEnvironments.getState();
  const workItemId = workItemIdFromRoomTitle(roomTitle);
  const fetchedWorkItem = workItemId ? await fetchWorkItem(workItemId) : null;
  const preferredEnvironment = environmentState.environments.find(
    (environment) =>
      environment.id === preferredEnvironmentId &&
      environment.enabled &&
      !environmentIsBusy(environment.id, environmentState.bindings),
  );
  const environment = preferredEnvironment ?? selectEnvironmentForProject(
    environmentState.environments,
    environmentState.bindings,
    fetchedWorkItem?.project ?? '',
    environmentState.lastEnvironmentByProject,
  );
  const workItem = workItemId
    ? {
        id: workItemId,
        project: fetchedWorkItem?.project,
        title: fetchedWorkItem?.title ?? roomTitle,
      }
    : undefined;

  await useSharedAgent.getState().startSession(rid, agentRoomSessionKey(rid), {
    workspaceRoot: environment?.path,
    environmentId: environment?.id,
    environmentName: environment?.name,
    workItem,
    proposedBranch: workItem && environment
      ? proposedAgentBranch(environment.branchPrefix, workItem.id, workItem.title)
      : undefined,
    baseBranch: environment?.defaultBaseBranch,
  });
}
