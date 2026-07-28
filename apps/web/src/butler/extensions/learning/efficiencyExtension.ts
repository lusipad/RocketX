import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ButlerExtension } from '../../../kernel/butlerExtensions';
import {
  buildImprovementProposal,
} from './improvementDesign';
import { mineRepetitionCandidates } from './workAnalysis';
import {
  BUTLER_OPERATION_JOURNAL_EXTENSION_ID,
  type ButlerOperationJournalApi,
} from './operationJournalExtension';
import type {
  ImprovementProposal,
  RepetitionCandidate,
} from './model';

export const BUTLER_EFFICIENCY_EXTENSION_ID = 'rocketx.butler.efficiency';

export interface ButlerSkillCatalog {
  names(): string[];
  install(skill: { name: string; description: string; body: string }): void;
}

export interface ButlerEfficiencyState {
  candidates: RepetitionCandidate[];
  proposals: ImprovementProposal[];
}

export interface ButlerEfficiencyApi {
  store: StoreApi<ButlerEfficiencyState>;
  run(): void;
  dryRun(id: string): void;
  enable(id: string): void;
  dismiss(id: string): void;
}

function updateProposal(
  proposals: readonly ImprovementProposal[],
  id: string,
  status: ImprovementProposal['status'],
): ImprovementProposal[] {
  return proposals.map((proposal) => proposal.id === id ? { ...proposal, status } : proposal);
}

export function createButlerEfficiencyExtension(
  skills: ButlerSkillCatalog,
): ButlerExtension<ButlerEfficiencyApi> {
  return {
    manifest: {
      id: BUTLER_EFFICIENCY_EXTENSION_ID,
      version: '1.0.0',
      requires: [BUTLER_OPERATION_JOURNAL_EXTENSION_ID],
    },
    activate(context) {
      const journal = context.get<ButlerOperationJournalApi>(
        BUTLER_OPERATION_JOURNAL_EXTENSION_ID,
      );
      const saved = context.readState<Partial<ButlerEfficiencyState>>();
      const store = createStore<ButlerEfficiencyState>(() => ({
        candidates: Array.isArray(saved?.candidates) ? saved.candidates : [],
        proposals: Array.isArray(saved?.proposals) ? saved.proposals : [],
      }));
      context.on('host.storage-ready', () => {
        const hydrated = context.readState<Partial<ButlerEfficiencyState>>();
        store.setState({
          candidates: Array.isArray(hydrated?.candidates) ? hydrated.candidates : [],
          proposals: Array.isArray(hydrated?.proposals) ? hydrated.proposals : [],
        }, true);
      });
      const persist = () => context.writeState(store.getState());
      const api: ButlerEfficiencyApi = {
        store,
        run: () => {
          const candidates = mineRepetitionCandidates(journal.store.getState().receipts);
          const priorStatuses = new Map(
            store.getState().proposals.map((proposal) => [proposal.id, proposal.status]),
          );
          const proposals = candidates.map((candidate) => {
            const proposal = buildImprovementProposal(candidate, skills.names());
            return { ...proposal, status: priorStatuses.get(proposal.id) ?? proposal.status };
          });
          store.setState({ candidates, proposals });
          persist();
        },
        dryRun: (id) => {
          const proposal = store.getState().proposals.find((item) => item.id === id);
          if (!proposal) return;
          store.setState({ proposals: updateProposal(store.getState().proposals, id, 'dry-run') });
          journal.record({
            action: 'dry-run-improvement',
            intentKey: `proposal:${proposal.target}`,
            surface: 'learning',
          });
          persist();
        },
        enable: (id) => {
          const proposal = store.getState().proposals.find((item) => item.id === id);
          if (!proposal || proposal.target !== 'micro-skill' || !proposal.skillName) return;
          skills.install({
            name: proposal.skillName,
            description: `从重复工作模式形成：${proposal.rationale}`,
            body: [
              proposal.title,
              '',
              '仅依据当前上下文和已授权工具执行，不读取或保存原始键鼠、屏幕及敏感凭据。',
              '',
              ...proposal.preview.map((line, index) => `${index + 1}. ${line}`),
              '4. 执行前展示将读取什么、将产出什么；产生副作用前必须等待用户确认。',
            ].join('\n'),
          });
          store.setState({ proposals: updateProposal(store.getState().proposals, id, 'enabled') });
          journal.record({
            action: 'enable-improvement',
            intentKey: `workflow:${proposal.skillName}`,
            surface: 'learning',
          });
          persist();
        },
        dismiss: (id) => {
          store.setState({ proposals: updateProposal(store.getState().proposals, id, 'dismissed') });
          persist();
        },
      };
      return { api };
    },
  };
}
