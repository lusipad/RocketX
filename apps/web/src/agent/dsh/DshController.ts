import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface DshServerRequest {
  type: 'server-request';
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface DshControllerHandlers {
  onMux: (request: DshServerRequest) => void;
  onHost: (request: DshServerRequest) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null) => void;
}

interface DshBridgeInfo {
  processId: string;
  leaseId: string;
  readyUrl?: string;
}

interface DshOutputEvent {
  processId: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

interface DshExitEvent {
  processId: string;
  code: number | null;
}

interface DshRpcError {
  code?: string;
  message?: string;
}

export interface DshControllerRuntime {
  invoke: typeof invoke;
  listen: typeof listen;
}

export type DshControllerMode = 'controller' | 'web';

export interface DshControllerOptions {
  connectionId?: string;
  mode?: DshControllerMode;
}

type DshBridgeFrame =
  | { kind: 'ready'; url: string }
  | { kind: 'response'; id: string; op: 'call' | 'respond'; response: unknown }
  | { kind: 'mux' | 'host'; envelope: DshServerRequest }
  | { kind: 'fatal'; message: string }
  | { kind: 'log' | 'exit'; [key: string]: unknown };

interface PendingRequest {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function serverRequest(value: unknown): DshServerRequest | null {
  const candidate = record(value);
  if (
    candidate?.type !== 'server-request'
    || typeof candidate.rpcId !== 'string'
    || typeof candidate.method !== 'string'
    || !('payload' in candidate)
  ) return null;
  return candidate as unknown as DshServerRequest;
}

function readyUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DSH bridge 返回了无效 ready URL');
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname !== '/'
  ) {
    throw new Error('DSH bridge 返回了无效 ready URL');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DSH bridge 返回了无效 ready URL');
  }
  return parsed.toString();
}

export function parseDshBridgeLine(line: string): DshBridgeFrame {
  const frame = record(JSON.parse(line));
  if (!frame || typeof frame.kind !== 'string') throw new Error('DSH bridge 返回了无效消息');

  if (frame.kind === 'ready' && typeof frame.url === 'string') {
    return { kind: 'ready', url: readyUrl(frame.url) };
  }
  if (
    frame.kind === 'response'
    && typeof frame.id === 'string'
    && (frame.op === 'call' || frame.op === 'respond')
    && 'response' in frame
  ) {
    return { kind: 'response', id: frame.id, op: frame.op, response: frame.response };
  }
  if (frame.kind === 'mux' || frame.kind === 'host') {
    const envelope = serverRequest(frame.envelope);
    if (!envelope) throw new Error(`DSH bridge 返回了无效 ${frame.kind} 事件`);
    return { kind: frame.kind, envelope };
  }
  if (frame.kind === 'fatal' && typeof frame.message === 'string') {
    return { kind: 'fatal', message: frame.message };
  }
  if (frame.kind === 'log' || frame.kind === 'exit') return frame as DshBridgeFrame;
  throw new Error(`DSH bridge 返回了未知消息：${frame.kind}`);
}

function rpcValue(response: unknown): unknown {
  const envelope = record(response);
  const result = record(envelope?.result);
  if (envelope?.type !== 'server-response' || !result || typeof result.ok !== 'boolean') {
    throw new Error('DSH 返回了无效 RPC 响应');
  }
  if (result.ok) return result.value;
  const error = record(result.error) as DshRpcError | null;
  const message = typeof error?.message === 'string' ? error.message : 'DSH 请求失败';
  const code = typeof error?.code === 'string' ? error.code : '';
  throw new Error(code ? `${message}（${code}）` : message);
}

