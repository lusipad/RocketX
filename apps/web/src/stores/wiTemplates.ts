import { create } from 'zustand';
import type { CascadeTemplateItem } from '../lib/adoDirect';

export interface WiTemplate {
  name: string;
  items: CascadeTemplateItem[];
}

export interface WiTemplatesConfig {
  defaultProject?: string;
  templates: WiTemplate[];
}

/** 模板里的每个固定类型都必须存在于项目过程模板；{type} 由单项类型选择器决定。 */
export function templateSupportsTypes(template: WiTemplate, availableTypes: string[]): boolean {
  if (availableTypes.length === 0) return false;
  const available = new Set(availableTypes.map((type) => type.toLocaleLowerCase()));
  return template.items.every(
    (item) => item.type === '{type}' || available.has(item.type.toLocaleLowerCase()),
  );
}

/** 优先保持常见的 Task；过程模板没有 Task 时退到第一个真实可用类型。 */
export function preferredWorkItemType(availableTypes: string[]): string {
  return availableTypes.find((type) => type.toLocaleLowerCase() === 'task') ?? availableTypes[0] ?? '';
}

const BUILTIN: WiTemplate[] = [
  {
    name: 'Feature 全套',
    items: [
      { type: 'Feature', title: '{title}' },
      { type: 'User Story', title: '{title}', parent: 0 },
      { type: 'Task', title: '【开发】{title}', parent: 1 },
      { type: 'Task', title: '【测试】{title}', parent: 1 },
    ],
  },
  {
    name: 'UserStory + Tasks',
    items: [
      { type: 'User Story', title: '{title}' },
      { type: 'Task', title: '【开发】{title}', parent: 0 },
      { type: 'Task', title: '【测试】{title}', parent: 0 },
    ],
  },
  {
    name: '单个工作项',
    items: [{ type: '{type}', title: '{title}' }],
  },
];

const URL_KEY = 'rcx-wi-template-url';
const CACHE_KEY = 'rcx-wi-template-cache';

function loadUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? '';
  } catch {
    return '';
  }
}

function loadCache(): WiTemplatesConfig | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface WiTemplatesState {
  url: string;
  remote: WiTemplatesConfig | null;
  loading: boolean;
  error: string | null;
  templates: WiTemplate[];
  defaultProject: string | undefined;
  setUrl: (url: string) => void;
  fetch: () => Promise<void>;
}

export const useWiTemplates = create<WiTemplatesState>((set, get) => {
  const cached = loadCache();
  return {
    url: loadUrl(),
    remote: cached,
    loading: false,
    error: null,
    templates: cached?.templates ?? BUILTIN,
    defaultProject: cached?.defaultProject,

    setUrl: (url) => {
      localStorage.setItem(URL_KEY, url);
      set({ url });
      if (url) void get().fetch();
      else {
        localStorage.removeItem(CACHE_KEY);
        set({ remote: null, templates: BUILTIN, defaultProject: undefined });
      }
    },

    fetch: async () => {
      const url = get().url;
      if (!url) return;
      set({ loading: true, error: null });
      try {
        const { httpFetch } = await import('../lib/http');
        const res = await httpFetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const data = JSON.parse(text) as WiTemplatesConfig;
        if (!data.templates?.length) throw new Error('模板列表为空');
        localStorage.setItem(CACHE_KEY, text);
        set({
          remote: data,
          templates: data.templates,
          defaultProject: data.defaultProject,
          loading: false,
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err), loading: false });
      }
    },
  };
});
