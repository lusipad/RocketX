import type {
  AcpClientCapabilities,
  AcpHostCapabilityHandlers,
  AcpImplementationInfo,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpRequestPermissionParams,
  AcpSessionCancelParams,
  AcpSessionLoadParams,
  AcpSessionLoadResult,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionSetModeParams,
  AcpSessionSetModeResult,
  AcpSessionUpdateNotificationParams,
  AcpTransport,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './acpTypes';

export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

export interface JsonRpcAcpClientOptions {
  clientInfo?: AcpImplementationInfo;
  capabilities?: AcpClientCapabilities;
  hostHandlers?: AcpHostCapabilityHandlers;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  onSessionUpdate?: (params: AcpSessionUpdateNotificationParams) => void;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (code: number | null, reason?: string) => void;
  onProtocolError?: (error: Error, rawLine?: string) => void;
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof globalThis.setTimeout>;
}

const DEFAULT_CLIENT_INFO: AcpImplementationInfo = {
  name: 'rocketx',
  title: 'RocketX',
  version: '0.44.18',
};

const DEFAULT_CAPABILITIES: AcpClientCapabilities = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class JsonRpcAcpClient {
  private nextId = 1;
  private started = false;
  private closed = false;
  private lineBuffer = '';
  private pending = new Map<string, PendingRpc>();
  private unsubscribers: Array<() => void> = [];
  private hostHandlers: AcpHostCapabilityHandlers;
  private initializeResult: AcpInitializeResult | null = null;

  constructor(
    private readonly transport: AcpTransport,
    private readonly options: JsonRpcAcpClientOptions = {},
  ) {
    this.hostHandlers = { ...(options.hostHandlers ?? {}) };
  }

  get serverCapabilities(): AcpInitializeResult | null {
    return this.initializeResult;
  }

  get isConnected(): boolean {
    return this.started && !this.closed;
  }

  setHostHandlers(handlers: Partial<AcpHostCapabilityHandlers>): void {
    this.hostHandlers = { ...this.hostHandlers, ...handlers };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.closed = false;
    this.unsubscribers.push(
      this.transport.onLine((line) => this.handleIncomingChunk(line)),
      this.transport.onExit((code, reason) => this.handleTransportExit(code, reason)),
    );
    try {
      await this.transport.start();
      this.started = true;
    } catch (error) {
      this.clearListeners();
      throw error;
    }
  }

  async initialize(params?: Partial<AcpInitializeParams>): Promise<AcpInitializeResult> {
    if (!this.started) {
      await this.start();
    }
    const payload: AcpInitializeParams = {
      protocolVersion: 1,
      clientCapabilities: params?.clientCapabilities ?? this.options.capabilities ?? DEFAULT_CAPABILITIES,
      clientInfo: params?.clientInfo ?? this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
    };
    const result = await this.request<AcpInitializeResult>('initialize', payload);
    this.initializeResult = result;
    return result;
  }

  async sessionNew(params: AcpSessionNewParams): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>('session/new', params);
  }

  async sessionLoad(params: AcpSessionLoadParams): Promise<AcpSessionLoadResult> {
    return this.request<AcpSessionLoadResult>('session/load', params);
  }

  async sessionPrompt(params: AcpSessionPromptParams): Promise<AcpSessionPromptResult> {
    return this.request<AcpSessionPromptResult>(
      'session/prompt',
      params,
      this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    );
  }

  async sessionSetMode(params: AcpSessionSetModeParams): Promise<AcpSessionSetModeResult> {
    return this.request<AcpSessionSetModeResult>('session/set_mode', params);
  }

  async sessionCancel(params: AcpSessionCancelParams): Promise<void> {
    await this.notify('session/cancel', params);
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TResult> {
    if (this.closed) {
      throw new Error(`ACP 客户端已关闭，无法发送请求 ${method}`);
    }
    if (!this.started) {
      throw new Error(`ACP 客户端尚未启动，无法发送请求 ${method}`);
    }
    const id = this.nextId++;
    const key = String(id);
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<TResult>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? globalThis.setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`ACP 请求超时 (${timeoutMs}ms): ${method}`));
            }, timeoutMs)
          : undefined;

      this.pending.set(key, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.transport.sendLine(JSON.stringify(payload)).catch((error) => {
        const entry = this.pending.get(key);
        if (!entry) return;
        this.pending.delete(key);
        if (entry.timer) globalThis.clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed || !this.started) {
      return;
    }
    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.transport.sendLine(JSON.stringify(payload));
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.rejectAllPending(new Error('ACP 会话已停止'));
    this.clearListeners();
    await this.transport.stop().catch(() => undefined);
  }

  private handleIncomingChunk(chunk: string): void {
    // Some transports deliver complete lines without trailing newline; handle both chunked & line-delimited inputs.
    const combined = this.lineBuffer ? `${this.lineBuffer}${chunk}` : chunk;
    if (!chunk.includes('\n') && !this.lineBuffer) {
      this.processLine(chunk);
      return;
    }
    const parts = combined.split(/\r?\n/);
    this.lineBuffer = parts.pop() ?? '';
    for (const line of parts) {
      this.processLine(line);
    }
  }

  private processLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.options.onProtocolError?.(
        error instanceof Error ? error : new Error(String(error)),
        trimmed,
      );
      return;
    }

    if (!isPlainObject(parsed)) return;

    const hasMethod = typeof parsed.method === 'string';
    const hasId = parsed.id !== undefined && parsed.id !== null;

    // 1. Response to an outgoing request
    if (!hasMethod && hasId) {
      this.handleResponse(parsed as unknown as JsonRpcResponse);
      return;
    }

    // 2. Incoming request from ACP agent (requires response)
    if (hasMethod && hasId) {
      void this.handleIncomingRequest(parsed as unknown as JsonRpcRequest);
      return;
    }

    // 3. Incoming notification
    if (hasMethod && !hasId) {
      this.handleNotification(parsed.method as string, parsed.params);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const key = String(msg.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (pending.timer) globalThis.clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(
        new AcpRpcError(msg.error.code, msg.error.message, msg.error.data),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'session/update' && isPlainObject(params)) {
      this.options.onSessionUpdate?.(
        params as unknown as AcpSessionUpdateNotificationParams,
      );
    }
    this.options.onNotification?.(method, params);
  }

  private async handleIncomingRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatchIncomingRequest(req.method, req.params);
      await this.sendResponse(req.id, result);
    } catch (error) {
      const rpcError: JsonRpcError =
        error instanceof AcpRpcError
          ? { code: error.code, message: error.message, data: error.data }
          : {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            };
      try {
        await this.sendErrorResponse(req.id, rpcError);
      } catch (transportError) {
        this.handleTransportExit(null, transportError instanceof Error ? transportError.message : String(transportError));
      }
    }
  }

  private async dispatchIncomingRequest(method: string, params: unknown): Promise<unknown> {
    const payload = isPlainObject(params) ? params : {};
    switch (method) {
      case 'session/request_permission': {
        if (!this.hostHandlers.requestPermission) {
          throw new AcpRpcError(-32601, 'Host permission handler is not registered');
        }
        return this.hostHandlers.requestPermission(
          payload as unknown as AcpRequestPermissionParams,
        );
      }
      case 'fs/read_text_file': {
        if (!this.hostHandlers.readTextFile) {
          throw new AcpRpcError(-32601, 'Host fs/read_text_file capability is not enabled');
        }
        return this.hostHandlers.readTextFile(payload as never);
      }
      case 'fs/write_text_file': {
        if (!this.hostHandlers.writeTextFile) {
          throw new AcpRpcError(-32601, 'Host fs/write_text_file capability is not enabled');
        }
        return (await this.hostHandlers.writeTextFile(payload as never)) ?? {};
      }
      case 'terminal/create': {
        if (!this.hostHandlers.terminalCreate) {
          throw new AcpRpcError(-32601, 'Host terminal/create capability is not enabled');
        }
        return this.hostHandlers.terminalCreate(payload as never);
      }
      case 'terminal/output': {
        if (!this.hostHandlers.terminalOutput) {
          throw new AcpRpcError(-32601, 'Host terminal/output capability is not enabled');
        }
        return this.hostHandlers.terminalOutput(payload as never);
      }
      case 'terminal/wait_for_exit': {
        if (!this.hostHandlers.terminalWaitForExit) {
          throw new AcpRpcError(-32601, 'Host terminal/wait_for_exit capability is not enabled');
        }
        return this.hostHandlers.terminalWaitForExit(payload as never);
      }
      case 'terminal/kill': {
        if (!this.hostHandlers.terminalKill) {
          throw new AcpRpcError(-32601, 'Host terminal/kill capability is not enabled');
        }
        return (await this.hostHandlers.terminalKill(payload as never)) ?? {};
      }
      case 'terminal/release': {
        if (!this.hostHandlers.terminalRelease) {
          throw new AcpRpcError(-32601, 'Host terminal/release capability is not enabled');
        }
        return (await this.hostHandlers.terminalRelease(payload as never)) ?? {};
      }
      default:
        throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`);
    }
  }

  private async sendResponse(id: number | string, result: unknown): Promise<void> {
    if (this.closed || !this.started) return;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result: result ?? {},
    };
    await this.transport.sendLine(JSON.stringify(response));
  }

  private async sendErrorResponse(id: number | string, error: JsonRpcError): Promise<void> {
    if (this.closed || !this.started) return;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error,
    };
    await this.transport.sendLine(JSON.stringify(response));
  }

  private handleTransportExit(code: number | null, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.clearListeners();
    const detail = reason || `ACP 进程已退出（退出码 ${code ?? '未知'}）`;
    this.rejectAllPending(new Error(detail));
    this.options.onExit?.(code, reason);
  }

  private rejectAllPending(error: Error): void {
    for (const [key, entry] of this.pending.entries()) {
      this.pending.delete(key);
      if (entry.timer) globalThis.clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private clearListeners(): void {
    for (const unlisten of this.unsubscribers.splice(0)) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    }
  }
}