export class DshController {
  private processId: string | null = null;
  private leaseId: string | null = null;
  private requestSequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unlisten: UnlistenFn[] = [];
  private ready: Promise<string> | null = null;
  private settleReady: ((url: string) => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private stopped = false;
  private readonly connectionId: string;
  private readonly mode: DshControllerMode;

  constructor(
    private readonly workspaceRoot: string,
    private readonly handlers: DshControllerHandlers,
    private readonly runtime: DshControllerRuntime = { invoke, listen },
    options: string | DshControllerOptions = {},
  ) {
    const resolved = typeof options === 'string' ? { connectionId: options } : options;
    this.connectionId = resolved.connectionId ?? 'butler';
    this.mode = resolved.mode ?? 'controller';
  }

  async start(): Promise<string> {
    if (this.ready) return this.ready;
    this.stopped = false;
    this.ready = new Promise<string>((resolve, reject) => {
      this.settleReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);

    const timeout = globalThis.setTimeout(() => {
      this.fail(new Error('启动 DSH 超时'));
    }, START_TIMEOUT_MS);

    try {
      const earlyOutput: DshOutputEvent[] = [];
      const earlyExit: DshExitEvent[] = [];
      const [output, exit] = await Promise.all([
        this.runtime.listen<DshOutputEvent>('dsh-bridge-output', (event) => {
          if (this.processId === null) {
            earlyOutput.push(event.payload);
            return;
          }
          if (event.payload.processId !== this.processId || event.payload.stream !== 'stdout') return;
          this.handleLine(event.payload.line);
        }),
        this.runtime.listen<DshExitEvent>('dsh-bridge-exit', (event) => {
          if (this.processId === null) {
            earlyExit.push(event.payload);
            return;
          }
          if (event.payload.processId !== this.processId) return;
          this.handleExit(event.payload.code);
        }),
      ]);
      this.unlisten.push(output, exit);
      const process = await this.runtime.invoke<DshBridgeInfo>('dsh_bridge_start', {
        connectionId: this.connectionId,
        workspaceRoot: this.workspaceRoot,
        ...(this.mode === 'web' ? { mode: this.mode } : {}),
      });
      if (this.stopped) {
        await this.runtime.invoke('dsh_bridge_stop', {
          processId: process.processId,
          leaseId: process.leaseId,
        }).catch(() => undefined);
        throw new Error('DSH 连接已关闭');
      }
      this.processId = process.processId;
      this.leaseId = process.leaseId;
      if (typeof process.readyUrl === 'string') this.resolveReadyUrl(process.readyUrl);
      for (const event of earlyOutput) {
        if (event.processId === process.processId && event.stream === 'stdout') this.handleLine(event.line);
      }
      const matchingExit = earlyExit.find((event) => event.processId === process.processId);
      if (matchingExit) this.handleExit(matchingExit.code);
      return await this.ready;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      const alreadyFailed = this.settleReady === null && this.rejectReady === null;
      if (!alreadyFailed) this.fail(error);
      await this.cleanupAfterStartFailure();
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.mode === 'web') throw new Error('DSH web 模式不支持 call');
    await this.requireReady();
    const response = await this.request('call', { method, payload });
    return rpcValue(response) as T;
  }

  attachmentLeaseId(): string {
    if (!this.leaseId || this.stopped) throw new Error('DSH 连接已关闭');
    return this.leaseId;
  }

  async respond(response: Record<string, unknown>): Promise<void> {
    if (this.mode === 'web') throw new Error('DSH web 模式不支持 respond');
    await this.requireReady();
    const receipt = record(await this.request('respond', { response }));
    if (receipt?.accepted === true) return;
    const reason = typeof receipt?.reason === 'string' ? receipt.reason : 'bad-response';
    throw new Error(reason === 'not-pending' ? '该请求已不再等待处理' : 'DSH 拒绝了响应');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const processId = this.processId;
    const leaseId = this.leaseId;
    this.processId = null;
    this.leaseId = null;
    this.rejectReady?.(new Error('DSH 连接已关闭'));
    this.settleReady = null;
    this.rejectReady = null;
    this.rejectPending(new Error('DSH 连接已关闭'));
    this.clearListeners();
    if (processId && leaseId) {
      try {
        await this.runtime.invoke('dsh_bridge_stop', { processId, leaseId });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (!/未运行|not running/i.test(message)) throw reason;
      }
    }
  }

  private async requireReady(): Promise<string> {
    if (!this.ready) throw new Error('DSH 尚未启动');
    const url = await this.ready;
    if (!this.processId || !this.leaseId || this.stopped) throw new Error('DSH 连接已关闭');
    return url;
  }

  private async request(kind: 'call' | 'respond', fields: Record<string, unknown>): Promise<unknown> {
    const processId = this.processId;
    const leaseId = this.leaseId;
    if (!processId || !leaseId) throw new Error('DSH 连接已关闭');
    const id = `dsh-${this.connectionId}-${leaseId}-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('DSH 请求超时'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    try {
      await this.runtime.invoke('dsh_bridge_write', { processId, message: { id, kind, ...fields } });
    } catch (reason) {
      const pending = this.pending.get(id);
      if (pending) globalThis.clearTimeout(pending.timeout);
      this.pending.delete(id);
      throw reason;
    }
    return response;
  }

  private async cleanupAfterStartFailure(): Promise<void> {
    if (this.stopped) return;
    await this.stop().catch(() => undefined);
  }

  private handleLine(line: string): void {
    try {
      const frame = parseDshBridgeLine(line);
      if (frame.kind === 'ready') {
        this.resolveReadyUrl(frame.url);
      } else if (frame.kind === 'response') {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        globalThis.clearTimeout(pending.timeout);
        pending.resolve(frame.response);
      } else if (frame.kind === 'mux') {
        this.handlers.onMux(frame.envelope);
      } else if (frame.kind === 'host') {
        this.handlers.onHost(frame.envelope);
      } else if (frame.kind === 'fatal') {
        this.fail(new Error(frame.message));
      }
    } catch (reason) {
      this.fail(reason instanceof Error ? reason : new Error(String(reason)));
    }
  }

  private fail(error: Error): void {
    this.rejectReady?.(error);
    this.settleReady = null;
    this.rejectReady = null;
    this.rejectPending(error);
    this.handlers.onError(error);
  }

  private handleExit(code: number | null): void {
    this.processId = null;
    this.leaseId = null;
    this.fail(new Error(`DSH 已退出${code === null ? '' : `（${code}）`}`));
    this.handlers.onExit(code);
  }

  private resolveReadyUrl(url: string): void {
    this.settleReady?.(readyUrl(url));
    this.settleReady = null;
    this.rejectReady = null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearListeners(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }
}
