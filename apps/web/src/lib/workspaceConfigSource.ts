import { ensureHttpOrigin, httpFetch } from './http';
import { loadWorkbenchConfig, type WorkbenchConfig } from './ado';
import { AdoRequestTimeoutError, directReadRepositoryFile, type DirectConfig } from './adoDirect';
import {
  parseWorkspaceConfig,
  workspaceSourceIdentity,
  type AdoWorkspaceSource,
  type WorkspaceConfig,
  type WorkspaceSource,
  type WorkspaceSourceAdoIdentity,
} from './workspaceConfig';

export type WorkspaceConfigRemoteSource =
  | { kind: 'url'; url: string }
  | { kind: 'ado'; ado: WorkspaceSourceAdoIdentity };

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
}

const DEFAULT_RUNTIME: WorkspaceConfigSourceRuntime = {
  ensureOrigin: ensureHttpOrigin,
  fetch: httpFetch,
  loadWorkbench: loadWorkbenchConfig,
  readAdoFile: directReadRepositoryFile,
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
