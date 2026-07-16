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

const LAST_PROJECTS_KEY = 'rcx-wi-last-projects';

function projectScope(adoBase: string): string {
  return adoBase.trim().replace(/\/+$/, '').toLowerCase();
}

export function loadLastWorkItemProject(adoBase: string): string | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_PROJECTS_KEY) ?? '{}') as Record<string, string>;
    return saved[projectScope(adoBase)] || undefined;
  } catch {
    return undefined;
  }
}

export function saveLastWorkItemProject(adoBase: string, project: string): void {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_PROJECTS_KEY) ?? '{}') as Record<string, string>;
    saved[projectScope(adoBase)] = project;
    localStorage.setItem(LAST_PROJECTS_KEY, JSON.stringify(saved));
  } catch {
    /* 存储不可用时只影响下次默认选择 */
  }
}

export function preferredWorkItemProject(
  projects: string[],
  lastProject?: string,
  configuredDefault?: string,
): string {
  return [lastProject, configuredDefault].find((value) => value && projects.includes(value)) ?? projects[0] ?? '';
}

/** 模板里的每个固定类型都必须存在于项目过程模板；{type} 由单项类型选择器决定。 */
export function templateSupportsTypes(template: WiTemplate, availableTypes: string[]): boolean {
  if (availableTypes.length === 0) return false;
  const available = new Set(availableTypes.map((type) => type.toLocaleLowerCase()));
  return template.items.every(
    (item) => item.type === '{type}' || available.has(item.type.toLocaleLowerCase()),
  );
}

function actualType(type: string, availableTypes: string[]): string | undefined {
  const wanted = type.toLocaleLowerCase();
  return availableTypes.find((available) => available.toLocaleLowerCase() === wanted);
}

function resolveTemplateTypes(template: WiTemplate, availableTypes: string[]): WiTemplate {
  return {
    ...template,
    items: template.items.map((item) => ({
      ...item,
      type: item.type === '{type}' ? item.type : (actualType(item.type, availableTypes) ?? item.type),
    })),
  };
}

function inferredHierarchy(availableTypes: string[]): string[] {
  const levels = [
    ['Epic', 'Initiative'],
    ['Feature', 'Capability'],
    ['User Story', 'Product Backlog Item', 'Requirement', 'Issue', 'Story', 'Backlog Item'],
    ['Task'],
  ];
  return levels.flatMap((candidates) => {
    const type = candidates.map((candidate) => actualType(candidate, availableTypes)).find(Boolean);
    return type ? [type] : [];
  });
}

function hierarchyTemplate(types: string[]): WiTemplate {
  const taskAtEnd = types.at(-1)?.toLocaleLowerCase() === 'task' && types.length > 1;
  const chain = taskAtEnd ? types.slice(0, -1) : types;
  const items: CascadeTemplateItem[] = chain.map((type, index) => ({
    type,
    title: '{title}',
    ...(index > 0 ? { parent: index - 1 } : {}),
  }));
  if (taskAtEnd) {
    const parent = items.length - 1;
    items.push(
      { type: types.at(-1)!, title: '【开发】{title}', parent },
      { type: types.at(-1)!, title: '【测试】{title}', parent },
    );
  }
  return { name: '层级工作项', items };
}

/**
 * 返回项目真正可创建的模板，并把固定模板类型替换为服务器返回的精确名称。
 * 当 Agile 专用内置模板不适配时，按过程配置生成 Basic/Scrum/CMMI/自定义层级入口。
 */
export function workItemTemplatesForTypes(
  templates: WiTemplate[],
  availableTypes: string[],
  processHierarchy: string[] = [],
): WiTemplate[] {
  const compatible = templates
    .filter((template) => templateSupportsTypes(template, availableTypes))
    .map((template) => resolveTemplateTypes(template, availableTypes));
  if (compatible.some((template) => template.items.length > 1)) return compatible;

  const exactHierarchy = processHierarchy
    .map((type) => actualType(type, availableTypes))
    .filter((type): type is string => !!type);
  const hierarchy = exactHierarchy.length >= 2 ? exactHierarchy : inferredHierarchy(availableTypes);
  return hierarchy.length >= 2 ? [hierarchyTemplate(hierarchy), ...compatible] : compatible;
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
