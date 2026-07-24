import { create } from 'zustand';
import type { WorkbenchConfig } from '../lib/ado';

export interface CustomQuery {
  id: string;
  name: string;
  url: string;
  queryId: string;
  project?: string;
  /** 查询只属于创建时的 ADO 连接；旧数据首次加载时由当前连接认领。 */
  scope?: string;
}

export interface ParsedCustomQuery {
  project?: string;
  queryId: string;
  url: string;
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
  add: (scope: string, name: string, url: string, queryId: string, project?: string) => string;
  remove: (id: string) => void;
  claimLegacy: (scope: string, adoBase: string) => void;
}

export const useCustomQueries = create<CustomQueriesState>((set, get) => ({
  queries: load(),
  add: (scope, name, url, queryId, project) => {
    const id = crypto.randomUUID();
    const next = [...get().queries, { id, name, url, queryId, project, scope }];
    save(next);
    set({ queries: next });
    return id;
  },
  remove: (id) => {
    const next = get().queries.filter((q) => q.id !== id);
    save(next);
    set({ queries: next });
  },
  claimLegacy: (scope, adoBase) => {
    if (!scope || !adoBase) return;
    let changed = false;
    const next: CustomQuery[] = [];
    for (const query of get().queries) {
      if (query.scope && query.scope !== scope) {
        next.push(query);
        continue;
      }
      const parsed = parseQueryUrl(query.url || query.queryId, adoBase);
      if (!parsed || parsed.queryId.toLowerCase() !== query.queryId.toLowerCase()) {
        // 可能是另一台 ADO 连接留下的合法旧查询。当前连接不能认领时只隔离保留，
        // 等用户切回匹配的连接再迁移；queriesForScope 会确保它此时不可见、不可执行。
        next.push(query);
        continue;
      }
      const migrated = {
        ...query,
        scope,
        url: parsed.url,
        project: query.project ?? parsed.project,
      };
      if (
        query.scope !== migrated.scope ||
        query.url !== migrated.url ||
        query.project !== migrated.project
      ) {
        changed = true;
      }
      next.push(migrated);
    }
    if (!changed) return;
    save(next);
    set({ queries: next });
  },
}));

const GUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_ONLY = new RegExp(`^${GUID_SOURCE}$`, 'i');

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function withinAdoBase(url: URL, adoBase: string): boolean {
  const base = httpUrl(adoBase);
  if (!base || url.origin.toLowerCase() !== base.origin.toLowerCase()) return false;
  const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
  const path = url.pathname.toLowerCase();
  return !basePath || path === basePath || path.startsWith(`${basePath}/`);
}

export function customQueryConnectionScope(config: WorkbenchConfig | null): string {
  if (!config?.adoBase) return '';
  const base = httpUrl(config.adoBase);
  if (!base) return '';
  base.hash = '';
  base.search = '';
  base.pathname = base.pathname.replace(/\/+$/, '');
  // account 在 NTLM 模式下可能由身份探测异步回填，不能参与持久化作用域，
  // 否则查询会在回填前被认领、回填后立即从当前连接消失。
  return `ado\0${base.toString()}\0${config.auth ?? ''}`;
}

export function queriesForScope(
  queries: CustomQuery[],
  scope: string,
  adoBase: string,
): CustomQuery[] {
  if (!scope || !adoBase) return [];
  return queries.flatMap((query) => {
    if (query.scope && query.scope !== scope) return [];
    const parsed = parseQueryUrl(query.url || query.queryId, adoBase);
    if (!parsed || parsed.queryId.toLowerCase() !== query.queryId.toLowerCase()) return [];
    return [{ ...query, url: parsed.url, project: query.project ?? parsed.project }];
  });
}

export function parseQueryUrl(input: string, adoBase?: string): ParsedCustomQuery | null {
  const value = input.trim();
  if (GUID_ONLY.test(value)) {
    const base = adoBase ? httpUrl(adoBase) : null;
    if (adoBase && !base) return null;
    if (!base) return { queryId: value, url: '' };
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/_queries`;
    base.search = '';
    base.searchParams.set('id', value);
    base.hash = '';
    return { queryId: value, url: base.toString() };
  }

  const url = httpUrl(value);
  if (!url || (adoBase && !withinAdoBase(url, adoBase))) return null;
  const pathMatch = url.pathname.match(
    new RegExp(`/([^/]+)/_queries/(?:query|query-edit)/(${GUID_SOURCE})(?:/|$)`, 'i'),
  );
  if (pathMatch) {
    try {
      return {
        project: decodeURIComponent(pathMatch[1]),
        queryId: pathMatch[2],
        url: url.toString(),
      };
    } catch {
      return null;
    }
  }

  const id = url.searchParams.get('id');
  if (id && GUID_ONLY.test(id)) {
    const segments = url.pathname.split('/').filter(Boolean);
    const qi = segments.findIndex((segment) => segment.toLowerCase() === '_queries');
    try {
      return {
        project: qi > 0 ? decodeURIComponent(segments[qi - 1]) : undefined,
        queryId: id,
        url: url.toString(),
      };
    } catch {
      return null;
    }
  }
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
