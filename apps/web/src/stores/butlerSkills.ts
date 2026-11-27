import { create } from 'zustand';
import type { MessageKey } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import {
  butlerSkillDelete,
  butlerSkillExportMarkdown,
  butlerSkillImportMarkdown,
  butlerSkillList,
  butlerSkillRecordRun,
  butlerSkillUpsert,
  type ButlerSkillApprovalPolicy,
  type ButlerSkillEntry,
} from '../platform/desktopCommands';
import { resolveButlerAccountScope, validateMemoryNoSecrets } from './butlerMemory';

export type { ButlerSkillApprovalPolicy, ButlerSkillEntry };

export interface ButlerSkillStarterTemplate {
  id: string;
  slug: string;
  category: string;
  approvalPolicy: ButlerSkillApprovalPolicy;
  triggers: string[];
  allowedTools: string[];
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  instructionsKey: MessageKey;
}

export const STARTER_SKILL_TEMPLATES: readonly ButlerSkillStarterTemplate[] = [
  {
    id: 'pr-review',
    slug: 'pr-review',
    category: 'code',
    approvalPolicy: 'confirm_write',
    triggers: ['review', 'pr', 'diff'],
    allowedTools: ['git_diff', 'read_file', 'github_get_pr_diff'],
    nameKey: 'butler.skills.starter.prReviewName',
    descriptionKey: 'butler.skills.starter.prReviewDesc',
    instructionsKey: 'butler.skills.starter.prReviewPrompt',
  },
  {
    id: 'daily-standup',
    slug: 'daily-standup',
    category: 'briefing',
    approvalPolicy: 'auto',
    triggers: ['standup', 'daily', 'briefing'],
    allowedTools: ['list_todos', 'list_calendar', 'list_mentions', 'list_work_cards'],
    nameKey: 'butler.skills.starter.dailyStandupName',
    descriptionKey: 'butler.skills.starter.dailyStandupDesc',
    instructionsKey: 'butler.skills.starter.dailyStandupPrompt',
  },
  {
    id: 'bug-triage',
    slug: 'bug-triage',
    category: 'ops',
    approvalPolicy: 'confirm_write',
    triggers: ['bug', 'triage', 'repro'],
    allowedTools: ['list_work_cards', 'read_file', 'terminal'],
    nameKey: 'butler.skills.starter.bugTriageName',
    descriptionKey: 'butler.skills.starter.bugTriageDesc',
    instructionsKey: 'butler.skills.starter.bugTriagePrompt',
  },
  {
    id: 'release-audit',
    slug: 'release-audit',
    category: 'ops',
    approvalPolicy: 'confirm_all',
    triggers: ['release', 'audit', 'checklist'],
    allowedTools: ['git_diff', 'terminal', 'project_policy_check'],
    nameKey: 'butler.skills.starter.releaseAuditName',
    descriptionKey: 'butler.skills.starter.releaseAuditDesc',
    instructionsKey: 'butler.skills.starter.releaseAuditPrompt',
  },
];

const STORAGE_PREFIX = 'rcx-butler-skills:v1:';

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function readLocalSkills(scope: string): ButlerSkillEntry[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey(scope)) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSkills(scope: string, skills: ButlerSkillEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey(scope), JSON.stringify(skills));
    }
  } catch {
    /* ignore storage quota errors in web mode */
  }
}

function normalizeClientSlug(rawSlug: string | null | undefined, name: string): string {
  const base = (rawSlug?.trim() || name.trim())
    .replace(/^\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
  if (base) return base;
  return `skill-${Date.now().toString(36).slice(-6)}`;
}

function parseFrontmatterList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      /* fallback below */
    }
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return trimmed
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function serializeSkillToMarkdown(skill: Pick<
  ButlerSkillEntry,
  'name' | 'slug' | 'description' | 'category' | 'approvalPolicy' | 'triggers' | 'allowedTools' | 'instructionsMd'
>): string {
  return [
    '---',
    `name: ${JSON.stringify(skill.name)}`,
    `slug: ${JSON.stringify(skill.slug)}`,
    `description: ${JSON.stringify(skill.description ?? '')}`,
    `category: ${JSON.stringify(skill.category || 'general')}`,
    `approvalPolicy: ${JSON.stringify(skill.approvalPolicy || 'confirm_write')}`,
    `triggers: ${JSON.stringify(skill.triggers ?? [])}`,
    `allowedTools: ${JSON.stringify(skill.allowedTools ?? [])}`,
    '---',
    '',
    skill.instructionsMd.trim(),
    '',
  ].join('\n');
}

