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
