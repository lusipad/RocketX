import { create } from 'zustand';
import { agentDeviceId } from '../agent/device';
import { getServerBase } from '../lib/client';

const STORAGE_KEY = 'rcx-agent-environments';

export interface LocalAgentEnvironment {
  id: string;
  name: string;
  path: string;
  adoProjects: string[];
  defaultBaseBranch: string;
  branchPrefix: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemDiscussionBinding {
  id: string;
  serverId: string;
  workItemId: number;
  adoProject: string;
  workItemTitle: string;
  parentRid: string;
  discussionRid: string;
  sessionKey: string;
  environmentId: string;
  hostDeviceId: string;
  status: 'active' | 'ended';
  createdAt: number;
  updatedAt: number;
}

interface PersistedAgentEnvironments {
  version: 1;
  environments: LocalAgentEnvironment[];
  bindings: WorkItemDiscussionBinding[];
  lastEnvironmentByProject: Record<string, string>;
}

interface AgentEnvironmentState extends PersistedAgentEnvironments {
  addEnvironment: (input: Pick<LocalAgentEnvironment, 'name' | 'path' | 'adoProjects' | 'defaultBaseBranch' | 'branchPrefix'>) => LocalAgentEnvironment;
  updateEnvironment: (id: string, patch: Partial<Omit<LocalAgentEnvironment, 'id' | 'createdAt'>>) => void;
  removeEnvironment: (id: string) => void;
  bindDiscussion: (input: Omit<WorkItemDiscussionBinding, 'id' | 'serverId' | 'hostDeviceId' | 'status' | 'createdAt' | 'updatedAt'>) => WorkItemDiscussionBinding;
  endBinding: (discussionRid: string) => void;
}

function id(prefix: string): string {
  const value = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function normalizeProject(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/` : 'ai/';
}

function emptyState(): PersistedAgentEnvironments {
  return { version: 1, environments: [], bindings: [], lastEnvironmentByProject: {} };
}

function load(): PersistedAgentEnvironments {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedAgentEnvironments> | null;
    if (value?.version !== 1 || !Array.isArray(value.environments) || !Array.isArray(value.bindings)) {
      return emptyState();
    }
    return {
      version: 1,
      environments: value.environments,
      bindings: value.bindings,
      lastEnvironmentByProject: value.lastEnvironmentByProject ?? {},
    };
  } catch {
    return emptyState();
  }
}

function persist(state: PersistedAgentEnvironments): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      environments: state.environments,
      bindings: state.bindings,
      lastEnvironmentByProject: state.lastEnvironmentByProject,
    } satisfies PersistedAgentEnvironments));
  } catch {
    // 浏览器禁用存储时保留内存状态，不阻断聊天。
  }
}

export function agentRoomSessionKey(rid: string): string {
  return `room:${rid}`;
}

/**
 * 引用回复可能携带被引用话题的 tmid；只有该话题本身有 Agent 会话时才应优先使用它，
 * 否则继续投递到当前房间已存在的会话。
 */
export function resolveAgentSessionKey(
  rid: string,
  tmid: string | undefined,
  sessionKeys: ReadonlySet<string>,
): string {
  if (tmid && sessionKeys.has(tmid)) return tmid;
  const roomKey = agentRoomSessionKey(rid);
  if (sessionKeys.has(roomKey)) return roomKey;
  return tmid ?? roomKey;
}

export function proposedAgentBranch(prefix: string, workItemId: number, title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
  return `${normalizePrefix(prefix)}${workItemId}-${slug}`;
}

export function environmentIsBusy(
  environmentId: string,
  bindings: readonly WorkItemDiscussionBinding[],
  exceptDiscussionRid?: string,
): boolean {
  return bindings.some(
    (binding) =>
      binding.environmentId === environmentId &&
      binding.status === 'active' &&
      binding.discussionRid !== exceptDiscussionRid,
  );
}

export function selectEnvironmentForProject(
  environments: readonly LocalAgentEnvironment[],
  bindings: readonly WorkItemDiscussionBinding[],
  project: string,
  lastEnvironmentByProject: Readonly<Record<string, string>> = {},
): LocalAgentEnvironment | undefined {
  const enabled = environments.filter(
    (environment) => environment.enabled && !environmentIsBusy(environment.id, bindings),
  );
  const projectKey = normalizeProject(project);
  const last = lastEnvironmentByProject[projectKey];
  return (
    enabled.find((environment) => environment.id === last) ??
    enabled.find((environment) => environment.adoProjects.some((item) => normalizeProject(item) === projectKey)) ??
    enabled[0]
  );
}

const initial = load();

export const useAgentEnvironments = create<AgentEnvironmentState>((set, get) => ({
  ...initial,

  addEnvironment: (input) => {
    const path = input.path.trim();
    if (!path) throw new Error('请选择本地目录');
    if (get().environments.some((environment) => environment.path.toLocaleLowerCase() === path.toLocaleLowerCase())) {
      throw new Error('这个本地目录已经配置过了');
    }
    const now = Date.now();
    const environment: LocalAgentEnvironment = {
      id: id('environment'),
      name: input.name.trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || '本地环境',
      path,
      adoProjects: input.adoProjects.map((item) => item.trim()).filter(Boolean),
      defaultBaseBranch: input.defaultBaseBranch.trim() || 'main',
      branchPrefix: normalizePrefix(input.branchPrefix),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const next = { ...get(), environments: [...get().environments, environment] };
    persist(next);
    set({ environments: next.environments });
    return environment;
  },

  updateEnvironment: (environmentId, patch) => {
    const nextEnvironments = get().environments.map((environment) =>
      environment.id === environmentId
        ? {
            ...environment,
            ...patch,
            ...(patch.name !== undefined ? { name: patch.name.trim() || environment.name } : {}),
            ...(patch.path !== undefined ? { path: patch.path.trim() || environment.path } : {}),
            ...(patch.adoProjects !== undefined
              ? { adoProjects: patch.adoProjects.map((item) => item.trim()).filter(Boolean) }
              : {}),
            ...(patch.branchPrefix !== undefined ? { branchPrefix: normalizePrefix(patch.branchPrefix) } : {}),
            updatedAt: Date.now(),
          }
        : environment,
    );
    const next = { ...get(), environments: nextEnvironments };
    persist(next);
    set({ environments: nextEnvironments });
  },

  removeEnvironment: (environmentId) => {
    if (environmentIsBusy(environmentId, get().bindings)) throw new Error('该环境正在被活动讨论使用，请先结束 Agent 会话');
    const environments = get().environments.filter((environment) => environment.id !== environmentId);
    const lastEnvironmentByProject = Object.fromEntries(
      Object.entries(get().lastEnvironmentByProject).filter(([, value]) => value !== environmentId),
    );
    const next = { ...get(), environments, lastEnvironmentByProject };
    persist(next);
    set({ environments, lastEnvironmentByProject });
  },

  bindDiscussion: (input) => {
    if (environmentIsBusy(input.environmentId, get().bindings, input.discussionRid)) {
      throw new Error('该本地环境已被另一个活动讨论占用');
    }
    const existing = get().bindings.find(
      (binding) =>
        binding.serverId === (getServerBase() || 'same-origin') &&
        binding.adoProject === input.adoProject &&
        binding.workItemId === input.workItemId &&
        binding.status === 'active',
    );
    if (existing && existing.discussionRid !== input.discussionRid) {
      throw new Error('这个工作项已经绑定了一个活动讨论');
    }
    const now = Date.now();
    const binding: WorkItemDiscussionBinding = {
      ...input,
      id: existing?.id ?? id('binding'),
      serverId: getServerBase() || 'same-origin',
      hostDeviceId: agentDeviceId(),
      status: 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const bindings = [
      ...get().bindings.filter((item) => item.id !== binding.id && item.discussionRid !== binding.discussionRid),
      binding,
    ];
    const lastEnvironmentByProject = {
      ...get().lastEnvironmentByProject,
      [normalizeProject(input.adoProject)]: input.environmentId,
    };
    const next = { ...get(), bindings, lastEnvironmentByProject };
    persist(next);
    set({ bindings, lastEnvironmentByProject });
    return binding;
  },

  endBinding: (discussionRid) => {
    const bindings = get().bindings.map((binding) =>
      binding.discussionRid === discussionRid
        ? { ...binding, status: 'ended' as const, updatedAt: Date.now() }
        : binding,
    );
    const next = { ...get(), bindings };
    persist(next);
    set({ bindings });
  },
}));
