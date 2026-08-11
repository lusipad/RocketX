import type { WiTemplatesConfig } from '../stores/wiTemplates';

/**
 * 工作区配置描述文件（issue #67）。
 *
 * 一份 rcx.workspace.json 提供各模块配置的默认值；用户自己改过的字段
 * 保持本地值不被覆盖，其余字段跟随配置。凭据永远不进配置文件。
 */

export interface WorkspaceConfig {
  version: 1;
  name?: string;
  rocketChat?: { url: string };
  ado?: {
    url?: string;
    auth?: 'pat' | 'ntlm' | 'none';
    /** 消息里 #123 链接用的 Web 地址；不填时复用 url */
    webUrl?: string;
  };
  workItemTemplates?: { url: string } | WiTemplatesConfig;
  /** 更新源（issue #106）：github 走原生通道；http/dir 需要 location */
  update?: {
    source: 'github' | 'http' | 'dir';
    location?: string;
  };
  /** 工作项相关团队默认值 */
  workItems?: {
    /** 层级工作项形态(六选一,见 stores/wiTemplates 的 HierarchyLayout) */
    hierarchyLayout?:
      | 'epic-split'
      | 'epic-single'
      | 'feature-split'
      | 'feature-single'
      | 'story-split'
      | 'story-single';
  };
}

function normalizeUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是字符串`);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${label} 不是合法的 URL：${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} 必须是 http/https 地址`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} 不能内嵌用户名密码——凭据不进配置文件`);
  }
  return value.trim().replace(/\/+$/, '');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 只能是 ${allowed.join(' / ')}`);
  }
  return value as T;
}

function parseInlineWorkItemTemplates(raw: any): WiTemplatesConfig {
  if (!Array.isArray(raw.templates) || raw.templates.length === 0) {
    throw new Error('workItemTemplates 模板列表为空');
  }
  const config: WiTemplatesConfig = {
    templates: raw.templates.map((template: any, templateIndex: number) => {
      const label = `workItemTemplates.templates[${templateIndex}]`;
      if (typeof template?.name !== 'string' || !template.name.trim()) {
        throw new Error(`${label}.name 必须是非空字符串`);
      }
      if (!Array.isArray(template.items) || template.items.length === 0) {
        throw new Error(`${label}.items 不能为空`);
      }
      return {
        name: template.name.trim(),
        items: template.items.map((item: any, itemIndex: number) => {
          const itemLabel = `${label}.items[${itemIndex}]`;
          if (typeof item?.type !== 'string' || !item.type.trim()) {
            throw new Error(`${itemLabel}.type 必须是非空字符串`);
          }
          if (typeof item.title !== 'string' || !item.title.trim()) {
            throw new Error(`${itemLabel}.title 必须是非空字符串`);
          }
          if (item.parent !== undefined
            && (!Number.isInteger(item.parent) || item.parent < 0 || item.parent >= itemIndex)) {
            throw new Error(`${itemLabel}.parent 必须引用前面的模板项`);
          }
          return {
            type: item.type.trim(),
            title: item.title.trim(),
            ...(item.parent !== undefined ? { parent: item.parent } : {}),
          };
        }),
      };
    }),
  };
  if (raw.defaultProject !== undefined) {
    if (typeof raw.defaultProject !== 'string' || !raw.defaultProject.trim()) {
      throw new Error('workItemTemplates.defaultProject 必须是非空字符串');
    }
    config.defaultProject = raw.defaultProject.trim();
  }
  return config;
}

