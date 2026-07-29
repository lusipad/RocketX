import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ButlerExtension } from '../../../kernel/butlerExtensions';
import {
  appendOperationReceipt,
  createOperationReceipt,
} from './workAnalysis';
import type {
  OperationAction,
  OperationReceipt,
} from './model';

export const BUTLER_OPERATION_JOURNAL_EXTENSION_ID = 'rocketx.butler.operation-journal';

export interface ButlerOperationInput {
  action: OperationAction;
  intentKey: string;
  surface: string;
  outcome?: OperationReceipt['outcome'];
  at?: number;
  durationMs?: number;
}

export interface ButlerOperationJournalState {
  receipts: OperationReceipt[];
  enabled: boolean;
}

export interface ButlerOperationJournalApi {
  store: StoreApi<ButlerOperationJournalState>;
  record(input: ButlerOperationInput): void;
  setEnabled(enabled: boolean): void;
}

export function createButlerOperationJournalExtension():
ButlerExtension<ButlerOperationJournalApi> {
  return {
    manifest: { id: BUTLER_OPERATION_JOURNAL_EXTENSION_ID, version: '1.0.0' },
    activate(context) {
      const saved = context.readState<Partial<ButlerOperationJournalState>>();
      const store = createStore<ButlerOperationJournalState>(() => ({
        receipts: Array.isArray(saved?.receipts) ? saved.receipts : [],
        enabled: saved?.enabled !== false,
      }));
      const persist = () => context.writeState(store.getState());
      const record = (input: ButlerOperationInput) => {
        if (!store.getState().enabled) return;
        store.setState({
          receipts: appendOperationReceipt(
            store.getState().receipts,
            createOperationReceipt(input),
          ),
        });
        persist();
      };
      context.on<ButlerOperationInput>('butler.operation', record);
      context.on('host.storage-ready', () => {
        const hydrated = context.readState<Partial<ButlerOperationJournalState>>();
        store.setState({
          receipts: Array.isArray(hydrated?.receipts) ? hydrated.receipts : [],
          enabled: hydrated?.enabled !== false,
        }, true);
      });
      return {
        api: {
          store,
          record,
          setEnabled: (enabled) => {
            store.setState({ enabled });
            persist();
          },
        },
      };
    },
  };
}
