import { create } from 'zustand';
import {
  defaultContributionRange,
  loadAdoContributions,
  type ContributionEvent,
  type ContributionEventType,
  type ContributionFilter,
  type ContributionIdentity,
  type ContributionRange,
  type ContributionRepository,
  type ContributionSourceStatus,
} from '../lib/adoContributions';
import { useWorkbench } from './workbench';

interface ProfileContributionsState {
  identity: ContributionIdentity | null;
  events: ContributionEvent[];
  statuses: ContributionSourceStatus[];
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  range: ContributionRange;
  filters: ContributionFilter;
  projects: string[];
  repositories: ContributionRepository[];
  selectedDay: string | null;

  load: (options?: { force?: boolean }) => Promise<void>;
  setRange: (range: ContributionRange) => void;
  setFilters: (filters: Partial<ContributionFilter>) => void;
  selectDay: (day: string | null) => void;
  cancel: () => void;
}

let loadRevision = 0;
let activeController: AbortController | null = null;
let activeLoad: { key: string; promise: Promise<void> } | null = null;

function directConfig() {
  const { config, configRevision } = useWorkbench.getState();
  if (!config?.adoBase) return null;
  return {
    config: {
      adoBase: config.adoBase,
      pat: config.pat ?? '',
      auth: config.auth,
    },
    connectionRevision: configRevision,
  };
}

export const useProfileContributions = create<ProfileContributionsState>((set, get) => ({
  identity: null,
  events: [],
  statuses: [],
  loading: false,
  error: null,
  lastUpdated: null,
  range: defaultContributionRange(),
  filters: {},
  projects: [],
  repositories: [],
  selectedDay: null,

  load: ({ force = false } = {}) => {
    const connection = directConfig();
    if (!connection) {
      set({
        loading: false,
        error: '请先在设置中连接 Azure DevOps。',
        identity: null,
        events: [],
        statuses: [],
        projects: [],
        repositories: [],
        lastUpdated: null,
      });
      return Promise.resolve();
    }

    const state = get();
    const requestKey = JSON.stringify({
      adoBase: connection.config.adoBase.trim().replace(/\/+$/, '').toLowerCase(),
      auth: connection.config.auth ?? 'pat',
      connectionRevision: connection.connectionRevision,
      range: state.range,
      filters: {
        project: state.filters.project ?? '',
        repository: state.filters.repository ?? '',
        type: state.filters.type ?? '',
      },
      force,
    });
    if (activeLoad?.key === requestKey) return activeLoad.promise;

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const revision = ++loadRevision;
    const current = () => revision === loadRevision && !controller.signal.aborted;
    set({ loading: true, error: null });

    const request = { key: requestKey, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const snapshot = await loadAdoContributions(connection.config, {
          range: state.range,
          filters: state.filters,
          signal: controller.signal,
          force,
          connectionRevision: connection.connectionRevision,
        });
        if (!current()) return;
        set({
          identity: snapshot.identity,
          events: snapshot.events,
          statuses: snapshot.statuses,
          projects: snapshot.projects,
          repositories: snapshot.repositories,
          lastUpdated: snapshot.fetchedAt,
        });
      } catch (err) {
        if (!current()) return;
        set({ error: err instanceof Error ? err.message : String(err ?? '加载贡献数据失败') });
      } finally {
        if (activeLoad === request) activeLoad = null;
        if (current()) {
          activeController = null;
          set({ loading: false });
        }
      }
    })();
    activeLoad = request;
    return request.promise;
  },

  setRange: (range) => set({ range, selectedDay: null }),
  setFilters: (patch) => {
    const current = get().filters;
    const projectChanged = 'project' in patch && patch.project !== current.project;
    set({
      filters: {
        ...current,
        ...patch,
        ...(projectChanged && patch.repository === undefined ? { repository: undefined } : {}),
      },
      selectedDay: null,
    });
  },
  selectDay: (selectedDay) => set({ selectedDay }),
  cancel: () => {
    loadRevision += 1;
    activeController?.abort();
    activeController = null;
    activeLoad = null;
    set({ loading: false });
  },
}));

export type { ContributionEventType };