/** 解析并校验配置文件。整体不可信输入：任何一处非法都拒绝导入，不做部分接受。 */
export function parseWorkspaceConfig(text: string): WorkspaceConfig {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('配置必须是 JSON 对象');
  if (raw.version !== 1) throw new Error('不支持的配置版本，当前只支持 version: 1');

  const config: WorkspaceConfig = { version: 1 };
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') throw new Error('name 必须是字符串');
    config.name = raw.name.trim();
  }
  if (raw.rocketChat !== undefined) {
    config.rocketChat = { url: normalizeUrl(raw.rocketChat?.url, 'rocketChat.url') };
  }
  if (raw.ado !== undefined) {
    if (!raw.ado || typeof raw.ado !== 'object') throw new Error('ado 必须是对象');
    const ado: WorkspaceConfig['ado'] = {};
    if (raw.ado.url !== undefined) ado.url = normalizeUrl(raw.ado.url, 'ado.url');
    if (raw.ado.mode !== undefined) {
      if (raw.ado.mode === 'direct') {
        /* 兼容旧配置：写回时不再保留 mode */
      } else if (raw.ado.mode === 'bridge') {
        throw new Error('ado.mode=bridge 已移除；请改用直连 Azure DevOps');
      } else {
        throw new Error('ado.mode 只兼容旧版 direct；bridge 已移除');
      }
    }
    if (raw.ado.auth !== undefined) {
      ado.auth = oneOf(raw.ado.auth, ['pat', 'ntlm', 'none'] as const, 'ado.auth');
    }
    if (raw.ado.webUrl !== undefined) ado.webUrl = normalizeUrl(raw.ado.webUrl, 'ado.webUrl');
    config.ado = ado;
  }
  if (raw.workItemTemplates !== undefined) {
    if (!raw.workItemTemplates || typeof raw.workItemTemplates !== 'object') {
      throw new Error('workItemTemplates 必须是对象');
    }
    const hasUrl = raw.workItemTemplates.url !== undefined;
    const hasTemplates = raw.workItemTemplates.templates !== undefined;
    if (hasUrl === hasTemplates) {
      throw new Error('workItemTemplates 必须且只能提供 url 或 templates');
    }
    config.workItemTemplates = hasUrl
      ? { url: normalizeUrl(raw.workItemTemplates.url, 'workItemTemplates.url') }
      : parseInlineWorkItemTemplates(raw.workItemTemplates);
  }
  if (raw.ai !== undefined) {
    throw new Error('ai 配置已移除；RocketX 统一使用 Codex 的模型与权限设置');
  }
  if (raw.update !== undefined) {
    if (!raw.update || typeof raw.update !== 'object') throw new Error('update 必须是对象');
    const source = oneOf(raw.update.source, ['github', 'http', 'dir'] as const, 'update.source');
    const update: WorkspaceConfig['update'] = { source };
    if (source === 'http') {
      update.location = normalizeUrl(raw.update.location, 'update.location');
    } else if (source === 'dir') {
      if (typeof raw.update.location !== 'string' || !raw.update.location.trim()) {
        throw new Error('update.location 在共享目录模式下必须是非空路径');
      }
      update.location = raw.update.location.trim();
    }
    config.update = update;
  }
  if (raw.workItems !== undefined) {
    if (!raw.workItems || typeof raw.workItems !== 'object') throw new Error('workItems 必须是对象');
    const workItems: WorkspaceConfig['workItems'] = {};
    if (raw.workItems.hierarchyLayout !== undefined) {
      workItems.hierarchyLayout = oneOf(
        raw.workItems.hierarchyLayout,
        ['epic-split', 'epic-single', 'feature-split', 'feature-single', 'story-split', 'story-single'] as const,
        'workItems.hierarchyLayout',
      );
    }
    config.workItems = workItems;
  }
  return config;
}

/** 更新源的比对口径：kind 与 location 任一变化都算变化 */
export function updateSourceFingerprint(source: { kind: string; location: string }): string {
  return `${source.kind}|${source.location.trim()}`;
}

/** 配置展开成的一个可勾选字段 */
export interface WorkspaceField {
  key: string;
  label: string;
  /** 配置里的值（规范化字符串，展示 + 比对共用一个口径） */
  incoming: string;
  /** 本地当前值（同口径；没配过为空串） */
  current: string;
  /** 本地当前值与配置一致，无需改动 */
  unchanged: boolean;
  /** 本地值与配置不同且不是上次从配置应用的——用户自己改过/配过，默认保留本地 */
  overridden: boolean;
  /** 建议的默认勾选：需要改动且不属于本地覆盖 */
  selected: boolean;
}

export interface WorkspaceCurrentValues {
  serverUrl?: string;
  adoBase?: string;
  adoAuth?: string;
  adoWebUrl?: string;
  templatesUrl?: string;
  templatesInline?: string;
  /** 更新源比对串（updateSourceFingerprint 口径） */
  updateSource?: string;
  /** 层级工作项当前形态 */
  hierarchyLayout?: string;
}

