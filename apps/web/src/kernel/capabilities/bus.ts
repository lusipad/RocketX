import type { AppPermission, RcxAppManifest } from '../manifest';
import type { PermissionGate } from '../permission';
import { t } from '../../i18n';

export interface CapabilityContext {
  appId: string;
  manifest: RcxAppManifest;
}

export type CapabilityHandler = (params: unknown, context: CapabilityContext) => unknown | Promise<unknown>;

interface CapabilityRegistration {
  permission: AppPermission;
  handler: CapabilityHandler;
}

export class CapabilityBus {
  private handlers = new Map<string, CapabilityRegistration>();

  constructor(private permissions: PermissionGate) {}

  register(method: string, permission: AppPermission, handler: CapabilityHandler): () => void {
    if (this.handlers.has(method)) throw new Error(t('settings.kernel.bus.alreadyRegistered', { method }));
    this.handlers.set(method, { permission, handler });
    return () => this.handlers.delete(method);
  }

  clear(): void {
    this.handlers.clear();
  }

  async call(method: string, params: unknown, context: CapabilityContext): Promise<unknown> {
    const registration = this.handlers.get(method);
    if (!registration) {
      await this.permissions.deny(context.appId, method, t('settings.kernel.bus.unknownCapabilityReason'));
      throw new Error(t('settings.kernel.bus.unknownCapability', { method }));
    }
    await this.permissions.authorize(context.appId, registration.permission, method);
    return registration.handler(params, context);
  }
}
