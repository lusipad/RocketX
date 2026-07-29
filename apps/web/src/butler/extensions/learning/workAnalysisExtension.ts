import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ButlerExtension } from '../../../kernel/butlerExtensions';
import { analyzeWorkInsights } from './workAnalysis';
import {
  BUTLER_OPERATION_JOURNAL_EXTENSION_ID,
  type ButlerOperationJournalApi,
} from './operationJournalExtension';
import type { WorkInsight } from './model';

export const BUTLER_WORK_ANALYSIS_EXTENSION_ID = 'rocketx.butler.work-analysis';

export interface ButlerWorkAnalysisState {
  insights: WorkInsight[];
}

export interface ButlerWorkAnalysisApi {
  store: StoreApi<ButlerWorkAnalysisState>;
  run(): void;
}

export function createButlerWorkAnalysisExtension():
ButlerExtension<ButlerWorkAnalysisApi> {
  return {
    manifest: {
      id: BUTLER_WORK_ANALYSIS_EXTENSION_ID,
      version: '1.0.0',
      requires: [BUTLER_OPERATION_JOURNAL_EXTENSION_ID],
    },
    activate(context) {
      const journal = context.get<ButlerOperationJournalApi>(
        BUTLER_OPERATION_JOURNAL_EXTENSION_ID,
      );
      const saved = context.readState<Partial<ButlerWorkAnalysisState>>();
      const store = createStore<ButlerWorkAnalysisState>(() => ({
        insights: Array.isArray(saved?.insights) ? saved.insights : [],
      }));
      context.on('host.storage-ready', () => {
        const hydrated = context.readState<Partial<ButlerWorkAnalysisState>>();
        store.setState({
          insights: Array.isArray(hydrated?.insights) ? hydrated.insights : [],
        }, true);
      });
      return {
        api: {
          store,
          run: () => {
            store.setState({ insights: analyzeWorkInsights(journal.store.getState().receipts) });
            context.writeState(store.getState());
            journal.record({
              action: 'run-analysis',
              intentKey: 'analysis:work-patterns',
              surface: 'learning',
            });
          },
        },
      };
    },
  };
}
