import type { AppPermission, RcxAppManifest } from '../manifest';
import type { PermissionGate } from '../permission';

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
    if (this.handlers.has(method)) throw new Error(`能力 ${method} 已注册`);
    this.handlers.set(method, { permission, handler });
    return () => this.handlers.delete(method);
  }

  async call(method: string, params: unknown, context: CapabilityContext): Promise<unknown> {
    const registration = this.handlers.get(method);
    if (!registration) {
      await this.permissions.deny(context.appId, method, '未知能力');
      throw new Error(`未知能力: ${method}`);
    }
    await this.permissions.authorize(context.appId, registration.permission, method);
    return registration.handler(params, context);
  }
}