export function parseSkillMarkdownDraft(markdown: string): {
  name: string;
  slug?: string;
  description: string;
  category: string;
  approvalPolicy: ButlerSkillApprovalPolicy;
  triggers: string[];
  allowedTools: string[];
  instructionsMd: string;
} {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('Markdown skill content cannot be empty');
  }
  let name = '';
  let slug: string | undefined;
  let description = '';
  let category = 'general';
  let approvalPolicy: ButlerSkillApprovalPolicy = 'confirm_write';
  let triggers: string[] = [];
  let allowedTools: string[] = [];
  let body = normalized;

  if (normalized.startsWith('---\n')) {
    const closeIdx = normalized.indexOf('\n---', 4);
    if (closeIdx !== -1) {
      const frontmatter = normalized.slice(4, closeIdx);
      body = normalized.slice(closeIdx + 4).trim();
      for (const rawLine of frontmatter.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        const unquoted = val.replace(/^["'](.*)["']$/, '$1');
        if (key === 'name' || key === 'title') name = unquoted;
        else if (key === 'slug' || key === 'id') slug = unquoted;
        else if (key === 'description') description = unquoted;
        else if (key === 'category' && unquoted) category = unquoted;
        else if ((key === 'approvalPolicy' || key === 'approval_policy')
          && (unquoted === 'auto' || unquoted === 'confirm_write' || unquoted === 'confirm_all')) {
          approvalPolicy = unquoted;
        } else if (key === 'triggers') triggers = parseFrontmatterList(val);
        else if (key === 'allowedTools' || key === 'allowed_tools') allowedTools = parseFrontmatterList(val);
      }
    }
  }

  if (!name) {
    const heading = body.split('\n')[0]?.match(/^#\s+(.+)$/)?.[1]?.trim();
    name = heading || 'Imported Skill';
  }
  if (!body) {
    throw new Error('Markdown skill instructions cannot be empty');
  }
  return {
    name,
    ...(slug ? { slug } : {}),
    description,
    category,
    approvalPolicy,
    triggers,
    allowedTools,
    instructionsMd: body,
  };
}

export function buildSkillExecutionPrompt(
  skill: Pick<ButlerSkillEntry, 'slug' | 'name' | 'approvalPolicy' | 'allowedTools' | 'instructionsMd'>,
  userExtra?: string,
): string {
  const header = `[Skill /${skill.slug}: ${skill.name}]`;
  const policyLine = `Approval policy: ${skill.approvalPolicy}${
    skill.allowedTools.length > 0 ? ` | Allowed tools: ${skill.allowedTools.join(', ')}` : ''
  }`;
  const extra = userExtra?.trim();
  return [
    header,
    policyLine,
    '',
    skill.instructionsMd.trim(),
    ...(extra ? ['', `Additional context: ${extra}`] : []),
  ].join('\n');
}

export interface UpsertSkillFormInput {
  id?: string;
  slug?: string;
  name: string;
  description?: string;
  category?: string;
  instructionsMd: string;
  triggers?: string[];
  allowedTools?: string[];
  approvalPolicy?: ButlerSkillApprovalPolicy;
  workspaceRoot?: string | null;
  enabled?: boolean;
  pinned?: boolean;
}

interface ButlerSkillsState {
  accountScope: string;
  skills: ButlerSkillEntry[];
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  hydrate: (force?: boolean) => Promise<void>;
  upsertSkill: (input: UpsertSkillFormInput) => Promise<ButlerSkillEntry>;
  deleteSkill: (id: string) => Promise<void>;
  toggleSkillEnabled: (id: string) => Promise<void>;
  toggleSkillPinned: (id: string) => Promise<void>;
  recordSkillRun: (id: string) => Promise<void>;
  importMarkdown: (markdown: string, workspaceRoot?: string | null) => Promise<ButlerSkillEntry>;
  exportMarkdown: (id: string) => Promise<string>;
  seedStarterTemplate: (
    templateId: string,
    translate: (key: MessageKey) => string,
    workspaceRoot?: string | null,
  ) => Promise<ButlerSkillEntry>;
}

export const useButlerSkills = create<ButlerSkillsState>((set, get) => ({
  accountScope: 'default',
  skills: [],
  hydrated: false,
  loading: false,
  error: null,

  hydrate: async (force = false) => {
    const scope = resolveButlerAccountScope();
    if (!force && get().hydrated && get().accountScope === scope) return;
    set({ loading: true, error: null });
    try {
      const skills = isTauriRuntime()
        ? await butlerSkillList({ accountScope: scope, includeDisabled: true })
        : readLocalSkills(scope);
      set({
        accountScope: scope,
        skills,
        hydrated: true,
        loading: false,
        error: null,
      });
    } catch (error) {
      set({
        accountScope: scope,
        skills: isTauriRuntime() ? get().skills : readLocalSkills(scope),
        hydrated: true,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  upsertSkill: async (input) => {
    const scope = resolveButlerAccountScope();
    const secretCheck = validateMemoryNoSecrets(
      `${input.name}\n${input.description ?? ''}\n${input.instructionsMd}`,
    );
    if (!secretCheck.ok) {
      throw new Error(secretCheck.reason || 'Skill content contains sensitive secrets');
    }
    const name = input.name.trim();
    const instructionsMd = input.instructionsMd.trim();
    if (!name || !instructionsMd) {
      throw new Error('Skill name and instructions are required');
    }

    let saved: ButlerSkillEntry;
    if (isTauriRuntime()) {
      saved = await butlerSkillUpsert({
        id: input.id ?? null,
        accountScope: scope,
        slug: input.slug ?? null,
        name,
        description: input.description?.trim() ?? '',
        category: input.category?.trim() || 'general',
        instructionsMd,
        triggers: input.triggers ?? [],
        allowedTools: input.allowedTools ?? [],
        approvalPolicy: input.approvalPolicy ?? 'confirm_write',
        workspaceRoot: input.workspaceRoot ?? null,
        enabled: input.enabled,
        pinned: input.pinned,
      });
    } else {
      const now = Date.now();
      const existingList = readLocalSkills(scope);
      const slug = normalizeClientSlug(input.slug, name);
      const current = input.id
        ? existingList.find((item) => item.id === input.id)
        : existingList.find((item) => item.slug === slug);
      saved = {
        id: current?.id ?? input.id ?? crypto.randomUUID(),
        accountScope: scope,
        slug,
        name,
        description: input.description?.trim() ?? '',
        category: input.category?.trim() || 'general',
        instructionsMd,
        triggers: [...new Set((input.triggers ?? []).map((v) => v.trim()).filter(Boolean))],
        allowedTools: [...new Set((input.allowedTools ?? []).map((v) => v.trim()).filter(Boolean))],
        approvalPolicy: input.approvalPolicy ?? 'confirm_write',
        workspaceRoot: input.workspaceRoot?.trim() || null,
        enabled: input.enabled ?? current?.enabled ?? true,
        pinned: input.pinned ?? current?.pinned ?? false,
        runCount: current?.runCount ?? 0,
        lastRunAt: current?.lastRunAt ?? null,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      const next = [saved, ...existingList.filter((item) => item.id !== saved.id)];
      writeLocalSkills(scope, next);
    }

    set((state) => ({
      accountScope: scope,
      skills: [saved, ...state.skills.filter((item) => item.id !== saved.id)]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    }));
    return saved;
  },

  deleteSkill: async (id) => {
    const scope = resolveButlerAccountScope();
    if (isTauriRuntime()) {
      await butlerSkillDelete(id, scope);
    } else {
      const next = readLocalSkills(scope).filter((item) => item.id !== id);
      writeLocalSkills(scope, next);
    }
    set((state) => ({
      skills: state.skills.filter((item) => item.id !== id),
    }));
  },

  toggleSkillEnabled: async (id) => {
    const target = get().skills.find((item) => item.id === id);
    if (!target) return;
    await get().upsertSkill({
      id: target.id,
      slug: target.slug,
      name: target.name,
      description: target.description,
      category: target.category,
      instructionsMd: target.instructionsMd,
      triggers: target.triggers,
      allowedTools: target.allowedTools,
      approvalPolicy: (target.approvalPolicy as ButlerSkillApprovalPolicy) || 'confirm_write',
      workspaceRoot: target.workspaceRoot,
      enabled: !target.enabled,
      pinned: target.pinned,
    });
  },

  toggleSkillPinned: async (id) => {
    const target = get().skills.find((item) => item.id === id);
    if (!target) return;
    await get().upsertSkill({
      id: target.id,
      slug: target.slug,
      name: target.name,
      description: target.description,
      category: target.category,
      instructionsMd: target.instructionsMd,
      triggers: target.triggers,
      allowedTools: target.allowedTools,
      approvalPolicy: (target.approvalPolicy as ButlerSkillApprovalPolicy) || 'confirm_write',
      workspaceRoot: target.workspaceRoot,
      enabled: target.enabled,
      pinned: !target.pinned,
    });
  },

  recordSkillRun: async (id) => {
    const scope = resolveButlerAccountScope();
    let updated: ButlerSkillEntry | undefined;
    if (isTauriRuntime()) {
      updated = await butlerSkillRecordRun(id, scope);
    } else {
      const now = Date.now();
      const next = readLocalSkills(scope).map((item) => {
        if (item.id !== id) return item;
        updated = { ...item, runCount: item.runCount + 1, lastRunAt: now };
        return updated;
      });
      writeLocalSkills(scope, next);
    }
    if (updated) {
      const nextEntry = updated;
      set((state) => ({
        skills: state.skills.map((item) => (item.id === id ? nextEntry : item)),
      }));
    }
  },

  importMarkdown: async (markdown, workspaceRoot = null) => {
    const scope = resolveButlerAccountScope();
    const parsed = parseSkillMarkdownDraft(markdown);
    const secretCheck = validateMemoryNoSecrets(
      `${parsed.name}\n${parsed.description}\n${parsed.instructionsMd}`,
    );
    if (!secretCheck.ok) {
      throw new Error(secretCheck.reason || 'Skill content contains sensitive secrets');
    }
    if (isTauriRuntime()) {
      const saved = await butlerSkillImportMarkdown({
        accountScope: scope,
        markdown,
        workspaceRoot,
      });
      set((state) => ({
        skills: [saved, ...state.skills.filter((item) => item.id !== saved.id)]
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
      }));
      return saved;
    }
    return get().upsertSkill({
      ...parsed,
      workspaceRoot,
    });
  },

  exportMarkdown: async (id) => {
    const scope = resolveButlerAccountScope();
    if (isTauriRuntime()) {
      return butlerSkillExportMarkdown(id, scope);
    }
    const target = get().skills.find((item) => item.id === id);
    if (!target) {
      throw new Error('Skill not found');
    }
    return serializeSkillToMarkdown(target);
  },

  seedStarterTemplate: async (templateId, translate, workspaceRoot = null) => {
    const tpl = STARTER_SKILL_TEMPLATES.find((item) => item.id === templateId);
    if (!tpl) {
      throw new Error(`Unknown starter template: ${templateId}`);
    }
    return get().upsertSkill({
      slug: tpl.slug,
      name: translate(tpl.nameKey),
      description: translate(tpl.descriptionKey),
      category: tpl.category,
      instructionsMd: translate(tpl.instructionsKey),
      triggers: tpl.triggers,
      allowedTools: tpl.allowedTools,
      approvalPolicy: tpl.approvalPolicy,
      workspaceRoot,
      enabled: true,
    });
  },
}));
