import type { ServerRequestPolicy } from '../agent/protocol';
import type { DispatchSpec } from '../agent/dispatchSpec';

/** 管家拟好、等用户在卡上过目的任务规格草案 */
export interface ButlerErrandDraft {
  spec: DispatchSpec;
  /** 模型对目标工作区的猜测，只参与选择器排序 */
  workspaceHint?: string;
  checkpointId: string;
}

export type ButlerErrandStatus =
  | 'running'
  | 'awaiting-approval'
  | 'replied'
  | 'failed';

export interface ButlerErrandTrace {
  id: string;
  at: number;
  kind: 'status' | 'tool' | 'warning' | 'error';
  text: string;
}

export interface ButlerErrandPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface ButlerErrandApproval {
  id: string;
  method: string;
  policy: ServerRequestPolicy;
  params: unknown;
  at: number;
}

export interface ButlerErrandRun {
  id: string;
  title: string;
  threadId: string;
  workspaceRoot: string;
  workspaceName: string;
  readOnly: boolean;
  startedAt: number;
  status: ButlerErrandStatus;
  activity?: string;
  approvals: ButlerErrandApproval[];
  traces: ButlerErrandTrace[];
  plan?: ButlerErrandPlanStep[];
  reply?: string;
  error?: string;
  /** 收下只在内存标记，跨重启恢复留给刀 2。 */
  archivedAt?: number;
}

export interface DispatchErrandOptions {
  /** 只调查不改文件。默认 false——派活多半是要动手，只读会让活结构性干不完。 */
  readOnly?: boolean;
}

const ACTIVITY_LABELS: Record<string, string> = {
  fileChange: '正在改文件',
  commandExecution: '正在跑命令',
  reasoning: '正在琢磨',
  agentMessage: '正在回话',
  webSearch: '正在查资料',
  mcpToolCall: '正在用工具',
  todoList: '正在列步骤',
};

/** 防止并行派活失控；回话未收下也占用一个名额。 */
export const BUTLER_ERRAND_LIMIT = 5;
export const BUTLER_ERRAND_TRACE_LIMIT = 200;

function errandPriority(run: ButlerErrandRun): number {
  if (run.archivedAt) return 4;
  if (run.status === 'awaiting-approval') return 0;
  if (run.status === 'running') return 1;
  return 2;
}

export function sortButlerErrands(left: ButlerErrandRun, right: ButlerErrandRun): number {
  return errandPriority(left) - errandPriority(right) || right.startedAt - left.startedAt;
}

export function visibleButlerErrands(runs: readonly ButlerErrandRun[]): ButlerErrandRun[] {
  return [...runs].filter((run) => !run.archivedAt).sort(sortButlerErrands);
}

export function currentErrandActivity(traces: readonly ButlerErrandTrace[]): string | undefined {
  for (let index = traces.length - 1; index >= 0; index -= 1) {
    const trace = traces[index];
    if (trace.kind !== 'tool') continue;
    const started = /^开始：(.+)$/.exec(trace.text);
    if (started) return ACTIVITY_LABELS[started[1]] ?? '正在处理';
    if (/^完成：/.test(trace.text)) return '正在想下一步';
    if (trace.text.startsWith('等待审批')) return undefined;
  }
  return undefined;
}
