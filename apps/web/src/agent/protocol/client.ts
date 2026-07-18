import type { InitializeParams } from './generated/InitializeParams';
import type { InitializeResponse } from './generated/InitializeResponse';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { TurnInterruptParams } from './generated/v2/TurnInterruptParams';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse';
import type { TurnStartParams } from './generated/v2/TurnStartParams';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse';
import { assertCodexHandshake } from './compatibility';
import { serverRequestPolicy } from './serverRequests';

export interface CodexProcessInfo {
  processId: string;
  version: string;
}

export interface CodexTransportHandlers {
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
}

export interface CodexTransport {
  start: (handlers: CodexTransportHandlers) => Promise<CodexProcessInfo>;
  write: (message: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
}

interface ClientMethods {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export interface ServerRequestContext {
  method: string;
  params: unknown;
  policy: ReturnType<typeof serverRequestPolicy>;
}

export interface AppServerClientOptions {
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: ServerRequestContext) => Promise<unknown>;
  onInterrupted?: (error: Error) => void;
}

interface PendingRequest {
  method: keyof ClientMethods;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertClientResponse(method: keyof ClientMethods, value: unknown): void {
  const response = isRecord(value) ? value : null;
  if (!response) throw new Error(`Codex app-server ${method} 返回了非对象响应。`);
  if (method === 'initialize') {
    if (typeof response.userAgent !== 'string') {
      throw new Error('Codex app-server initialize 响应缺少 userAgent。');
    }
    return;
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    if (!isRecord(response.thread) || typeof response.thread.id !== 'string') {
      throw new Error(`Codex app-server ${method} 响应缺少 thread.id。`);
    }
    return;
  }
  if (method === 'turn/start' && (!isRecord(response.turn) || typeof response.turn.id !== 'string')) {
    throw new Error('Codex app-server turn/start 响应缺少 turn.id。');
  }
}

export class AppServerClient {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private started = false;

  constructor(
    private readonly transport: CodexTransport,
    private readonly options: AppServerClientOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    const process = await this.transport.start({
      onLine: (line) => this.receiveLine(line),
      onExit: (code) => this.interrupt(new Error(`Codex app-server 已退出${code === null ? '' : `（${code}）`}`)),
    });
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'rocketx', title: 'RocketX', version: '0.21.1' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: null,
        },
      });
      assertCodexHandshake(initialized.userAgent, process.version);
      await this.transport.write({ method: 'initialized' });
      this.started = true;
    } catch (error) {
      await this.transport.stop().catch(() => undefined);
      throw error;
    }
  }

  request<M extends keyof ClientMethods>(
    method: M,
    params: ClientMethods[M]['params'],
    timeoutMs = 15_000,
  ): Promise<ClientMethods[M]['result']> {
    const id = this.nextId++;
    return new Promise<ClientMethods[M]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          try {
            assertClientResponse(method, value);
            resolve(value as ClientMethods[M]['result']);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
        timer,
      });
      void this.transport.write({ id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.rejectPending(new Error('Codex app-server 已停止'));
    await this.transport.stop();
  }

  private receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.interrupt(new Error('Codex app-server 返回了无效 JSON'));
      return;
    }
    if (!isRecord(message)) {
      this.interrupt(new Error('Codex app-server 返回了非对象消息'));
      return;
    }
    if ('id' in message && !('method' in message)) {
      this.receiveResponse(message as unknown as RpcResponse);
      return;
    }
    const method = typeof message.method === 'string' ? message.method : null;
    if (!method) {
      this.interrupt(new Error('Codex app-server 返回了缺少 method 的消息'));
      return;
    }
    if ('id' in message) {
      void this.receiveServerRequest(message.id as number | string, method, message.params).catch((error: unknown) => {
        this.interrupt(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    this.options.onNotification?.(method, message.params);
  }

  private receiveResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      if (response.error.code === -32601) {
        pending.reject(new Error(`Codex app-server 不支持 RocketX 所需方法：${pending.method}。`));
        return;
      }
      pending.reject(
        new Error(
          `Codex app-server 请求失败${response.error.code === undefined ? '' : ` ${response.error.code}`}：${response.error.message ?? '未知错误'}`,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private async receiveServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const policy = serverRequestPolicy(method);
    if (policy === 'unknown') {
      await this.transport.write({ id, error: { code: -32601, message: `Unsupported request: ${method}` } });
      return;
    }
    if (policy === 'local-safe' && method === 'currentTime/read') {
      await this.transport.write({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (!this.options.onServerRequest) {
      await this.transport.write({ id, error: { code: -32001, message: `Request denied by RocketX: ${method}` } });
      return;
    }
    try {
      const result = await this.options.onServerRequest({ method, params, policy });
      await this.transport.write({ id, result });
    } catch (error) {
      await this.transport.write({
        id,
        error: {
          code: -32001,
          message: error instanceof Error ? error.message : 'Request denied by RocketX',
        },
      });
    }
  }

  private interrupt(error: Error): void {
    this.started = false;
    this.rejectPending(error);
    this.options.onInterrupted?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
