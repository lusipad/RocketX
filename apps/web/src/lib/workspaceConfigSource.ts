import { ensureHttpOrigin, httpFetch, isTauri } from './http';
import { loadWorkbenchConfig, type WorkbenchConfig } from './ado';
import { AdoRequestTimeoutError, directReadRepositoryFile, type DirectConfig } from './adoDirect';
import {
  normalizeUncWorkspacePath,
  parseWorkspaceConfig,
  workspaceSourceIdentity,
  type AdoWorkspaceSource,
  type WorkspaceConfig,
  type WorkspaceSource,
  type WorkspaceSourceAdoIdentity,
} from './workspaceConfig';

export type WorkspaceConfigRemoteSource =
  | { kind: 'url'; url: string }
  | { kind: 'ado'; ado: WorkspaceSourceAdoIdentity }
  | { kind: 'unc'; path: string };

export interface WorkspaceConfigFetchResult {
  config: WorkspaceConfig;
  source: WorkspaceConfigRemoteSource;
}

interface WorkspaceConfigSourceRuntime {
  ensureOrigin: typeof ensureHttpOrigin;
  fetch: typeof httpFetch;
  loadWorkbench: () => WorkbenchConfig | null;
  readAdoFile: (
    config: DirectConfig,
    source: WorkspaceSourceAdoIdentity,
  ) => Promise<string>;
  readUncFile: (path: string) => Promise<string>;
}

const DEFAULT_RUNTIME: WorkspaceConfigSourceRuntime = {
  ensureOrigin: ensureHttpOrigin,
  fetch: httpFetch,
  loadWorkbench: loadWorkbenchConfig,
  readAdoFile: directReadRepositoryFile,
  readUncFile: async (path) => {
    if (!isTauri) throw new Error('UNC 共享配置仅支持 RocketX 桌面端');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('read_workspace_config_unc', { path });
  },
};

