export type ScheduledTaskKind = 'cron' | 'heartbeat';
export type ScheduledTaskStatus = 'ACTIVE' | 'PAUSED';
export type ScheduledTaskNotificationPolicy = 'all_runs' | 'important_updates' | 'failed_runs_only';

export interface ScheduledTaskInput {
  kind?: ScheduledTaskKind;
  name: string;
  prompt: string;
  rrule: string;
  status?: ScheduledTaskStatus;
  workspaceRoot?: string;
  targetThreadId?: string;
  model?: string;
  reasoningEffort?: string;
  notificationPolicy?: ScheduledTaskNotificationPolicy;
  skillName?: string;
  pluginTemplateId?: string;
}

export interface ScheduledTaskPatch extends Partial<ScheduledTaskInput> {
  id: string;
}

export interface ScheduledTaskAdapter {
  list: () => unknown | Promise<unknown>;
  create: (input: ScheduledTaskInput) => unknown | Promise<unknown>;
  update: (input: ScheduledTaskPatch) => unknown | Promise<unknown>;
  remove: (id: string) => unknown | Promise<unknown>;
  run: (id: string) => Promise<unknown>;
}

let scheduledTaskAdapter: ScheduledTaskAdapter | undefined;

export function registerScheduledTaskAdapter(adapter: ScheduledTaskAdapter): () => void {
  scheduledTaskAdapter = adapter;
  return () => {
    if (scheduledTaskAdapter === adapter) scheduledTaskAdapter = undefined;
  };
}

export function requireScheduledTaskAdapter(): ScheduledTaskAdapter {
  if (!scheduledTaskAdapter) throw new Error('已安排任务尚未初始化');
  return scheduledTaskAdapter;
}
