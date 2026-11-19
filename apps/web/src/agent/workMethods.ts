import { evaluateCardCompletionGate } from './workCoordinator';
import type { NativeWorkCard, NativeWorkEvidence } from '../platform/desktopCommands';
import { resolveButlerAccountScope, validateMemoryNoSecrets } from '../stores/butlerMemory';
import { useRoutines, type Routine } from '../stores/routines';
import { useWorkLedger } from '../stores/workLedger';

export interface WorkMethodDraft {
  name: string;
  inputs: string;
  steps: string;
  failureHandling: string;
}

export function buildVerifiedWorkMethod(card: NativeWorkCard, evidences: NativeWorkEvidence[], draft: WorkMethodDraft, accountScope: string, workspaceRoot: string): Routine {
  const gate = evaluateCardCompletionGate(card, evidences);
  if (!card.done || !card.state.acceptance.length || !gate.canMarkDone) throw new Error('只能保存已有当前版本验收依据的已完成工作');
  if (![draft.name, draft.inputs, draft.steps, draft.failureHandling].every((v) => v.trim())) throw new Error('请填写方法名称、输入、步骤和失败处理');
  const method = {
    sourceWorkId: card.id, accountScope, projectKey: card.state.projectKey,
    inputs: draft.inputs.trim(), steps: draft.steps.trim(), acceptance: [...card.state.acceptance],
    failureHandling: draft.failureHandling.trim(), boundaries: [...card.state.boundaries],
  };
  const prompt = [
    `复用方法：${draft.name.trim()}`, `参考已验收工作：${card.id}（只参考方法，新工作必须重新验证）`,
    `输入及来源：\n${method.inputs}`, `执行步骤：\n${method.steps}`,
    `验收条件：\n${method.acceptance.map((a) => `- ${a}`).join('\n')}`,
    `边界：\n${method.boundaries.map((b) => `- ${b}`).join('\n') || '沿用新工作的当前授权'}`,
    `失败处理：\n${method.failureHandling}`, '不要复用旧工作的状态或验收结果；不要携带私人记忆或凭据。',
  ].join('\n\n');
  const secrets = validateMemoryNoSecrets(`${draft.name}\n${prompt}`);
  if (!secrets.ok) throw new Error(secrets.reason);
  return { id: `work-method-${crypto.randomUUID()}`, name: draft.name.trim(), kind: 'cron', prompt, precheck: 'none', workspaceRoot: workspaceRoot.trim() || undefined, enabled: false, createdAt: Date.now(), runs: [], workTemplate: method };
}

export function saveVerifiedWorkAsRoutine(workId: string, draft: WorkMethodDraft, workspaceRoot = ''): Routine {
  const ledger = useWorkLedger.getState();
  const card = ledger.cards.find((c) => c.id === workId);
  if (!card) throw new Error('来源工作不存在');
  const saved = buildVerifiedWorkMethod(card, ledger.evidences, draft, resolveButlerAccountScope(), workspaceRoot);
  useRoutines.getState().addRoutine(saved);
  return saved;
}

export async function createWorkFromSavedMethod(routineId: string, title: string, inputs: string, context: { projectKey?: string | null; workspaceRoot?: string | null } = {}): Promise<NativeWorkCard> {
  const routine = useRoutines.getState().routines.find((r) => r.id === routineId);
  const method = routine?.workTemplate;
  if (!routine || !method || method.accountScope !== resolveButlerAccountScope()) throw new Error('方法不存在或不属于当前账号');
  if (method.projectKey && method.projectKey !== context.projectKey) throw new Error('此方法属于其他项目');
  if (!title.trim() || !inputs.trim()) throw new Error('请填写新工作名称和本次输入');
  const text = `${title}\n${inputs}`;
  const secrets = validateMemoryNoSecrets(text);
  if (!secrets.ok) throw new Error(secrets.reason);
  const ledger = useWorkLedger.getState();
  // The new work has its own identity and no evidence copied from the successful source.
  return ledger.createCard({ title: title.trim(), note: `${routine.prompt}\n\n本次输入（使用前核对来源）：\n${inputs.trim()}${context.workspaceRoot ? `\n本次工作目录：${context.workspaceRoot}` : ''}`, goal: title.trim(), ownerKind: 'ai_suggested', stage: 'ready', autonomyMode: 'confirm', acceptance: [...method.acceptance], boundaries: [...method.boundaries], projectKey: context.projectKey ?? method.projectKey, enroll: true, nextStep: '检查本次输入并选择执行环境，再开始执行' });
}