function parseFetchedWorkspaceConfig(text: string, label: string): WorkspaceConfig {
  try {
    return parseWorkspaceConfig(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}不是合法的工作区配置：${message}`);
  }
}

function normalizedAdoBase(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeAdoRefFromUrl(version: string | null, versionType: string | null): string {
  const rawVersion = version?.trim();
  const rawType = versionType?.trim().toLowerCase();
  if (rawType === 'branch') {
    if (!rawVersion) throw new Error('ADO 链接缺少分支名');
    return rawVersion.startsWith('refs/') ? rawVersion : `refs/heads/${rawVersion}`;
  }
  if (rawType === 'tag') {
    if (!rawVersion) throw new Error('ADO 链接缺少标签名');
    return rawVersion.startsWith('refs/') ? rawVersion : `refs/tags/${rawVersion}`;
  }
  if (rawType === 'commit') {
    if (!rawVersion) throw new Error('ADO 链接缺少提交 SHA');
    return rawVersion;
  }
  if (!rawVersion) return 'refs/heads/main';
  if (/^GB/i.test(rawVersion)) {
    const branch = rawVersion.slice(2);
    return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  }
  if (/^GT/i.test(rawVersion)) {
    const tag = rawVersion.slice(2);
    return tag.startsWith('refs/') ? tag : `refs/tags/${tag}`;
  }
  if (/^GC/i.test(rawVersion)) return rawVersion.slice(2);
  return rawVersion.startsWith('refs/') ? rawVersion : `refs/heads/${rawVersion}`;
}

function ensureAdoBaseMatchesCurrentConnection(linkBase: string, workbench: WorkbenchConfig | null): void {
  const configuredBase = normalizedAdoBase(workbench?.adoBase);
  if (!configuredBase) return;
  const configured = new URL(configuredBase);
  const target = new URL(linkBase);
  const configuredPath = configured.pathname.replace(/\/+$/, '').toLowerCase();
  const targetPath = target.pathname.replace(/\/+$/, '').toLowerCase();
  if (
    configured.origin.toLowerCase() !== target.origin.toLowerCase()
    || configuredPath !== targetPath
  ) {
    throw new Error(`ADO 链接不属于当前工作台连接：当前是 ${configuredBase}`);
  }
}

function parseAdoRepositoryFileUrl(target: string, workbench: WorkbenchConfig | null): WorkspaceSourceAdoIdentity | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git');
  if (gitIndex >= 1 && gitIndex + 1 < segments.length && gitIndex === segments.length - 2) {
    const project = decodeSegment(segments[gitIndex - 1]);
    const repository = decodeSegment(segments[gitIndex + 1]);
    const path = url.searchParams.get('path');
    if (!path) throw new Error('ADO 仓库文件链接缺少 path 参数');
    const adoBase = `${url.origin}/${segments.slice(0, gitIndex - 1).join('/')}`;
    ensureAdoBaseMatchesCurrentConnection(adoBase, workbench);
    return {
      project,
      repository,
      ref: normalizeAdoRefFromUrl(
        url.searchParams.get('version'),
        url.searchParams.get('versionType'),
      ),
      path,
    };
  }

  const apisIndex = segments.findIndex((segment) => segment.toLowerCase() === '_apis');
  const repositoriesIndex = segments.findIndex((segment) => segment.toLowerCase() === 'repositories');
  const itemsTail = segments.slice(apisIndex);
  if (
    apisIndex >= 1
    && repositoriesIndex === apisIndex + 2
    && itemsTail.length === 5
    && itemsTail[1]?.toLowerCase() === 'git'
    && itemsTail[4]?.toLowerCase() === 'items'
  ) {
    const project = decodeSegment(segments[apisIndex - 1]);
    const repository = decodeSegment(segments[repositoriesIndex + 1]);
    const path = url.searchParams.get('path');
    if (!path) throw new Error('ADO Items API 链接缺少 path 参数');
    const adoBase = `${url.origin}/${segments.slice(0, apisIndex - 1).join('/')}`;
    ensureAdoBaseMatchesCurrentConnection(adoBase, workbench);
    return {
      project,
      repository,
      ref: normalizeAdoRefFromUrl(
        url.searchParams.get('versionDescriptor.version') ?? url.searchParams.get('version'),
        url.searchParams.get('versionDescriptor.versionType') ?? url.searchParams.get('versionType'),
      ),
      path,
    };
  }
  return null;
}

export function parseWorkspaceConfigRemoteInput(
  target: string,
  workbench: WorkbenchConfig | null = loadWorkbenchConfig(),
): WorkspaceConfigRemoteSource {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('请先填写配置来源');
  if (/^\\\\/.test(trimmed)) return { kind: 'unc', path: normalizeUncWorkspacePath(trimmed) };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('请输入可访问的 URL、ADO 仓库文件链接，或 \\\\server\\share\\... 形式的 UNC 路径');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('配置来源只支持 http/https、ADO 链接或 UNC 共享路径');
  }
  if (url.username || url.password) {
    throw new Error('配置来源地址不能内嵌用户名密码');
  }
  const looksLikeAdo = /\/_git\/|\/_apis\/git\/repositories\//i.test(url.pathname);
  if (looksLikeAdo) {
    const parsed = parseAdoRepositoryFileUrl(trimmed, workbench);
    if (!parsed) throw new Error('目前只支持 ADO 仓库文件页面链接或 Git Items API 单文件链接');
    return { kind: 'ado', ado: parsed };
  }
  return { kind: 'url', url: trimmed };
}

export function adoIdentityForWorkbench(
  source: WorkspaceSourceAdoIdentity,
  workbench: WorkbenchConfig | null,
): WorkspaceSourceAdoIdentity & { adoBase: string; auth: NonNullable<WorkbenchConfig['auth']> } {
  const adoBase = normalizedAdoBase(workbench?.adoBase);
  if (!adoBase) {
    throw new Error('请先在“工作台”里配置当前 Azure DevOps 连接，再从 ADO 仓库读取团队配置');
  }
  return {
    project: source.project,
    repository: source.repository,
    ref: source.ref,
    path: source.path,
    ...(source.name ? { name: source.name } : {}),
    ...(source.webUrl ? { webUrl: source.webUrl } : {}),
    adoBase,
    auth: workbench?.auth ?? 'pat',
  };
}

export function rebindAdoWorkspaceSource(
  source: AdoWorkspaceSource,
  workbench: WorkbenchConfig | null,
): AdoWorkspaceSource {
  const next = { ...source, ado: adoIdentityForWorkbench(source.ado, workbench) };
  return workspaceSourceIdentity(next) === workspaceSourceIdentity(source)
    ? source
    : { ...next, lastCheckedAt: undefined };
}

/** URL 来源统一入口：桌面端每次进程启动后都必须先登记 HTTP origin。 */
export async function fetchWorkspaceConfig(
  target: string,
  runtime: {
    ensureOrigin: typeof ensureHttpOrigin;
    fetch: typeof httpFetch;
  } = { ensureOrigin: ensureHttpOrigin, fetch: httpFetch },
): Promise<WorkspaceConfig> {
  const url = target.trim();
  await runtime.ensureOrigin(url);
  const response = await runtime.fetch(url);
  if (!response.ok) throw new Error(`团队配置返回 HTTP ${response.status}`);
  return parseFetchedWorkspaceConfig(await response.text(), '团队配置文件');
}

export function remoteWorkspaceConfigSource(source: WorkspaceSource | null): WorkspaceConfigRemoteSource | null {
  if (!source) return null;
  if (source.kind === 'url') return { kind: 'url', url: source.url };
  if (source.kind === 'ado') return { kind: 'ado', ado: source.ado };
  if (source.kind === 'unc') return { kind: 'unc', path: source.path };
  return null;
}

export async function fetchWorkspaceConfigFromSource(
  source: WorkspaceConfigRemoteSource,
  runtime: WorkspaceConfigSourceRuntime = DEFAULT_RUNTIME,
): Promise<WorkspaceConfigFetchResult> {
  if (source.kind === 'url') {
    const url = source.url.trim();
    return {
      config: await fetchWorkspaceConfig(url, runtime),
      source: { kind: 'url', url },
    };
  }
  if (source.kind === 'unc') {
    const path = normalizeUncWorkspacePath(source.path);
    return {
      config: parseFetchedWorkspaceConfig(await runtime.readUncFile(path), 'UNC 共享配置文件'),
      source: { kind: 'unc', path },
    };
  }

  const workbench = runtime.loadWorkbench();
  const effectiveSource = adoIdentityForWorkbench(source.ado, workbench);
  const adoBase = effectiveSource.adoBase;

  try {
    const text = await runtime.readAdoFile(
      {
        adoBase,
        pat: workbench?.pat ?? '',
        auth: workbench?.auth,
      },
      effectiveSource,
    );
    return {
      config: parseFetchedWorkspaceConfig(text, 'ADO 仓库文件'),
      source: { kind: 'ado', ado: effectiveSource },
    };
  } catch (error) {
    if (error instanceof AdoRequestTimeoutError) {
      throw new Error(`读取 ADO 团队配置超时（${Math.ceil(error.timeoutMs / 1_000)} 秒）`);
    }
    throw error;
  }
}
