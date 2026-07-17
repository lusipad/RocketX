import type {
  BridgeClient,
  BridgeClientOptions,
  BridgeEventListener,
  BridgeMessageEvent,
  BridgeTarget,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RcxEventParams {
  event: string;
  payload?: unknown;
  data?: unknown;
}

export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = 'BridgeRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export class BridgeTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Bridge request "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'BridgeTimeoutError';
  }
}

export class BridgeDestroyedError extends Error {
  constructor() {
    super('Bridge client has been destroyed');
    this.name = 'BridgeDestroyedError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isResponse = (value: unknown): value is JsonRpcResponse =>
  isRecord(value) &&
  value.jsonrpc === '2.0' &&
  (typeof value.id === 'string' || typeof value.id === 'number') &&
  ('result' in value || 'error' in value);

const isRcxEvent = (value: unknown): value is { method: 'rcx/event'; params: RcxEventParams } => {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.method !== 'rcx/event') return false;
  if (!isRecord(value.params)) return false;
  return typeof value.params.event === 'string';
};

const browserDefaults = (): { target: BridgeTarget; source: BridgeClientOptions['source'] } => {
  if (typeof window === 'undefined') {
    throw new Error('Bridge target and source are required outside a browser');
  }
  const bridge = (window as Window & { __RCX_BRIDGE__?: BridgeTarget & NonNullable<BridgeClientOptions['source']> })
    .__RCX_BRIDGE__;
  if (!bridge) throw new Error('RocketX Bridge bootstrap is unavailable');
  return {
    target: bridge,
    source: bridge,
  };
};

let requestSequence = 0;

export const createBridgeClient = (options: BridgeClientOptions = {}): BridgeClient => {
  const defaults = options.target && options.source ? undefined : browserDefaults();
  const target = options.target ?? defaults?.target;
  const source = options.source ?? defaults?.source;
  if (!target || !source) throw new Error('Bridge target and source must be provided together');

  const origin = options.origin ?? '*';
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Bridge timeoutMs must be a positive finite number');
  }

  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<string, Set<BridgeEventListener>>();
  let destroyed = false;

  const receive = (event: BridgeMessageEvent): void => {
    if (origin !== '*' && event.origin !== origin) return;
    if (event.source !== undefined && event.source !== target) return;

    if (isResponse(event.data)) {
      const id = String(event.data.id);
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timeout);
      if (event.data.error) request.reject(new BridgeRpcError(event.data.error));
      else request.resolve(event.data.result);
      return;
    }

    if (isRcxEvent(event.data)) {
      const eventListeners = listeners.get(event.data.params.event);
      if (!eventListeners) return;
      const payload = event.data.params.payload ?? event.data.params.data;
      for (const listener of [...eventListeners]) listener(payload);
    }
  };

  source.addEventListener('message', receive);

  const request = <TResult>(method: string, params: unknown): Promise<TResult> => {
    if (destroyed) return Promise.reject(new BridgeDestroyedError());
    requestSequence += 1;
    const id = `rcx-${Date.now()}-${requestSequence}`;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeTimeoutError(method, timeoutMs));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try {
        target.postMessage(message, origin);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    call: <TResult>(method: string, params?: unknown) =>
      request<TResult>('rcx/call', { method, params }),

    requestUI: <TResult>(kind: string, props?: unknown) =>
      request<TResult>('rcx/requestUI', { kind, props }),

    on<T>(event: string, listener: BridgeEventListener<T>): () => void {
      const eventListeners = listeners.get(event) ?? new Set<BridgeEventListener>();
      eventListeners.add(listener as BridgeEventListener);
      listeners.set(event, eventListeners);
      return () => {
        eventListeners.delete(listener as BridgeEventListener);
        if (eventListeners.size === 0) listeners.delete(event);
      };
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      source.removeEventListener('message', receive);
      listeners.clear();
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new BridgeDestroyedError());
      }
      pending.clear();
    },
  };
};
