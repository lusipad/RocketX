import { ensureHttpOrigin, httpFetch } from './http';

/**
 * 更新源配置（issue #106）：受限网络里 GitHub Releases 不可达，更新检查
 * 支持三种源——GitHub（默认，走 tauri updater 原生通道全自动）、内网
 * HTTP（任意静态服务托管发布产物）、共享目录（SMB/UNC，webview 读不了
 * 网络路径，由 Rust 命令读清单）。pip/nuget 不适配桌面 GUI 应用的安装与
 * 更新语义，内网诉求由后两者覆盖。
 */
export type UpdateSourceKind = 'github' | 'http' | 'dir';
export type UpdateInstallerType = 'nsis' | 'msi';
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
  /** dir 源：可选 Tauri Minisign 签名；HTTP/GitHub 源仍强制验签 */
  signature?: string;
  /** dir 源：探测时计算，安装 helper 再次比对以阻止 TOCTOU 替换 */
  sha256?: string;
  /** dir 源：必须与当前 RocketX 安装类型一致，禁止 NSIS/MSI 静默切换 */
  installerType?: UpdateInstallerType;
  /** http 源：Windows 安装包的下载地址 */
  downloadUrl?: string;
}

export interface UpdateInstallResult {
  status: 'success' | 'error';
  version: string;
  message: string;
}

interface DirUpdateInstallRequest {
  dir: string;
  path: string;
  signature?: string;
  sha256: string;
  expectedVersion: string;
  installerType: UpdateInstallerType;
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
 * 版本号解析：数字三段。容 v 前缀与预发布后缀（截到首个非数字段），段缺省按 0
 * ——共享目录里手工维护的清单不一定写得规整。首段必须是数字，否则整个值不是
 * 版本号，返回 null 交给调用方按「无法判断」处理。
 */
export function parseVersion(value: string): [number, number, number] | null {
  const parts = value.trim().replace(/^v/i, '').split('.').slice(0, 3);
  const first = Number.parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(first)) return null;
  const at = (index: number): number => {
    const part = Number.parseInt(parts[index] ?? '', 10);
    return Number.isFinite(part) ? part : 0;
  };
  return [first, at(1), at(2)];
}

/** 版本比较：无法解析的一侧按 0.0.0 处理，仅供展示与排序使用。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [0, 0, 0];
  const right = parseVersion(b) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 「有没有新版本」的唯一判据（issue #300、#376）：两侧都必须是能解析的版本号，
 * 才允许判定为有更新。空串、undefined、非版本文本一律判定为没有更新——把拿不到
 * 的当前版本当成 0.0.0 会让任何远端版本都「更新」，正是同版本甚至旧版本还提示
 * 升级的成因。
 */
export function isNewerVersion(remote: string | undefined, installed: string | undefined): boolean {
  const next = parseVersion(remote ?? '');
  const current = parseVersion(installed ?? '');
  if (!next || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    const delta = (next[index] ?? 0) - (current[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

export function isNewerNativeUpdate(
  update: Pick<import('@tauri-apps/plugin-updater').Update, 'version' | 'currentVersion'> | null,
  installedVersion?: string,
): boolean {
  if (!update) return false;
  // 已安装版本以运行时为准；updater 通道自报的 currentVersion 只作兜底。
  return isNewerVersion(update.version, installedVersion ?? update.currentVersion);
}

/** 当前真正在跑的版本：桌面端问原生，取不到时退回构建期常量。 */
export async function installedAppVersion(fallback: string): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const version = await getVersion();
    return parseVersion(version) ? version : fallback;
  } catch {
    return fallback;
  }
}

export async function checkGithubUpdate(
  installedVersion?: string,
): Promise<import('@tauri-apps/plugin-updater').Update | null> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 15_000 });
  return isNewerNativeUpdate(update, installedVersion) ? update : null;
}

export async function checkHttpUpdate(
  location: string,
  installedVersion?: string,
): Promise<import('@tauri-apps/plugin-updater').Update | null> {
  const update = await checkSignedHttpSource(location);
  return isNewerNativeUpdate(update, installedVersion) ? update : null;
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
    hasUpdate: isNewerVersion(manifest.version, currentVersion),
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
  const result = await invoke<{
    manifest: string;
    installerPath: string | null;
    signature: string | null;
    sha256: string;
    version: string;
    installerType: UpdateInstallerType | null;
  }>('read_update_manifest_dir', { dir: location.trim() });
  const probe = parseUpdateManifest(result.manifest, currentVersion);
  if (result.version.replace(/^v/i, '') !== probe.version) {
    throw new Error('更新清单版本与已验证安装包不一致');
  }
  if (result.installerPath && (!result.sha256 || !result.installerType)) {
    throw new Error('更新包缺少 SHA-256 或安装类型');
  }
  return {
    ...probe,
    installerPath: result.installerPath ?? undefined,
    signature: result.signature ?? undefined,
    sha256: result.sha256,
    installerType: result.installerType ?? undefined,
  };
}

let dirInstallInFlight: Promise<void> | null = null;

/** Rust 启动 helper 后直接退出主进程；失败时释放 singleflight 以允许重试。 */
export function launchDirInstaller(request: DirUpdateInstallRequest): Promise<void> {
  if (dirInstallInFlight) return dirInstallInFlight;
  dirInstallInFlight = (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('launch_update_installer', { ...request, signature: request.signature ?? null });
  })().catch((error) => {
    dirInstallInFlight = null;
    throw error;
  });
  return dirInstallInFlight;
}

/** helper 的安装结果跨进程保存；读取后由 Rust 原子消费。 */
export async function takeUpdateResult(): Promise<UpdateInstallResult | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UpdateInstallResult | null>('take_update_result');
}

/** HTTP 更新源走 Tauri 原生 updater：运行时端点仍使用内置公钥验签。 */
export async function checkSignedHttpSource(
  location: string,
): Promise<import('@tauri-apps/plugin-updater').Update | null> {
  const endpoint = manifestUrlOf(location);
  const { invoke } = await import('@tauri-apps/api/core');
  const metadata = await invoke<{
    rid: number;
    currentVersion: string;
    version: string;
    date?: string;
    body?: string;
    rawJson: Record<string, unknown>;
  } | null>('check_signed_http_update', { endpoint });
  if (!metadata) return null;
  const { Update } = await import('@tauri-apps/plugin-updater');
  return new Update(metadata);
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
