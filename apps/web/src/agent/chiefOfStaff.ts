export type WorkAutonomyMode = 'readonly' | 'confirm' | 'autonomous';

export type SpecialistRole = 'researcher' | 'coder' | 'reviewer' | 'ops';

export interface SpecialistRoleSpec {
  role: SpecialistRole;
  defaultAutonomy: WorkAutonomyMode;
  focusInstruction: string;
}

export const SPECIALIST_ROLE_SPECS: Record<SpecialistRole, SpecialistRoleSpec> = {
  researcher: {
    role: 'researcher',
    defaultAutonomy: 'readonly',
    focusInstruction: 'Focus on evidence-backed investigation: locate exact files, symbol names, edge cases, and assumptions without mutating code.',
  },
  coder: {
    role: 'coder',
    defaultAutonomy: 'confirm',
    focusInstruction: 'Focus on surgical implementation: reuse existing helpers, preserve comments/contracts, and run targeted verification tests.',
  },
  reviewer: {
    role: 'reviewer',
    defaultAutonomy: 'readonly',
    focusInstruction: 'Focus on adversarial verification: inspect diffs for regressions, missing tests, security boundaries, and failure paths.',
  },
  ops: {
    role: 'ops',
    defaultAutonomy: 'confirm',
    focusInstruction: 'Focus on operational reliability: check CI, environment configuration, build artifacts, and rollback readiness safely.',
  },
};

const AUTONOMY_RANK: Record<WorkAutonomyMode, number> = {
  readonly: 0,
  confirm: 1,
  autonomous: 2,
};

export function isValidSpecialistRole(role: string): role is SpecialistRole {
  return role === 'researcher' || role === 'coder' || role === 'reviewer' || role === 'ops';
}

export function normalizeAutonomyMode(raw: string | undefined | null, fallback: WorkAutonomyMode): WorkAutonomyMode {
  if (raw === 'readonly' || raw === 'confirm' || raw === 'autonomous') return raw;
  return fallback;
}

export function capDelegationAutonomy(
  requested: WorkAutonomyMode | undefined,
  parentCeiling: WorkAutonomyMode,
): WorkAutonomyMode {
  const effectiveRequest = requested ?? parentCeiling;
  return AUTONOMY_RANK[effectiveRequest] < AUTONOMY_RANK[parentCeiling]
    ? effectiveRequest
    : parentCeiling;
}

export interface SpecialistTaskInput {
  role: string;
  title: string;
  prompt: string;
  agentId?: string;
  autonomyMode?: string;
  isolateWorktree?: boolean;
  workspaceRoot?: string;
}

export interface AvailableSpecialistAgent {
  id: string;
  name: string;
  preset?: string;
  enabled: boolean;
}

export interface PlannedSpecialistTask {
  index: number;
  role: SpecialistRole;
  title: string;
  prompt: string;
  enrichedPrompt: string;
  agentId: string;
  agentName: string;
  autonomyMode: WorkAutonomyMode;
  isolateWorktree: boolean;
  workspaceRoot: string;
}

const MAX_DELEGATED_SPECIALISTS = 6;

export function buildSpecialistPlan(input: {
  tasks: readonly SpecialistTaskInput[];
  parentCeiling: WorkAutonomyMode;
  defaultWorkspaceRoot: string;
  availableAgents: readonly AvailableSpecialistAgent[];
}): PlannedSpecialistTask[] {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('At least one specialist task is required.');
  }
  if (input.tasks.length > MAX_DELEGATED_SPECIALISTS) {
    throw new Error(`A single delegation supports at most ${MAX_DELEGATED_SPECIALISTS} specialists.`);
  }
  const enabledAgents = input.availableAgents.filter((agent) => agent.enabled);
  const fallbackAgent = enabledAgents[0] ?? input.availableAgents[0];
  if (!fallbackAgent) {
    throw new Error('No ACP agent is configured for specialist delegation.');
  }

  return input.tasks.map((rawTask, index) => {
    const roleRaw = String(rawTask.role ?? '').trim().toLowerCase();
    if (!isValidSpecialistRole(roleRaw)) {
      throw new Error(`Unsupported specialist role "${rawTask.role}". Expected researcher, coder, reviewer, or ops.`);
    }
    const spec = SPECIALIST_ROLE_SPECS[roleRaw];
    const title = String(rawTask.title ?? '').trim();
    const prompt = String(rawTask.prompt ?? '').trim();
    if (!title || !prompt) {
      throw new Error(`Specialist #${index + 1} (${spec.role}) requires both title and prompt.`);
    }
    const workspaceRoot = (rawTask.workspaceRoot?.trim() || input.defaultWorkspaceRoot).trim();
    if (!workspaceRoot) {
      throw new Error(`Specialist #${index + 1} (${title}) requires a workspaceRoot.`);
    }

    const explicitAgent = rawTask.agentId
      ? input.availableAgents.find((agent) => agent.id === rawTask.agentId)
      : undefined;
    const chosenAgent = explicitAgent ?? enabledAgents[index % Math.max(1, enabledAgents.length)] ?? fallbackAgent;
    const requestedAutonomy = normalizeAutonomyMode(rawTask.autonomyMode, spec.defaultAutonomy);
    const autonomyMode = capDelegationAutonomy(requestedAutonomy, input.parentCeiling);
    const isolateWorktree = typeof rawTask.isolateWorktree === 'boolean'
      ? rawTask.isolateWorktree
      : spec.role === 'coder';

    return {
      index,
      role: spec.role,
      title,
      prompt,
      enrichedPrompt: `[Chief-of-Staff Specialist: ${spec.role}]\nRole directive: ${spec.focusInstruction}\nTask: ${prompt}`,
      agentId: chosenAgent.id,
      agentName: chosenAgent.name,
      autonomyMode,
      isolateWorktree,
      workspaceRoot,
    };
  });
}

