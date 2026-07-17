export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface BridgeMessageEvent {
  data: unknown;
  origin?: string;
  source?: unknown;
}

export interface BridgeEventSource {
  addEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
}

export interface BridgeTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export type BridgeEventListener<T = unknown> = (payload: T) => void;

export interface BridgeClientOptions {
  target?: BridgeTarget;
  source?: BridgeEventSource;
  origin?: string;
  timeoutMs?: number;
}

export interface BridgeClient {
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  requestUI<TResult = unknown>(kind: string, props?: unknown): Promise<TResult>;
  on<T = unknown>(event: string, listener: BridgeEventListener<T>): () => void;
  destroy(): void;
}
