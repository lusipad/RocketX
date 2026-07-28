import {
  mirrorButlerProfileFile,
  onButlerArchiveHydrated,
  watchButlerProfileFile,
} from '../../../lib/butlerArchive';
import {
  listSkills,
  registerButlerSkillProvider,
  saveSkill,
} from '../../../lib/butlerProfile';
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
import { BUTLER_LEARNING_SKILLS } from './skills';

let initialized = false;

export function initializeButlerLearningExtensions(): void {
  if (initialized) return;
  initialized = true;
  registerButlerSkillProvider(
    'rocketx.butler.learning-skills',
    () => BUTLER_LEARNING_SKILLS,
  );
}

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
