import { t } from '../i18n';
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
    if (!isTauri) throw new Error(t('auth.workspaceSource.uncDesktopOnly'));
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('read_workspace_config_unc', { path });
  },
};

function parseFetchedWorkspaceConfig(text: string, label: string): WorkspaceConfig {
  try {
    return parseWorkspaceConfig(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(t('auth.workspaceSource.invalidConfig', { label, message }));
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
    if (!rawVersion) throw new Error(t('auth.workspaceSource.adoMissingBranch'));
    return rawVersion.startsWith('refs/') ? rawVersion : `refs/heads/${rawVersion}`;
  }
  if (rawType === 'tag') {
    if (!rawVersion) throw new Error(t('auth.workspaceSource.adoMissingTag'));
    return rawVersion.startsWith('refs/') ? rawVersion : `refs/tags/${rawVersion}`;
  }
  if (rawType === 'commit') {
    if (!rawVersion) throw new Error(t('auth.workspaceSource.adoMissingCommit'));
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
    throw new Error(t('auth.workspaceSource.adoWrongConnection', { current: configuredBase }));
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
    if (!path) throw new Error(t('auth.workspaceSource.adoMissingPath'));
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
    if (!path) throw new Error(t('auth.workspaceSource.adoItemsMissingPath'));
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
  if (!trimmed) throw new Error(t('auth.workspaceSource.emptyTarget'));
  if (/^\\\\/.test(trimmed)) return { kind: 'unc', path: normalizeUncWorkspacePath(trimmed) };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(t('auth.workspaceSource.invalidTarget'));
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(t('auth.workspaceSource.unsupportedProtocol'));
  }
  if (url.username || url.password) {
    throw new Error(t('auth.workspaceSource.noEmbeddedCredentials'));
  }
  const looksLikeAdo = /\/_git\/|\/_apis\/git\/repositories\//i.test(url.pathname);
  if (looksLikeAdo) {
    const parsed = parseAdoRepositoryFileUrl(trimmed, workbench);
    if (!parsed) throw new Error(t('auth.workspaceSource.unsupportedAdoUrl'));
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
    throw new Error(t('auth.workspaceSource.workbenchNotConfigured'));
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
  if (!response.ok) throw new Error(t('auth.workspaceSource.httpError', { status: response.status }));
  return parseFetchedWorkspaceConfig(await response.text(), t('auth.workspaceSource.label.teamFile'));
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
      config: parseFetchedWorkspaceConfig(await runtime.readUncFile(path), t('auth.workspaceSource.label.uncFile')),
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
      config: parseFetchedWorkspaceConfig(text, t('auth.workspaceSource.label.adoFile')),
      source: { kind: 'ado', ado: effectiveSource },
    };
  } catch (error) {
    if (error instanceof AdoRequestTimeoutError) {
      throw new Error(t('auth.workspaceSource.adoTimeout', { seconds: Math.ceil(error.timeoutMs / 1_000) }));
    }
    throw error;
  }
}
