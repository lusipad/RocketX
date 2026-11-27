import { t } from '../i18n';
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
  if (!card.done || !card.state.acceptance.length || !gate.canMarkDone) throw new Error(t('agent.workMethods.needVerifiedCompleted'));
  if (![draft.name, draft.inputs, draft.steps, draft.failureHandling].every((v) => v.trim())) throw new Error(t('agent.workMethods.fieldsRequired'));
  const method = {
    sourceWorkId: card.id, accountScope, projectKey: card.state.projectKey,
    inputs: draft.inputs.trim(), steps: draft.steps.trim(), acceptance: [...card.state.acceptance],
    failureHandling: draft.failureHandling.trim(), boundaries: [...card.state.boundaries],
  };
  const prompt = [
    t('agent.workMethods.promptReuse', { name: draft.name.trim() }), t('agent.workMethods.promptRef', { id: card.id }),
    t('agent.workMethods.promptInputs', { inputs: method.inputs }), t('agent.workMethods.promptSteps', { steps: method.steps }),
    t('agent.workMethods.promptAcceptance', { acceptance: method.acceptance.map((a) => `- ${a}`).join('\n') }),
    t('agent.workMethods.promptBoundaries', { boundaries: method.boundaries.map((b) => `- ${b}`).join('\n') || t('agent.workMethods.defaultBoundary') }),
    t('agent.workMethods.promptFailure', { failure: method.failureHandling }), t('agent.workMethods.promptWarning'),
  ].join('\n\n');
  const secrets = validateMemoryNoSecrets(`${draft.name}\n${prompt}`);
  if (!secrets.ok) throw new Error(secrets.reason);
  return { id: `work-method-${crypto.randomUUID()}`, name: draft.name.trim(), kind: 'cron', prompt, precheck: 'none', workspaceRoot: workspaceRoot.trim() || undefined, enabled: false, createdAt: Date.now(), runs: [], workTemplate: method };
}

export function saveVerifiedWorkAsRoutine(workId: string, draft: WorkMethodDraft, workspaceRoot = ''): Routine {
  const ledger = useWorkLedger.getState();
  const card = ledger.cards.find((c) => c.id === workId);
  if (!card) throw new Error(t('agent.workMethods.sourceMissing'));
  const saved = buildVerifiedWorkMethod(card, ledger.evidences, draft, resolveButlerAccountScope(), workspaceRoot);
  useRoutines.getState().addRoutine(saved);
  return saved;
}

export async function createWorkFromSavedMethod(routineId: string, title: string, inputs: string, context: { projectKey?: string | null; workspaceRoot?: string | null } = {}): Promise<NativeWorkCard> {
  const routine = useRoutines.getState().routines.find((r) => r.id === routineId);
  const method = routine?.workTemplate;
  if (!routine || !method || method.accountScope !== resolveButlerAccountScope()) throw new Error(t('agent.workMethods.methodMissing'));
  if (method.projectKey && method.projectKey !== context.projectKey) throw new Error(t('agent.workMethods.wrongProject'));
  if (!title.trim() || !inputs.trim()) throw new Error(t('agent.workMethods.newWorkRequired'));
  const text = `${title}\n${inputs}`;
  const secrets = validateMemoryNoSecrets(text);
  if (!secrets.ok) throw new Error(secrets.reason);
  const ledger = useWorkLedger.getState();
  // The new work has its own identity and no evidence copied from the successful source.
  return ledger.createCard({ title: title.trim(), note: t('agent.workMethods.cardNote', { prompt: routine.prompt ?? '', inputs: inputs.trim(), workspacePart: context.workspaceRoot ? t('agent.workMethods.workspacePart', { path: context.workspaceRoot }) : '' }), goal: title.trim(), ownerKind: 'ai_suggested', stage: 'ready', autonomyMode: 'confirm', acceptance: [...method.acceptance], boundaries: [...method.boundaries], projectKey: context.projectKey ?? method.projectKey, enroll: true, nextStep: t('agent.workMethods.nextStep') });
}
