import type { RcxAppManifest } from './manifest';
import type { CapabilityBus } from './capabilities/bus';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface FrameRegistration {
  appId: string;
  manifest: RcxAppManifest;
  send: (message: unknown) => void;
  close?: () => void;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<JsonRpcRequest>;
  return request.jsonrpc === '2.0' && typeof request.method === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exceedsMessageLimit(value: unknown): boolean {
  try {
    return JSON.stringify(value).length > 1024 * 1024;
  } catch {
    return true;
  }
}

export class BridgeHost {
  private appFrames = new Map<string, Set<FrameRegistration>>();
  private pendingEvents = new Map<string, unknown[]>();

  constructor(private capabilities: CapabilityBus) {}

  start(): void {}

  stop(): void {
    for (const frames of this.appFrames.values()) {
      for (const frame of frames) frame.close?.();
    }
    this.appFrames.clear();
    this.pendingEvents.clear();
  }

  registerFrame(appId: string, manifest: RcxAppManifest, source: Window): () => void {
    const channel = new MessageChannel();
    const registration: FrameRegistration = {
      appId,
      manifest,
      send: (message) => channel.port1.postMessage(message),
      close: () => channel.port1.close(),
    };
    const frames = this.appFrames.get(appId) ?? new Set<FrameRegistration>();
    frames.add(registration);
    this.appFrames.set(appId, frames);
    channel.port1.addEventListener('message', (event) => {
      if (!isRequest(event.data) || exceedsMessageLimit(event.data)) return;
      void this.handle(registration, event.data);
    });
    channel.port1.start();
    source.postMessage({ jsonrpc: '2.0', method: 'rcx/connect' }, '*', [channel.port2]);
    for (const event of this.pendingEvents.get(appId) ?? []) registration.send(event);
    this.pendingEvents.delete(appId);
    return () => {
      registration.close?.();
      frames.delete(registration);
      if (frames.size === 0) this.appFrames.delete(appId);
    };
  }

  registerWorker(appId: string, manifest: RcxAppManifest, worker: Worker): () => void {
    const registration: FrameRegistration = { appId, manifest, send: (message) => worker.postMessage(message) };
    const frames = this.appFrames.get(appId) ?? new Set<FrameRegistration>();
    frames.add(registration);
    this.appFrames.set(appId, frames);
    const listener = (event: MessageEvent) => {
      if (!isRequest(event.data) || exceedsMessageLimit(event.data)) return;
      void this.handle(registration, event.data);
    };
    worker.addEventListener('message', listener);
    return () => {
      worker.removeEventListener('message', listener);
      frames.delete(registration);
      if (frames.size === 0) this.appFrames.delete(appId);
    };
  }

  emit(appId: string, event: string, payload?: unknown): void {
    const message = { jsonrpc: '2.0', method: 'rcx/event', params: { event, payload } };
    const frames = this.appFrames.get(appId);
    if (!frames?.size) {
      const pending = this.pendingEvents.get(appId) ?? [];
      pending.push(message);
      this.pendingEvents.set(appId, pending.slice(-20));
      return;
    }
    for (const frame of frames) frame.send(message);
  }

  emitAll(event: string, payload?: unknown): void {
    for (const appId of this.appFrames.keys()) this.emit(appId, event, payload);
  }

  clearApp(appId: string): void {
    for (const frame of this.appFrames.get(appId) ?? []) frame.close?.();
    this.appFrames.delete(appId);
    this.pendingEvents.delete(appId);
  }

  private async handle(registration: FrameRegistration, request: JsonRpcRequest): Promise<void> {
    if (request.id === undefined) return;
    try {
      let result: unknown;
      if (request.method === 'rcx/call') {
        const params = request.params as { method?: unknown; params?: unknown } | undefined;
        if (typeof params?.method !== 'string') throw new Error('rcx/call 缺少 method');
        result = await this.capabilities.call(params.method, params.params, registration);
      } else if (request.method === 'rcx/requestUI') {
        const params = request.params as { kind?: unknown; props?: unknown } | undefined;
        if (typeof params?.kind !== 'string') throw new Error('rcx/requestUI 缺少 kind');
        result = await this.capabilities.call(
          'ui.notify',
          { kind: params.kind, props: params.props },
          registration,
        );
      } else {
        throw new Error(`未知 Bridge 方法: ${request.method}`);
      }
      registration.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      registration.send(
        {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: errorMessage(error) },
        },
      );
    }
  }
}
