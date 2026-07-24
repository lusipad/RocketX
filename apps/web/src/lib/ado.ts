/** 工作台（Azure DevOps）客户端侧：配置读写 + 直连查询 */

import { TimedLruCache } from './timedLruCache';

export const WORKBENCH_CONFIG_KEY = 'rcx-workbench';
/** markdown 渲染器用它把消息里的 #123 链接到 ADO 工作项 */
export const ADO_WEB_KEY = 'rcx-ado-web';

export interface WorkbenchConfig {
  adoBase?: string;
  pat?: string;
  /** 直连的认证方式（自动探测得出）。ntlm = Windows 集成认证，桌面端默认 */
  auth?: import('./adoDirect').AdoAuth;
  account: string;
}

interface StoredWorkbenchConfig {
  mode?: string;
  bridge?: string;
  adoBase?: string;
  pat?: string;
  auth?: import('./adoDirect').AdoAuth;
  account?: string;
}

function directConfig(config: WorkbenchConfig): import('./adoDirect').DirectConfig | null {
  if (!config.adoBase) return null;
  return {
    adoBase: config.adoBase,
    pat: config.pat ?? '',
    auth: config.auth,
  };
}

function parseStoredWorkbenchConfig(): { config: WorkbenchConfig | null; issue: string | null } {
  try {
    const raw = localStorage.getItem(WORKBENCH_CONFIG_KEY);
    if (!raw) return { config: null, issue: null };
    const parsed = JSON.parse(raw) as StoredWorkbenchConfig;
    if (!parsed || typeof parsed !== 'object') {
      return { config: null, issue: '工作台配置已损坏，请重新配置。' };
    }

    const adoBase = typeof parsed.adoBase === 'string'
      ? parsed.adoBase.trim().replace(/\/+$/, '') || undefined
      : undefined;
    const account = typeof parsed.account === 'string' ? parsed.account.trim() : '';
    const pat = typeof parsed.pat === 'string' ? parsed.pat.trim() || undefined : undefined;

    if (parsed.mode === 'bridge' || (!parsed.mode && typeof parsed.bridge === 'string')) {
      return {
        config: null,
        issue: '旧版 ado-bridge 配置已失效，请改用直连 Azure DevOps。',
      };
    }
    if (parsed.mode !== undefined && parsed.mode !== 'direct') {
      return {
        config: null,
        issue: '无法识别的工作台连接模式；当前只兼容旧版 direct 配置。',
      };
    }

    return {
      config: {
        adoBase,
        pat,
        auth: parsed.auth,
        account,
      },
      issue: null,
    };
  } catch {
    return { config: null, issue: '工作台配置已损坏，请重新配置。' };
  }
}

export function loadWorkbenchConfig(): WorkbenchConfig | null {
  return parseStoredWorkbenchConfig().config;
}

export function loadWorkbenchConfigIssue(): string | null {
  return parseStoredWorkbenchConfig().issue;
}

export function saveWorkbenchConfig(config: WorkbenchConfig): void {
  localStorage.setItem(WORKBENCH_CONFIG_KEY, JSON.stringify({
    adoBase: config.adoBase?.trim().replace(/\/+$/, '') || undefined,
    pat: config.pat?.trim() || undefined,
    auth: config.auth,
    account: config.account.trim(),
  }));
}

/** 消息里的 #123 要不要渲染成 ADO 工作项链接，取决于这个是否配过 */
export function adoWebBase(): string | null {
  // 渲染函数会走到这里，而它也在 Node 侧的测试里跑 —— 别假设有浏览器全局
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(ADO_WEB_KEY);
  } catch {
    return null;
  }
}

export interface AdoWorkItemInfo {
  id: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  project: string;
  assignedTo?: string;
  webUrl: string;
}

export interface AdoPullRequestInfo {
  id: number;
  title: string;
  repo: string;
  project: string;
  creator: string;
  creatorUnique: string;
  reviewers: {
    name: string;
    unique: string;
    vote: number;
    isRequired?: boolean;
    isContainer?: boolean;
  }[];
  sourceBranch: string;
  targetBranch: string;
  createdDate?: string;
  webUrl: string;
}

export interface AdoBuildInfo {
  id: number;
  buildNumber: string;
  definition: string;
  project: string;
  status: string;
  result: string;
  requestedFor: string;
  queueTime: string;
  finishTime: string;
  webUrl: string;
}