export function inlineWorkItemTemplatesFingerprint(config: WiTemplatesConfig): string {
  return JSON.stringify(config);
}

function field(
  key: string,
  label: string,
  incoming: string,
  current: string,
  lastApplied: Record<string, string>,
): WorkspaceField {
  const unchanged = current === incoming;
  // 第一次导入（没有 lastApplied 记录）时，本地已有的不同值同样视为用户自己配的
  const overridden = !unchanged && current !== '' && lastApplied[key] !== current;
  return { key, label, incoming, current, unchanged, overridden, selected: !unchanged && !overridden };
}

/**
 * 把配置展开成字段计划。覆盖判定：本地值 ≠ 配置值，且本地值不是上次从配置
 * 应用进去的 → 用户自己改过，默认不勾选（仍可手动勾选强制覆盖）。
 */
export function planWorkspaceFields(
  config: WorkspaceConfig,
  current: WorkspaceCurrentValues,
  lastApplied: Record<string, string>,
): WorkspaceField[] {
  const fields: WorkspaceField[] = [];
  if (config.rocketChat) {
    fields.push(field('server.url', 'Rocket.Chat 服务器', config.rocketChat.url, current.serverUrl ?? '', lastApplied));
  }
  if (config.ado?.url !== undefined) {
    fields.push(field('ado.base', 'ADO 地址', config.ado.url, current.adoBase ?? '', lastApplied));
  }
  if (config.ado?.auth !== undefined) {
    fields.push(field('ado.auth', 'ADO 认证方式', config.ado.auth, current.adoAuth ?? '', lastApplied));
  }
  if (config.ado?.webUrl !== undefined || config.ado?.url !== undefined) {
    const webUrl = config.ado?.webUrl ?? config.ado?.url ?? '';
    fields.push(field('ado.webUrl', 'ADO Web 链接地址', webUrl, current.adoWebUrl ?? '', lastApplied));
  }
  if (config.workItemTemplates) {
    if ('url' in config.workItemTemplates) {
      fields.push(
        field('templates.url', '工作项模板地址', config.workItemTemplates.url, current.templatesUrl ?? '', lastApplied),
      );
    } else {
      fields.push(
        field(
          'templates.inline',
          '内联工作项模板',
          inlineWorkItemTemplatesFingerprint(config.workItemTemplates),
          current.templatesInline ?? '',
          lastApplied,
        ),
      );
    }
  }
  if (config.update) {
    fields.push(
      field(
        'update.source',
        '更新源',
        updateSourceFingerprint({ kind: config.update.source, location: config.update.location ?? '' }),
        current.updateSource ?? '',
        lastApplied,
      ),
    );
  }
  if (config.workItems?.hierarchyLayout) {
    fields.push(
      field(
        'workItems.hierarchyLayout',
        '层级工作项形态',
        config.workItems.hierarchyLayout,
        current.hierarchyLayout ?? '',
        lastApplied,
      ),
    );
  }
  return fields;
}

/** 应用记录：记住每个字段上次从配置写入的值，作为下次「用户是否自己改过」的判据 */
export interface WorkspaceSourceAdoIdentity {
  adoBase?: string;
  auth?: 'pat' | 'ntlm' | 'bearer' | 'none';
  webUrl?: string;
  project: string;
  repository: string;
  ref: string;
  path: string;
  name?: string;
}

interface WorkspaceSourceBase {
  kind: 'url' | 'file' | 'ado';
  name?: string;
  importedAt: number;
  applied: Record<string, string>;
  /** 跟随团队配置更新（URL/ADO 来源默认开;false = 用户显式关掉） */
  follow?: boolean;
  /** 上次自动检查时间(节流用) */
  lastCheckedAt?: number;
}

export interface UrlWorkspaceSource extends WorkspaceSourceBase {
  kind: 'url';
  url: string;
}

export interface FileWorkspaceSource extends WorkspaceSourceBase {
  kind: 'file';
}

export interface AdoWorkspaceSource extends WorkspaceSourceBase {
  kind: 'ado';
  ado: WorkspaceSourceAdoIdentity;
}

