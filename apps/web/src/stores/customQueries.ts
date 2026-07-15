import { create } from 'zustand';

export interface CustomQuery {
  id: string;
  name: string;
  url: string;
  queryId: string;
  project?: string;
}

const STORAGE_KEY = 'rcx-custom-queries';

function load(): CustomQuery[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function save(queries: CustomQuery[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queries));
}

interface CustomQueriesState {
  queries: CustomQuery[];
  add: (name: string, url: string, queryId: string, project?: string) => string;
  remove: (id: string) => void;
}

export const useCustomQueries = create<CustomQueriesState>((set, get) => ({
  queries: load(),
  add: (name, url, queryId, project) => {
    const id = crypto.randomUUID();
    const next = [...get().queries, { id, name, url, queryId, project }];
    save(next);
    set({ queries: next });
    return id;
  },
  remove: (id) => {
    const next = get().queries.filter((q) => q.id !== id);
    save(next);
    set({ queries: next });
  },
}));

export function parseQueryUrl(url: string): { project?: string; queryId: string } | null {
  // /_queries/query/{guid} or /_queries/query-edit/{guid}
  const m1 = url.match(/\/([^/]+)\/_queries\/(?:query|query-edit)\/([0-9a-f-]{36})/i);
  if (m1) return { project: decodeURIComponent(m1[1]), queryId: m1[2] };
  // /_queries?id={guid}
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) {
      const segments = u.pathname.split('/').filter(Boolean);
      const qi = segments.indexOf('_queries');
      return { project: qi > 0 ? decodeURIComponent(segments[qi - 1]) : undefined, queryId: id };
    }
  } catch {
    /* not a URL */
  }
  // bare GUID
  const m2 = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m2) return { queryId: m2[1] };
  return null;
}

export interface CustomQueryLoadState<T> {
  scope: string;
  cache: Record<string, T>;
  loading: Record<string, number>;
  errors: Record<string, string>;
  revisions: Record<string, number>;
}

export function createCustomQueryLoadState<T>(scope: string): CustomQueryLoadState<T> {
  return { scope, cache: {}, loading: {}, errors: {}, revisions: {} };
}

export function shouldFetchCustomQuery<T>(
  id: string,
  state: CustomQueryLoadState<T>,
): boolean {
  return (
    state.cache[id] === undefined &&
    state.loading[id] === undefined &&
    state.errors[id] === undefined
  );
}

export function beginCustomQueryLoad<T>(
  state: CustomQueryLoadState<T>,
  scope: string,
  id: string,
  force = false,
): { state: CustomQueryLoadState<T>; revision: number } | null {
  const current = state.scope === scope ? state : createCustomQueryLoadState<T>(scope);
  if (!force && !shouldFetchCustomQuery(id, current)) return null;

  const revision = (current.revisions[id] ?? 0) + 1;
  const errors = { ...current.errors };
  delete errors[id];
  return {
    revision,
    state: {
      ...current,
      loading: { ...current.loading, [id]: revision },
      errors,
      revisions: { ...current.revisions, [id]: revision },
    },
  };
}

export function isCurrentCustomQueryLoad<T>(
  state: CustomQueryLoadState<T>,
  scope: string,
  id: string,
  revision: number,
): boolean {
  return state.scope === scope && state.revisions[id] === revision;
}

export function resolveCustomQueryLoad<T>(
  state: CustomQueryLoadState<T>,
  scope: string,
  id: string,
  revision: number,
  value: T,
): CustomQueryLoadState<T> {
  if (!isCurrentCustomQueryLoad(state, scope, id, revision)) return state;
  return { ...state, cache: { ...state.cache, [id]: value } };
}

export function rejectCustomQueryLoad<T>(
  state: CustomQueryLoadState<T>,
  scope: string,
  id: string,
  revision: number,
  message: string,
): CustomQueryLoadState<T> {
  if (!isCurrentCustomQueryLoad(state, scope, id, revision)) return state;
  return { ...state, errors: { ...state.errors, [id]: message } };
}

export function finishCustomQueryLoad<T>(
  state: CustomQueryLoadState<T>,
  scope: string,
  id: string,
  revision: number,
): CustomQueryLoadState<T> {
  if (!isCurrentCustomQueryLoad(state, scope, id, revision)) return state;
  const loading = { ...state.loading };
  delete loading[id];
  return { ...state, loading };
}

export function removeCustomQueryLoad<T>(
  state: CustomQueryLoadState<T>,
  id: string,
): CustomQueryLoadState<T> {
  const cache = { ...state.cache };
  const loading = { ...state.loading };
  const errors = { ...state.errors };
  const revisions = { ...state.revisions };
  delete cache[id];
  delete loading[id];
  delete errors[id];
  delete revisions[id];
  return { ...state, cache, loading, errors, revisions };
}
