import { EXTENSION_POINTS, type ExtensionPoint } from './types';

export const APP_PERMISSIONS = [
  'chat:read',
  'rooms:list',
  'users:read',
  'storage:local',
  'ui:notify',
  'chat:write',
  'chat:history',
  'files:read',
  'files:write',
  'net:fetch',
  'ai:invoke',
  'lan:discover',
  'lan:transfer',
  'agent:spawn',
  'process:spawn',
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];
export type AppRuntime = 'iframe' | 'worker' | 'native' | 'mcp';

export interface ManifestContribution {
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  desc?: string;
  params?: string;
  icon?: string;
  pattern?: string;
  prefix?: string;
  [key: string]: unknown;
}

export interface RcxAppManifest {
  id: string;
  version: string;
  name: string;
  icon?: string;
  publisher: string;
  runtime: AppRuntime;
  entry: string | { command: string; args?: string[]; env?: Record<string, string> };
  permissions: AppPermission[];
  netAllow?: string[];
  contributes?: Partial<Record<ExtensionPoint, ManifestContribution[]>>;
}

const APP_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EXTENSION_POINT_SET = new Set<string>(EXTENSION_POINTS);
const PERMISSION_SET = new Set<string>(APP_PERMISSIONS);

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

function isRemoteEntry(entry: RcxAppManifest['entry']): boolean {
  return typeof entry === 'string' && /^https?:\/\//i.test(entry);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`netAllow 只支持 http/https: ${value}`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`netAllow 必须是纯 origin: ${value}`);
  }
  return url.origin;
}

export function parseManifest(value: unknown): RcxAppManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest 必须是对象');
  const raw = value as Record<string, unknown>;
  const id = requireString(raw.id, 'id').toLowerCase();
  if (!APP_ID_RE.test(id)) throw new Error('id 必须使用反域名格式，例如 com.example.app');
  const version = requireString(raw.version, 'version');
  if (!VERSION_RE.test(version)) throw new Error('version 必须是 SemVer');
  const runtime = requireString(raw.runtime, 'runtime') as AppRuntime;
  if (!['iframe', 'worker', 'native', 'mcp'].includes(runtime)) throw new Error(`不支持 runtime: ${runtime}`);

  const entry = raw.entry;
  if (typeof entry !== 'string' && (!entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('entry 必须是 URL/相对路径或进程声明');
  }
  if ((runtime === 'iframe' || runtime === 'worker') && typeof entry !== 'string') {
    throw new Error(`${runtime} runtime 的 entry 必须是字符串`);
  }
  if ((runtime === 'native' || runtime === 'mcp') && typeof entry === 'string') {
    throw new Error(`${runtime} runtime 的 entry 必须声明 command`);
  }

  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.map((permission) => requireString(permission, 'permissions[]') as AppPermission)
    : [];
  for (const permission of permissions) {
    if (!PERMISSION_SET.has(permission)) throw new Error(`未知权限: ${permission}`);
  }
  if (new Set(permissions).size !== permissions.length) throw new Error('permissions 不能重复');

  const netAllow = Array.isArray(raw.netAllow)
    ? raw.netAllow.map((origin) => normalizeOrigin(requireString(origin, 'netAllow[]')))
    : undefined;
  if (permissions.includes('net:fetch') && !netAllow?.length) {
    throw new Error('申请 net:fetch 时必须声明 netAllow');
  }
  if (
    isRemoteEntry(entry as RcxAppManifest['entry']) &&
    permissions.some((permission) => permission === 'process:spawn' || permission === 'agent:spawn')
  ) {
    throw new Error('远程应用不能申请 agent:spawn 或 process:spawn');
  }

  let contributes: RcxAppManifest['contributes'];
  if (raw.contributes !== undefined) {
    if (!raw.contributes || typeof raw.contributes !== 'object' || Array.isArray(raw.contributes)) {
      throw new Error('contributes 必须是对象');
    }
    contributes = {};
    for (const [point, items] of Object.entries(raw.contributes)) {
      if (!EXTENSION_POINT_SET.has(point)) throw new Error(`未知扩展点: ${point}`);
      if (!Array.isArray(items)) throw new Error(`${point} 必须是数组`);
      contributes[point as ExtensionPoint] = items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`${point}[${index}] 必须是对象`);
        }
        return { ...(item as ManifestContribution) };
      });
    }
  }

  return {
    id,
    version,
    name: requireString(raw.name, 'name'),
    publisher: requireString(raw.publisher, 'publisher'),
    runtime,
    entry: typeof entry === 'string'
      ? requireString(entry, 'entry')
      : {
          command: requireString((entry as Record<string, unknown>).command, 'entry.command'),
          ...((entry as Record<string, unknown>).args !== undefined
            ? { args: (entry as { args: unknown }).args as string[] }
            : {}),
          ...((entry as Record<string, unknown>).env !== undefined
            ? { env: (entry as { env: unknown }).env as Record<string, string> }
            : {}),
        },
    permissions,
    ...(typeof raw.icon === 'string' ? { icon: raw.icon } : {}),
    ...(netAllow ? { netAllow } : {}),
    ...(contributes ? { contributes } : {}),
  };
}

export function parseManifestJson(json: string): RcxAppManifest {
  try {
    return parseManifest(JSON.parse(json));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`rcx.app.json 不是合法 JSON: ${error.message}`);
    throw error;
  }
}

export function isRemoteManifest(manifest: RcxAppManifest): boolean {
  return isRemoteEntry(manifest.entry);
}