export type WorkspaceSource = UrlWorkspaceSource | FileWorkspaceSource | AdoWorkspaceSource;

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SECRET_APPLIED_KEY = /(authorization|password|passwd|pat|token|secret|auth)/i;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeAppliedFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const applied: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fieldValue === 'string' && !SECRET_APPLIED_KEY.test(key)) applied[key] = fieldValue;
  }
  return applied;
}

function sanitizeSourceUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是字符串`);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${label} 不是合法的 URL：${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} 必须是 http/https 地址`);
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString().replace(/\/+$/, '');
}

function sanitizeWorkspaceSourceAdo(value: unknown): WorkspaceSourceAdoIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const project = nonEmptyString(raw.project);
  const repository = nonEmptyString(raw.repository);
  const ref = nonEmptyString(raw.ref);
  const path = nonEmptyString(raw.path);
  if (!project || !repository || !ref || !path) return null;
  const ado: WorkspaceSourceAdoIdentity = { project, repository, ref, path };
  const name = nonEmptyString(raw.name);
  if (name) ado.name = name;
  if (raw.adoBase !== undefined) ado.adoBase = sanitizeSourceUrl(raw.adoBase, 'workspaceSource.ado.adoBase');
  if (raw.auth !== undefined) {
    ado.auth = oneOf(raw.auth, ['pat', 'ntlm', 'bearer', 'none'] as const, 'workspaceSource.ado.auth');
  }
  if (raw.webUrl !== undefined) ado.webUrl = sanitizeSourceUrl(raw.webUrl, 'workspaceSource.ado.webUrl');
  return ado;
}

export function workspaceSourceIdentity(source: WorkspaceSource): string {
  if (source.kind === 'url') return JSON.stringify(['url', source.url]);
  if (source.kind === 'ado') {
    const ado = source.ado;
    return JSON.stringify([
      'ado',
      ado.adoBase ?? '',
      ado.auth ?? '',
      ado.webUrl ?? '',
      ado.project,
      ado.repository,
      ado.ref,
      ado.path,
      ado.name ?? '',
    ]);
  }
  return 'file';
}

export function workspaceSourceSnapshotKey(source: WorkspaceSource): string {
  return `${workspaceSourceIdentity(source)}|${source.importedAt}`;
}