export interface SpecialistResultInput {
  role: SpecialistRole | string;
  title: string;
  agentName?: string;
  autonomyMode?: string;
  status: 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed';
  summary?: string;
  error?: string;
}

export interface DelegationSynthesisReport {
  total: number;
  completed: number;
  awaitingApproval: number;
  queuedOrRunning: number;
  failed: number;
  blockers: string[];
  summaryMarkdown: string;
}

export function synthesizeDelegationSummary(
  results: readonly SpecialistResultInput[],
): DelegationSynthesisReport {
  let completed = 0;
  let awaitingApproval = 0;
  let queuedOrRunning = 0;
  let failed = 0;
  const blockers: string[] = [];

  for (const item of results) {
    if (item.status === 'completed') completed += 1;
    else if (item.status === 'awaiting_approval') awaitingApproval += 1;
    else if (item.status === 'failed') {
      failed += 1;
      blockers.push(`${item.title} (${item.role}): ${item.error || 'failed'}`);
    } else {
      queuedOrRunning += 1;
    }
  }

  const lines = results.map((item) => {
    const meta = [item.role, item.agentName, item.autonomyMode].filter(Boolean).join(' · ');
    const note = item.error ? ` — ${item.error}` : item.summary ? ` — ${item.summary}` : '';
    return `- [${item.status}] **${item.title}** (${meta})${note}`;
  });

  return {
    total: results.length,
    completed,
    awaitingApproval,
    queuedOrRunning,
    failed,
    blockers,
    summaryMarkdown: lines.join('\n'),
  };
}

export interface DelegationTreeNode {
  index: number;
  role: string;
  title: string;
  agentName?: string;
  autonomyMode?: string;
  isolateWorktree?: boolean;
  actionId?: string;
  state: string;
}

export interface ParsedDelegationEvent {
  eventId: string;
  todoId?: string;
  delegationId?: string;
  status: 'running' | 'completed' | 'failed';
  nodes: DelegationTreeNode[];
  summaryMarkdown?: string;
}

function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseDelegationEvent(event: {
  id: string;
  type: string;
  title: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
}): ParsedDelegationEvent | null {
  if (event.type !== 'dynamicToolCall') return null;
  if (event.title !== 'delegate_specialists' && event.title !== 'acp_dispatch_task') {
    return null;
  }

  let payload: Record<string, unknown> | null = null;
  if (event.detail) {
    const first = tryJsonParse(event.detail);
    if (Array.isArray(first)) {
      for (const item of first) {
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          const inner = tryJsonParse((item as { text: string }).text);
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            payload = inner as Record<string, unknown>;
            break;
          }
        }
      }
    } else if (first && typeof first === 'object') {
      payload = first as Record<string, unknown>;
    }
  }

  if (payload && Array.isArray(payload.dispatches)) {
    const nodes: DelegationTreeNode[] = payload.dispatches.map((entry, idx) => {
      const rec = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      return {
        index: typeof rec.index === 'number' ? rec.index : idx,
        role: typeof rec.role === 'string' ? rec.role : 'specialist',
        title: typeof rec.title === 'string' ? rec.title : `Specialist ${idx + 1}`,
        agentName: typeof rec.agentName === 'string' ? rec.agentName : undefined,
        autonomyMode: typeof rec.autonomyMode === 'string' ? rec.autonomyMode : undefined,
        isolateWorktree: typeof rec.isolateWorktree === 'boolean' ? rec.isolateWorktree : undefined,
        actionId: typeof rec.actionId === 'string' ? rec.actionId : undefined,
        state: typeof rec.state === 'string' ? rec.state : event.status,
      };
    });
    const summaryObj = payload.summary && typeof payload.summary === 'object'
      ? (payload.summary as Record<string, unknown>)
      : null;
    return {
      eventId: event.id,
      todoId: typeof payload.todoId === 'string' ? payload.todoId : undefined,
      delegationId: typeof payload.delegationId === 'string' ? payload.delegationId : undefined,
      status: event.status,
      nodes,
      summaryMarkdown: typeof summaryObj?.summaryMarkdown === 'string' ? summaryObj.summaryMarkdown : undefined,
    };
  }

  if (payload && event.title === 'acp_dispatch_task' && typeof payload.title === 'string') {
    return {
      eventId: event.id,
      todoId: typeof payload.todoId === 'string' ? payload.todoId : undefined,
      status: event.status,
      nodes: [
        {
          index: 0,
          role: 'specialist',
          title: payload.title,
          agentName: typeof payload.agentId === 'string' ? payload.agentId : undefined,
          autonomyMode: typeof payload.autonomyMode === 'string' ? payload.autonomyMode : undefined,
          actionId: typeof payload.actionId === 'string' ? payload.actionId : undefined,
          state: typeof payload.state === 'string' ? payload.state : event.status,
        },
      ],
    };
  }

  return {
    eventId: event.id,
    status: event.status,
    nodes: [
      {
        index: 0,
        role: event.title === 'delegate_specialists' ? 'coordinator' : 'specialist',
        title: event.title,
        state: event.status,
      },
    ],
  };
}
