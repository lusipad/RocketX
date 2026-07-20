import { ensureHttpOrigin, httpFetch } from './http';

/**
 * 更新源配置（issue #106）：受限网络里 GitHub Releases 不可达，更新检查
 * 支持三种源——GitHub（默认，走 tauri updater 原生通道全自动）、内网
 * HTTP（任意静态服务托管发布产物）、共享目录（SMB/UNC，webview 读不了
 * 网络路径，由 Rust 命令读清单）。pip/nuget 不适配桌面 GUI 应用的安装与
 * 更新语义，内网诉求由后两者覆盖。
 */
export type UpdateSourceKind = 'github' | 'http' | 'dir';

export interface UpdateSourceConfig {
  kind: UpdateSourceKind;
  /** http：托管目录或 latest.json 的 URL；dir：共享目录路径；github 忽略 */
  location: string;
}

export interface UpdateSourceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UpdateProbe {
  hasUpdate: boolean;
  version: string;
  notes?: string;
  /** dir 源：清单声明且真实存在的安装包绝对路径 */
  installerPath?: string;
  /** http 源：Windows 安装包的下载地址 */
  downloadUrl?: string;
}

const KEY = 'rcx-update-source';

function browserStorage(): UpdateSourceStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

export function loadUpdateSource(
  storage: UpdateSourceStorage | undefined = browserStorage(),
): UpdateSourceConfig {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { kind: 'github', location: '' };
    const parsed = JSON.parse(raw) as Partial<UpdateSourceConfig>;
    const kind = parsed.kind === 'http' || parsed.kind === 'dir' ? parsed.kind : 'github';
    return { kind, location: typeof parsed.location === 'string' ? parsed.location : '' };
  } catch {
    return { kind: 'github', location: '' };
  }
}

export function saveUpdateSource(
  config: UpdateSourceConfig,
  storage: UpdateSourceStorage | undefined = browserStorage(),
): void {
  storage?.setItem(KEY, JSON.stringify({ kind: config.kind, location: config.location.trim() }));
}

/**
 * 版本比较：数字三段逐位比。容 v 前缀与预发布后缀（截到首个非数字段），
 * 段缺省按 0——共享目录里手工维护的清单不一定写得规整。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

interface UpdateManifest {
  version: string;
  notes?: string;
  platforms?: Record<string, { url?: string }>;
}

/** tauri updater 的 latest.json → 探测结果（Windows 平台条目优先） */
export function parseUpdateManifest(raw: string, currentVersion: string): UpdateProbe {
  let manifest: UpdateManifest;
  try {
    manifest = JSON.parse(raw) as UpdateManifest;
  } catch {
    throw new Error('更新清单不是有效 JSON（应为 tauri updater 的 latest.json）');
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('更新清单缺少 version 字段');
  }
  const windows =
    manifest.platforms?.['windows-x86_64']?.url ?? manifest.platforms?.['windows-x86_64-msi']?.url;
  return {
    hasUpdate: compareVersions(manifest.version, currentVersion) > 0,
    version: manifest.version.replace(/^v/i, ''),
    notes: typeof manifest.notes === 'string' ? manifest.notes : undefined,
    downloadUrl: typeof windows === 'string' ? windows : undefined,
  };
}

/** http 源：location 直接指向 latest.json 或其所在目录 */
export function manifestUrlOf(location: string): string {
  const trimmed = location.trim().replace(/\/+$/, '');
  return /latest\.json$/i.test(trimmed) ? trimmed : `${trimmed}/latest.json`;
}

export async function probeHttpSource(location: string, currentVersion: string): Promise<UpdateProbe> {
  const url = manifestUrlOf(location);
  await ensureHttpOrigin(url);
  const response = await httpFetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`更新源返回 ${response.status}`);
  return parseUpdateManifest(await response.text(), currentVersion);
}

export async function probeDirSource(location: string, currentVersion: string): Promise<UpdateProbe> {
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<{ manifest: string; installerPath: string | null }>(
    'read_update_manifest_dir',
    { dir: location.trim() },
  );
  const probe = parseUpdateManifest(result.manifest, currentVersion);
  return { ...probe, installerPath: result.installerPath ?? undefined };
}

export async function launchDirInstaller(path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('launch_update_installer', { path });
}

/** 按当前配置探测一次；github 源不走这里（原生 updater 通道自带下载安装） */
export async function probeConfiguredSource(
  config: UpdateSourceConfig,
  currentVersion: string,
): Promise<UpdateProbe> {
  if (!config.location.trim()) throw new Error('请先填写更新源地址');
  return config.kind === 'dir'
    ? probeDirSource(config.location, currentVersion)
    : probeHttpSource(config.location, currentVersion);
}