function sanitizeWorkspaceSource(raw: unknown): WorkspaceSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const importedAt = finiteTimestamp(source.importedAt);
  if (importedAt === undefined) return null;
  const applied = sanitizeAppliedFields(source.applied);
  const name = nonEmptyString(source.name);
  // 旧版文件导入只记录 name/importedAt/applied，没有 kind；无 URL 时按 file 迁移。
  const kind = nonEmptyString(source.kind) ?? (nonEmptyString(source.url) ? 'url' : 'file');
  const follow = typeof source.follow === 'boolean' ? source.follow : undefined;
  const lastCheckedAt = finiteTimestamp(source.lastCheckedAt);
  try {
    if (kind === 'url') {
      const url = source.url !== undefined ? sanitizeSourceUrl(source.url, 'workspaceSource.url') : undefined;
      if (!url) return null;
      return {
        kind: 'url',
        url,
        ...(name ? { name } : {}),
        importedAt,
        applied,
        ...(follow !== undefined ? { follow } : {}),
        ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      };
    }
    if (kind === 'ado') {
      const ado = sanitizeWorkspaceSourceAdo(source.ado);
      if (!ado) return null;
      return {
        kind: 'ado',
        ado,
        ...(name ? { name } : {}),
        importedAt,
        applied,
        ...(follow !== undefined ? { follow } : {}),
        ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      };
    }
    if (kind === 'file') {
      return {
        kind: 'file',
        ...(name ? { name } : {}),
        importedAt,
        applied,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 该不该做一次自动同步检查:有 URL 来源、没被显式关掉、距上次检查满一天。
 * 纯函数,时钟注入,回归可测。
 */
export function shouldCheckWorkspaceSync(
  source: WorkspaceSource | null,
  now = Date.now(),
): boolean {
  if (!source || (source.kind !== 'url' && source.kind !== 'ado')) return false;
  if (source.follow === false) return false;
  return now - (source.lastCheckedAt ?? 0) >= SYNC_INTERVAL_MS;
}

/** 本次同步值得提醒的变化:会被默认勾选的字段(排除本地一致与用户覆盖) */
export function pendingWorkspaceFields(fields: WorkspaceField[]): WorkspaceField[] {
  return fields.filter((item) => item.selected);
}

const SOURCE_KEY = 'rcx-workspace-source';
export const WORKSPACE_SOURCE_CHANGED_EVENT = 'rcx-workspace-source-changed';

export function loadWorkspaceSource(): WorkspaceSource | null {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    return raw ? sanitizeWorkspaceSource(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceSource(source: WorkspaceSource): void {
  try {
    const sanitized = sanitizeWorkspaceSource(source);
    if (!sanitized) return;
    localStorage.setItem(SOURCE_KEY, JSON.stringify(sanitized));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WORKSPACE_SOURCE_CHANGED_EVENT));
    }
  } catch {
    /* 存储满时只影响下次覆盖判定 */
  }
}

/** 合并本次应用的字段值到应用记录；未勾选的字段保留旧记录 */
export function mergeAppliedFields(
  previous: WorkspaceSource | null,
  update: {
    url?: string;
    name?: string;
    importedAt: number;
    sourceKind?: 'url' | 'file' | 'ado';
    ado?: WorkspaceSourceAdoIdentity;
    checkedAt?: number;
  },
  appliedNow: Record<string, string>,
): WorkspaceSource {
  const kind = update.sourceKind
    ?? (update.ado ? 'ado' : update.url ? 'url' : previous?.kind ?? 'file');
  const nextName = update.name ?? previous?.name;
  const nextApplied = { ...previous?.applied, ...appliedNow };
  if (kind === 'file') {
    return {
      kind: 'file',
      ...(nextName ? { name: nextName } : {}),
      importedAt: update.importedAt,
      applied: nextApplied,
    };
  }
  if (kind === 'ado') {
    const ado = update.ado ?? (previous?.kind === 'ado' ? previous.ado : undefined);
    if (!ado) {
      return {
        kind: 'file',
        ...(nextName ? { name: nextName } : {}),
        importedAt: update.importedAt,
        applied: nextApplied,
      };
    }
    const next: AdoWorkspaceSource = {
      kind: 'ado',
      ado,
      ...(nextName ? { name: nextName } : {}),
      importedAt: update.importedAt,
      applied: nextApplied,
    };
    const sameIdentity = previous ? workspaceSourceIdentity(previous) === workspaceSourceIdentity(next) : false;
    return {
      ...next,
      follow: sameIdentity ? previous?.follow : true,
      ...(update.checkedAt !== undefined
        ? { lastCheckedAt: update.checkedAt }
        : sameIdentity && previous?.lastCheckedAt !== undefined
          ? { lastCheckedAt: previous.lastCheckedAt }
          : {}),
    };
  }
  const previousUrl = previous?.kind === 'url' ? previous.url : undefined;
  const url = normalizeUrl(update.url ?? previousUrl, 'workspaceSource.url');
  const next: UrlWorkspaceSource = {
    kind: 'url',
    url,
    ...(nextName ? { name: nextName } : {}),
    importedAt: update.importedAt,
    applied: nextApplied,
  };
  const sameIdentity = previous ? workspaceSourceIdentity(previous) === workspaceSourceIdentity(next) : false;
  return {
    ...next,
    follow: sameIdentity ? previous?.follow : true,
    ...(update.checkedAt !== undefined
      ? { lastCheckedAt: update.checkedAt }
      : sameIdentity && previous?.lastCheckedAt !== undefined
        ? { lastCheckedAt: previous.lastCheckedAt }
        : {}),
  };
}

/** ADO PAT 与连接绑定；地址或认证方式任一变化都必须解绑。 */
export function adoConnectionChanged(
  current: { adoBase?: string; auth?: string } | undefined,
  incoming: { adoBase?: string; auth?: string },
): boolean {
  return !!current && (
    current.adoBase !== incoming.adoBase
    || current.auth !== incoming.auth
  );
}