export type AdoUrlEntity =
  | { kind: 'workitem'; id: number; href: string }
  | { kind: 'pullrequest'; id: number; href: string }
  | { kind: 'build'; id: number; project: string; href: string };

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 只识别当前 ADO 集合内有稳定详情 API 的 URL；其他 URL 保持普通安全链接。 */
export function parseAdoUrl(href: string, adoBase: string | null): AdoUrlEntity | null {
  if (!adoBase) return null;
  let target: URL;
  let configured: URL;
  try {
    target = new URL(href);
    configured = new URL(adoBase);
  } catch {
    return null;
  }
  const basePath = configured.pathname.replace(/\/+$/, '');
  const targetPath = target.pathname.toLocaleLowerCase();
  const configuredPath = basePath.toLocaleLowerCase();
  if (
    target.origin.toLocaleLowerCase() !== configured.origin.toLocaleLowerCase() ||
    (targetPath !== configuredPath && !targetPath.startsWith(`${configuredPath}/`))
  ) {
    return null;
  }

  const relative = target.pathname.slice(basePath.length);
  const workItem = /\/_workitems\/edit\/(\d+)\b/i.exec(relative);
  if (workItem) return { kind: 'workitem', id: Number(workItem[1]), href };

  const pullRequest = /^(?:\/[^/]+)?\/_git\/[^/]+\/pullrequest\/(\d+)\/?$/i.exec(relative);
  if (pullRequest) {
    return {
      kind: 'pullrequest',
      id: Number(pullRequest[1]),
      href,
    };
  }

  if (/^\/([^/]+)\/_build(?:\/results)?\/?$/i.test(relative)) {
    const project = /^\/([^/]+)/.exec(relative)?.[1];
    const buildId = [...target.searchParams].find(([key]) => key.toLocaleLowerCase() === 'buildid')?.[1];
    if (project && /^\d+$/.test(buildId ?? '')) {
      return { kind: 'build', project: decoded(project), id: Number(buildId), href };
    }
  }
  return null;
}

const CACHE_TTL = 60_000;
const CACHE_LIMIT = 300;
const itemCache = new TimedLruCache<AdoWorkItemInfo | null>(CACHE_LIMIT, CACHE_TTL);
const inflight = new Map<string, Promise<AdoWorkItemInfo | null>>();

const entityCache = new TimedLruCache<unknown | null>(CACHE_LIMIT, CACHE_TTL);
const entityInflight = new Map<string, Promise<unknown | null>>();

function cachedEntity<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const cached = entityCache.get(key);
  if (cached.hit) return Promise.resolve(cached.value as T | null);
  const existing = entityInflight.get(key);
  if (existing) return existing as Promise<T | null>;
  const promise = load()
    .then((value) => {
      entityCache.set(key, value);
      return value;
    })
    .catch(() => {
      entityCache.set(key, null);
      return null;
    })
    .finally(() => entityInflight.delete(key));
  entityInflight.set(key, promise);
  return promise;
}

function itemKey(config: WorkbenchConfig, id: number): string {
  return `ado:${config.adoBase ?? ''}:${config.account}:${id}`;
}

/** 悬停卡片查询：60s 缓存 + 并发去重；未配置工作台返回 null */
export function fetchWorkItem(id: number): Promise<AdoWorkItemInfo | null> {
  const config = loadWorkbenchConfig();
  const direct = config && directConfig(config);
  if (!config || !direct) return Promise.resolve(null);
  const key = itemKey(config, id);

  const cached = itemCache.get(key);
  if (cached.hit) return Promise.resolve(cached.value);

  const existing = inflight.get(key);
  if (existing) return existing;

  const load = import('./adoDirect').then((m) =>
    m.directGetWorkItem(direct, id),
  );

  const promise = load
    .then((item) => {
      itemCache.set(key, item ?? null);
      return item ?? null;
    })
    .catch(() => {
      itemCache.set(key, null);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function fetchPullRequest(id: number): Promise<AdoPullRequestInfo | null> {
  const config = loadWorkbenchConfig();
  const direct = config && directConfig(config);
  if (!config || !direct) return Promise.resolve(null);
  const key = `ado:${config.adoBase}:${config.account}:pr:${id}`;
  return cachedEntity(key, () =>
    import('./adoDirect').then((module) => module.directGetPullRequest(direct, id)),
  );
}

export function fetchBuild(project: string, id: number): Promise<AdoBuildInfo | null> {
  const config = loadWorkbenchConfig();
  const direct = config && directConfig(config);
  if (!config || !direct) return Promise.resolve(null);
  const key = `ado:${config.adoBase}:${config.account}:build:${project}:${id}`;
  return cachedEntity(key, () =>
    import('./adoDirect').then((module) => module.directGetBuild(direct, project, id)),
  );
}

export async function commentWorkItem(id: number, text: string): Promise<void> {
  const config = loadWorkbenchConfig();
  if (!config) throw new Error('请先在工作台完成连接配置');
  const direct = directConfig(config);
  if (!direct) throw new Error('请先在工作台配置直连 Azure DevOps');
  const { directComment } = await import('./adoDirect');
  await directComment(direct, id, text, config.account);
}
