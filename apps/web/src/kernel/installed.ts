import { useSyncExternalStore } from 'react';
import type { RcxStore } from '@rcx/rcx-store';
import { BASIC_PERMISSIONS, DANGEROUS_PERMISSIONS, SENSITIVE_PERMISSIONS } from './permission';
import { parseManifestJson, type AppPermission, type RcxAppManifest } from './manifest';
import { httpFetch } from '../lib/http';
import { ensureHttpOrigin } from '../lib/http';

export interface InstalledApp {
  manifest: RcxAppManifest;
  granted: AppPermission[];
  enabled: boolean;
  source: { kind: 'directory' | 'url'; location: string };
  entryContent: string;
  bundleHash: string;
  installedAt: number;
}

export interface InstallOptions {
  sensitiveGrants?: AppPermission[];
}

type AppCleanup = () => void | Promise<void>;
type AppActivator = (app: InstalledApp) => void | AppCleanup;

const BASIC = new Set<AppPermission>(BASIC_PERMISSIONS);
const SENSITIVE = new Set<AppPermission>(SENSITIVE_PERMISSIONS);
const DANGEROUS = new Set<AppPermission>(DANGEROUS_PERMISSIONS);

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('entry 不能越出应用目录');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

async function sha256(parts: Array<string | ArrayBuffer>): Promise<string> {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? new TextEncoder().encode(part) : new Uint8Array(part),
  );
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const input = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function grantsFor(manifest: RcxAppManifest, selected: AppPermission[] = []): AppPermission[] {
  const selectedSet = new Set(selected);
  for (const permission of selectedSet) {
    if (!SENSITIVE.has(permission) || !manifest.permissions.includes(permission)) {
      throw new Error(`不能授权未申请的敏感权限: ${permission}`);
    }
  }
  return manifest.permissions.filter(
    (permission) => BASIC.has(permission) || DANGEROUS.has(permission) || selectedSet.has(permission),
  );
}

function validateRuntime(manifest: RcxAppManifest, source: InstalledApp['source']['kind']): void {
  if (manifest.runtime === 'native' || manifest.runtime === 'mcp') {
    throw new Error(`${manifest.runtime} runtime 按蓝图留到 M8`);
  }
  if (manifest.runtime === 'worker' && source !== 'directory') {
    throw new Error('M6 只允许本机显式安装的 worker，远程 worker 已被安全策略拒绝');
  }
  if (manifest.runtime === 'worker') {
    const uiPoints = ['nav.module', 'panel.right', 'message.renderer', 'entity.link'];
    const invalid = uiPoints.find((point) => manifest.contributes?.[point as keyof typeof manifest.contributes]?.length);
    if (invalid) throw new Error(`worker 不能声明 UI 扩展点: ${invalid}`);
  }
}

export class AppManager {
  private apps = new Map<string, InstalledApp>();
  private cleanups = new Map<string, AppCleanup>();
  private listeners = new Set<() => void>();
  private version = 0;
  private loaded = false;
  private activator?: AppActivator;

  constructor(private store: RcxStore) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  isLoaded(): boolean {
    return this.loaded;
  }

