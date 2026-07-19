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

const EPIC_LEVEL = new Set(['epic', 'initiative']);

/**
 * 一键创建从 Feature 层起步：Epic/Initiative 属于长周期规划，不该随手批量建（issue #65）。
 * 砍掉顶层后不足两级时保留原层级，避免把级联退化成单项创建。
 */
function withoutEpicLevel(hierarchy: string[]): string[] {
  let start = 0;
  while (start < hierarchy.length && EPIC_LEVEL.has(hierarchy[start].toLocaleLowerCase())) start++;
  const trimmed = hierarchy.slice(start);
  return trimmed.length >= 2 ? trimmed : hierarchy;
}

/**
 * 层级工作项的四种形态（issue：层级可配置）。两个独立开关的组合：
 * 含不含 Feature 层（故事层以上） × 末级 Task 拆不拆【开发】/【测试】。
 */
export type HierarchyLayout = 'feature-split' | 'feature-single' | 'story-split' | 'story-single';

export const HIERARCHY_LAYOUT_OPTIONS: { value: HierarchyLayout; label: string }[] = [
  { value: 'feature-split', label: '完整层级 · 拆开发/测试（默认）' },
  { value: 'feature-single', label: '完整层级 · 单个 Task' },
  { value: 'story-split', label: '仅故事层 · 拆开发/测试' },
  { value: 'story-single', label: '仅故事层 · 单个 Task' },
];

const LAYOUT_KEY = 'rcx-wi-hierarchy-layout';

export function loadHierarchyLayout(): HierarchyLayout {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return HIERARCHY_LAYOUT_OPTIONS.some((option) => option.value === saved)
      ? (saved as HierarchyLayout)
      : 'feature-split';
  } catch {
    return 'feature-split';
  }
}

export function saveHierarchyLayout(layout: HierarchyLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* 存储不可用时只影响下次默认选择 */
  }
}

function hierarchyTemplate(types: string[], layout: HierarchyLayout = 'feature-split'): WiTemplate {
  const taskAtEnd = types.at(-1)?.toLocaleLowerCase() === 'task' && types.length > 1;
  // 「仅故事层」= 只留 故事层+Task 两级；过程模板没有末级 Task 时该开关无意义,保持完整层级
  const storyOnly = (layout === 'story-split' || layout === 'story-single') && taskAtEnd;
  const effective = storyOnly ? types.slice(-2) : types;
  const split = layout === 'feature-split' || layout === 'story-split';

  const chain = taskAtEnd ? effective.slice(0, -1) : effective;
  const items: CascadeTemplateItem[] = chain.map((type, index) => ({
    type,
    title: '{title}',
    ...(index > 0 ? { parent: index - 1 } : {}),
  }));
  if (taskAtEnd) {
    const parent = items.length - 1;
    const task = effective.at(-1)!;
    if (split) {
      items.push(
        { type: task, title: '【开发】{title}', parent },
        { type: task, title: '【测试】{title}', parent },
      );
    } else {
      items.push({ type: task, title: '{title}', parent });
    }
  }
  return { name: '层级工作项', items };
}

/** 结构预览:「Feature → User Story → 【开发】Task + 【测试】Task」 */
export function hierarchyPreview(template: WiTemplate): string {
  const chain = template.items.filter((item) => !item.title.startsWith('【'));
  const tasks = template.items.filter((item) => item.title.startsWith('【'));
  const chainText = chain.map((item) => item.type).join(' → ');
  if (tasks.length === 0) return chainText;
  const taskText = tasks
    .map((item) => `${item.title.replace('{title}', '')}${item.type}`)
    .join(' + ');
  return `${chainText} → ${taskText}`;
}

/**
 * 返回项目真正可创建的模板，并把固定模板类型替换为服务器返回的精确名称。
 * 「层级工作项」按过程配置生成（Basic/Scrum/CMMI/自定义都认），形态由
 * layout 四选一决定，始终排第一位；远程自定义模板跟在后面。
 */
export function workItemTemplatesForTypes(
  templates: WiTemplate[],
  availableTypes: string[],
  processHierarchy: string[] = [],
  layout: HierarchyLayout = 'feature-split',
): WiTemplate[] {
  const compatible = templates
    .filter((template) => templateSupportsTypes(template, availableTypes))
    .map((template) => resolveTemplateTypes(template, availableTypes));

  const exactHierarchy = processHierarchy
    .map((type) => actualType(type, availableTypes))
    .filter((type): type is string => !!type);
  const hierarchy = withoutEpicLevel(
    exactHierarchy.length >= 2 ? exactHierarchy : inferredHierarchy(availableTypes),
  );
  return hierarchy.length >= 2
    ? [hierarchyTemplate(hierarchy, layout), ...compatible]
    : compatible;
}

/** 优先保持常见的 Task；过程模板没有 Task 时退到第一个真实可用类型。 */
export function preferredWorkItemType(availableTypes: string[]): string {
  return availableTypes.find((type) => type.toLocaleLowerCase() === 'task') ?? availableTypes[0] ?? '';
}

// 「Feature 全套」「UserStory + Tasks」两个死级联已被可配置的「层级工作项」
// 取代(四种形态,见 HierarchyLayout);内置只留单项创建,自定义级联走远程模板。
const BUILTIN: WiTemplate[] = [
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
        const { ensureHttpOrigin, httpFetch } = await import('../lib/http');
        await ensureHttpOrigin(url);
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
