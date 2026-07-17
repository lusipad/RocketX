import type { AppPermission } from './manifest';

export const BASIC_PERMISSIONS: readonly AppPermission[] = [
  'chat:read',
  'rooms:list',
  'users:read',
  'storage:local',
  'ui:notify',
];

export const SENSITIVE_PERMISSIONS: readonly AppPermission[] = [
  'chat:write',
  'chat:history',
  'files:read',
  'files:write',
  'net:fetch',
  'ai:invoke',
  'lan:discover',
  'lan:transfer',
];

export const DANGEROUS_PERMISSIONS: readonly AppPermission[] = ['agent:spawn', 'process:spawn'];

export interface PermissionGrant {
  appId: string;
  granted: AppPermission[];
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  appId: string;
  action: string;
  allowed: boolean;
  reason?: string;
  [key: string]: unknown;
}

export type AuditWriter = (entry: AuditEntry) => void | Promise<void>;
export type DangerousApproval = (request: {
  appId: string;
  permission: AppPermission;
  action: string;
}) => Promise<'once' | 'session' | 'deny'>;

const DANGEROUS = new Set<AppPermission>(DANGEROUS_PERMISSIONS);

export class PermissionGate {
  private grants = new Map<string, Set<AppPermission>>();
  private sessionDangerous = new Map<string, Set<AppPermission>>();

  constructor(
    private writeAudit: AuditWriter = () => {},
    private approveDangerous?: DangerousApproval,
  ) {}

  setGrant(grant: PermissionGrant): void {
    this.grants.set(grant.appId, new Set(grant.granted));
  }

  revokeApp(appId: string): void {
    this.grants.delete(appId);
    this.sessionDangerous.delete(appId);
  }

  async authorize(appId: string, permission: AppPermission, action: string): Promise<void> {
    const granted = this.grants.get(appId)?.has(permission) === true;
    if (!granted) {
      await this.audit(appId, action, false, `缺少权限 ${permission}`);
      throw new Error(`应用 ${appId} 未获得 ${permission}`);
    }

    if (DANGEROUS.has(permission) && !this.sessionDangerous.get(appId)?.has(permission)) {
      const decision = (await this.approveDangerous?.({ appId, permission, action })) ?? 'deny';
      if (decision === 'deny') {
        await this.audit(appId, action, false, `用户拒绝 ${permission}`);
        throw new Error(`用户拒绝 ${permission}`);
      }
      if (decision === 'session') {
        const permissions = this.sessionDangerous.get(appId) ?? new Set<AppPermission>();
        permissions.add(permission);
        this.sessionDangerous.set(appId, permissions);
      }
    }
    await this.audit(appId, action, true);
  }

  async deny(appId: string, action: string, reason: string): Promise<void> {
    await this.audit(appId, action, false, reason);
  }

  private async audit(appId: string, action: string, allowed: boolean, reason?: string): Promise<void> {
    await this.writeAudit({
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      appId,
      action,
      allowed,
      ...(reason ? { reason } : {}),
    });
  }
}