  list(): readonly InstalledApp[] {
    return [...this.apps.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  }

  get(appId: string): InstalledApp | undefined {
    return this.apps.get(appId);
  }

  setActivator(activator: AppActivator): void {
    this.activator = activator;
    for (const app of this.apps.values()) this.activate(app);
  }

  async hydrate(): Promise<void> {
    const records = await this.store.apps.list<InstalledApp>();
    for (const { value } of records) {
      this.apps.set(value.manifest.id, value);
      this.activate(value);
    }
    this.loaded = true;
    this.changed();
  }

  async installDirectory(files: File[], options: InstallOptions = {}): Promise<InstalledApp> {
    const manifestFile = files.find((file) => /(^|\/)rcx\.app\.json$/i.test(file.webkitRelativePath || file.name));
    if (!manifestFile) throw new Error('所选目录里没有 rcx.app.json');
    const manifestText = await manifestFile.text();
    const manifest = parseManifestJson(manifestText);
    validateRuntime(manifest, 'directory');
    if (typeof manifest.entry !== 'string' || /^https?:\/\//i.test(manifest.entry)) {
      throw new Error('本地目录应用的 entry 必须是目录内相对路径');
    }
    const manifestPath = normalizePath(manifestFile.webkitRelativePath || manifestFile.name);
    const base = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
    const entryPath = normalizePath(`${base}${manifest.entry}`);
    const entryFile = files.find(
      (file) => normalizePath(file.webkitRelativePath || file.name) === entryPath,
    );
    if (!entryFile) throw new Error(`找不到 entry: ${manifest.entry}`);
    const entryContent = await entryFile.text();
    const sorted = [...files].sort((left, right) =>
      (left.webkitRelativePath || left.name).localeCompare(right.webkitRelativePath || right.name),
    );
    const hashParts: Array<string | ArrayBuffer> = [];
    for (const file of sorted) {
      hashParts.push(normalizePath(file.webkitRelativePath || file.name), await file.arrayBuffer());
    }
    return this.save({
      manifest,
      granted: grantsFor(manifest, options.sensitiveGrants),
      enabled: this.apps.get(manifest.id)?.enabled ?? (manifest.enabledByDefault !== false),
      source: { kind: 'directory', location: manifestPath.slice(0, -'rcx.app.json'.length) || '.' },
      entryContent,
      bundleHash: await sha256(hashParts),
      installedAt: Date.now(),
    });
  }

  async installUrl(
    manifestUrl: string,
    expectedSha256: string,
    options: InstallOptions = {},
  ): Promise<InstalledApp> {
    const url = new URL(manifestUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('安装地址只支持 http/https');
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('URL 安装必须提供 64 位 SHA-256');
    await ensureHttpOrigin(url);
    const manifestResponse = await httpFetch(url);
    if (!manifestResponse.ok) throw new Error(`下载 manifest 失败: HTTP ${manifestResponse.status}`);
    const manifestText = await manifestResponse.text();
    const manifest = parseManifestJson(manifestText);
    validateRuntime(manifest, 'url');
    if (typeof manifest.entry !== 'string') throw new Error('M6 URL 应用必须使用 iframe entry');
    const entryUrl = new URL(manifest.entry, url);
    await ensureHttpOrigin(entryUrl);
    const entryResponse = await httpFetch(entryUrl);
    if (!entryResponse.ok) throw new Error(`下载 entry 失败: HTTP ${entryResponse.status}`);
    const entryContent = await entryResponse.text();
    const bundleHash = await sha256([manifestText, '\n', entryContent]);
    if (bundleHash.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`应用包 SHA-256 不匹配（实际 ${bundleHash}）`);
    }
    return this.save({
      manifest: { ...manifest, entry: entryUrl.href },
      granted: grantsFor(manifest, options.sensitiveGrants),
      enabled: this.apps.get(manifest.id)?.enabled ?? (manifest.enabledByDefault !== false),
      source: { kind: 'url', location: url.href },
      entryContent,
      bundleHash,
      installedAt: Date.now(),
    });
  }

  async setEnabled(appId: string, enabled: boolean): Promise<void> {
    const app = this.apps.get(appId);
    if (!app || app.enabled === enabled) return;
    const next = { ...app, enabled };
    await this.store.apps.set(appId, next);
    this.apps.set(appId, next);
    await this.deactivate(appId);
    this.activate(next);
    this.changed();
  }

  async setSensitiveGrants(appId: string, selected: AppPermission[]): Promise<void> {
    const app = this.apps.get(appId);
    if (!app) return;
    const next = { ...app, granted: grantsFor(app.manifest, selected) };
    await this.store.apps.set(appId, next);
    this.apps.set(appId, next);
    await this.deactivate(appId);
    this.activate(next);
    this.changed();
  }

  async uninstall(appId: string): Promise<void> {
    if (!this.apps.has(appId)) return;
    await this.deactivate(appId);
    this.apps.delete(appId);
    await Promise.all([
      this.store.apps.delete(appId),
      this.store.appData.clearAllForApp(appId),
    ]);
    this.changed();
  }

  private async save(app: InstalledApp): Promise<InstalledApp> {
    const previous = this.apps.get(app.manifest.id);
    await this.deactivate(app.manifest.id);
    try {
      await this.store.apps.set(app.manifest.id, app);
      this.apps.set(app.manifest.id, app);
      this.activate(app);
      this.changed();
      return app;
    } catch (error) {
      if (previous) {
        await this.store.apps.set(previous.manifest.id, previous);
        this.apps.set(previous.manifest.id, previous);
      } else {
        await this.store.apps.delete(app.manifest.id);
        this.apps.delete(app.manifest.id);
      }
      if (previous) this.activate(previous);
      throw error;
    }
  }

  private activate(app: InstalledApp): void {
    if (!app.enabled || !this.activator) return;
    const cleanup = this.activator(app);
    if (cleanup) this.cleanups.set(app.manifest.id, cleanup);
  }

  private async deactivate(appId: string): Promise<void> {
    const cleanup = this.cleanups.get(appId);
    this.cleanups.delete(appId);
    await cleanup?.();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

let activeManager: AppManager | undefined;

export function setActiveAppManager(manager: AppManager): void {
  activeManager = manager;
}

export function appManager(): AppManager {
  if (!activeManager) throw new Error('扩展内核尚未初始化');
  return activeManager;
}

export function useInstalledApps(): readonly InstalledApp[] {
  const manager = appManager();
  useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  return manager.list();
}
