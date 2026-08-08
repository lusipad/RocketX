import {
  mirrorButlerProfileFile,
  onButlerArchiveHydrated,
  watchButlerProfileFile,
} from '../../../lib/butlerArchive';
import {
  listSkills,
  saveSkill,
} from '../../../lib/butlerProfile';
import type { ButlerTaskState } from '../../../lib/butlerTaskContext';
import type { ButlerStep } from '../../../stores/butler';
import { ButlerExtensionHost } from '../../../kernel/butlerExtensions';
import { createButlerArchiveExtensionStateStore } from '../../extensionState';
import {
  createButlerEfficiencyExtension,
  type ButlerEfficiencyApi,
} from './efficiencyExtension';
import {
  createButlerOperationJournalExtension,
  type ButlerOperationJournalApi,
} from './operationJournalExtension';
import {
  createButlerProfileExtension,
  type ButlerProfileExtensionApi,
} from './profileExtension';
import {
  createButlerWorkAnalysisExtension,
  type ButlerWorkAnalysisApi,
} from './workAnalysisExtension';
import { buildButlerTaskOperation } from './conversationReceipt';
import {
  buildButlerSkillDraft,
  type ButlerSkillDraft,
} from './skillDraft';
const host = new ButlerExtensionHost(
  createButlerArchiveExtensionStateStore(),
  (extensionId, error) => console.warn(`[Butler extension] ${extensionId}`, error),
);

export const butlerOperationJournal: ButlerOperationJournalApi =
  host.load(createButlerOperationJournalExtension());

export const butlerProfile: ButlerProfileExtensionApi =
  host.load(createButlerProfileExtension({
    mirror: (markdown) => {
      void mirrorButlerProfileFile(markdown);
    },
    watch: watchButlerProfileFile,
  }));

export const butlerWorkAnalysis: ButlerWorkAnalysisApi =
  host.load(createButlerWorkAnalysisExtension());

export const butlerEfficiency: ButlerEfficiencyApi =
  host.load(createButlerEfficiencyExtension({
    names: () => listSkills().map((skill) => skill.name),
    install: saveSkill,
  }));

onButlerArchiveHydrated(() => {
  host.dispatch('host.storage-ready', undefined);
});

export function runButlerLearningAnalysis(): void {
  butlerWorkAnalysis.run();
  butlerEfficiency.run();
}

export interface ButlerConversationTurnLearningInput {
  task: ButlerTaskState | null | undefined;
  surface: string,
  sessionId: string;
  lineIds: readonly string[];
  steps: readonly ButlerStep[];
}

export function recordButlerConversationTurn(
  input: ButlerConversationTurnLearningInput,
): ButlerSkillDraft | undefined {
  const operation = buildButlerTaskOperation(input.task, input.surface);
  butlerOperationJournal.record(operation);
  butlerEfficiency.run();
  if (operation.outcome !== 'completed' || !input.task) return undefined;
  const candidate = butlerEfficiency.store.getState().candidates.find(
    (item) => item.action === operation.action && item.intentKey === operation.intentKey,
  );
  if (!candidate) return undefined;
  const proposal = butlerEfficiency.store.getState().proposals.find(
    (item) => item.candidateId === candidate.id
      && item.target === 'micro-skill'
      && item.status === 'suggested',
  );
  if (!proposal?.skillName) return undefined;
  const result = buildButlerSkillDraft({
    taskState: input.task,
    sessionId: input.sessionId,
    lineIds: input.lineIds,
    steps: input.steps,
  });
  if (!result.ok) return undefined;
  const draft = butlerEfficiency.upsertDraft({
    ...result.draft,
    proposalId: proposal.id,
    name: proposal.skillName,
  });
  butlerEfficiency.dryRun(proposal.id);
  return draft;
}

export function createExplicitButlerSkillDraft(
  input: Omit<ButlerConversationTurnLearningInput, 'surface'>,
): ButlerSkillDraft | undefined {
  if (!input.task) return undefined;
  const existingId = `skill-draft:${input.task.id}`;
  const existing = butlerEfficiency.store.getState().drafts.find(
    (item) => item.id === existingId,
  );
  if (existing) {
    const explicitDraft: ButlerSkillDraft = {
      ...existing,
      mode: 'explicit',
      conversationHidden: false,
      source: {
        ...existing.source,
        lineIds: [...new Set([...existing.source.lineIds, ...input.lineIds])],
      },
    };
    delete explicitDraft.proposalId;
    return butlerEfficiency.upsertDraft(explicitDraft);
  }
  const result = buildButlerSkillDraft({
    taskState: input.task,
    sessionId: input.sessionId,
    lineIds: input.lineIds,
    steps: input.steps,
    mode: 'explicit',
  });
  return result.ok ? butlerEfficiency.upsertDraft(result.draft) : undefined;
}
