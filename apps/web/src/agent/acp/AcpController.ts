import {
  acpFsReadTextFile,
  acpFsWriteTextFile,
  acpProcessStart,
  acpProcessStop,
  acpProcessWrite,
  acpTerminalCreate,
  acpTerminalKill,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
  type AcpProcessInfo,
  type NativeResumeAuthorization,
} from '../../platform/desktopCommands';
import { listenDesktopEvent } from '../../platform/desktopEvents';
import { JsonRpcAcpClient, type JsonRpcAcpClientOptions } from './acpClient';
import type {
  AcpContentBlock,
  AcpHostCapabilityHandlers,
  AcpInitializeResult,
  AcpMcpServerConfig,
  AcpSessionLoadResult,
  AcpSessionNewResult,
  AcpSessionPromptResult,
  AcpSessionSetModeResult,
  AcpSessionUpdateNotificationParams,
  AcpTransport,
  AcpTransportExitHandler,
  AcpTransportLineHandler,
} from './acpTypes';

interface AcpAgentOutputEvent {
  processId: string;
  agentId: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

interface AcpAgentExitEvent {
  processId: string;
  agentId: string;
  code: number | null;
  reason?: string;
}

/**
 * Tauri desktop transport backed by `desktopCommands.ts` and `desktopEvents.ts`.
 */
export class TauriAcpTransport implements AcpTransport {
  private processId: string | null = null;
  private processInfo: AcpProcessInfo | null = null;
  private lineHandlers = new Set<AcpTransportLineHandler>();
  private exitHandlers = new Set<AcpTransportExitHandler>();
  private unlisteners: Array<() => void> = [];
  private pendingOutput: AcpAgentOutputEvent[] = [];
  private pendingExit: AcpAgentExitEvent[] = [];

  constructor(
    private readonly agentId: string,
    private readonly workspaceRoot: string,
    private readonly onStderr?: (line: string) => void,
    private readonly nativeResume?: NativeResumeAuthorization,
  ) {}

  get info(): AcpProcessInfo | null {
    return this.processInfo;
  }

  async start(): Promise<void> {
    if (this.processId) return;

    const unlistenOutput = await listenDesktopEvent<AcpAgentOutputEvent>(
      'acp-agent-output',
      (event) => {
        const payload = event.payload;
        if (!this.processId) {
          this.pendingOutput.push(payload);
          return;
        }
        if (payload.processId !== this.processId) return;
        this.emitOutput(payload);
      },
    );

    const unlistenExit = await listenDesktopEvent<AcpAgentExitEvent>(
      'acp-agent-exit',
      (event) => {
        const payload = event.payload;
        if (!this.processId) {
          this.pendingExit.push(payload);
          return;
        }
        if (payload.processId !== this.processId) return;
        this.emitExit(payload);
      },
    );

    this.unlisteners.push(unlistenOutput, unlistenExit);

    try {
      const info = await acpProcessStart(this.agentId, this.workspaceRoot, this.nativeResume);
      this.processId = info.processId;
      this.processInfo = info;

      for (const queued of this.pendingOutput.splice(0)) {
        if (queued.processId === info.processId) {
          this.emitOutput(queued);
        }
      }
      for (const queued of this.pendingExit.splice(0)) {
        if (queued.processId === info.processId) {
          this.emitExit(queued);
        }
      }
    } catch (error) {
      this.clearListeners();
      this.pendingOutput = [];
      this.pendingExit = [];
      throw error;
    }
  }

  async sendLine(line: string): Promise<void> {
    if (!this.processId) {
      throw new Error('ACP 托管进程尚未启动或已退出');
    }
    await acpProcessWrite(this.processId, line);
  }

  async stop(): Promise<void> {
    const processId = this.processId;
    this.processId = null;
    this.processInfo = null;
    this.pendingOutput = [];
    this.pendingExit = [];
    this.clearListeners();
    if (processId) {
      await acpProcessStop(processId);
    }
  }

  onLine(handler: AcpTransportLineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => {
      this.lineHandlers.delete(handler);
    };
  }

  onExit(handler: AcpTransportExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  private emitOutput(payload: AcpAgentOutputEvent): void {
    if (payload.stream === 'stderr') {
      this.onStderr?.(payload.line);
      return;
    }
    for (const handler of this.lineHandlers) {
      handler(payload.line);
    }
  }

  private emitExit(event: AcpAgentExitEvent): void {
    const { code, reason: exitReason } = event;
    const reason = exitReason
      ? `ACP 进程已退出（退出码 ${code ?? '未知'}）：${exitReason}`
      : `ACP 进程已退出（退出码 ${code ?? '未知'}）`;
    for (const handler of this.exitHandlers) {
      handler(code, reason);
    }
  }

  private clearListeners(): void {
    for (const unlisten of this.unlisteners.splice(0)) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    }
  }
}

export function createDesktopAcpHostHandlers(
  workspaceRoot: string,
  overrides: Partial<AcpHostCapabilityHandlers> = {},
): AcpHostCapabilityHandlers {
  return {
    readTextFile: async (params) => {
      const content = await acpFsReadTextFile(
        workspaceRoot,
        params.path,
        params.line ?? null,
        params.limit ?? null,
      );
      return { content };
    },
    writeTextFile: async (params) => {
      await acpFsWriteTextFile(workspaceRoot, params.path, params.content);
      return {};
    },
    terminalCreate: async (params) => {
      const envMap: Record<string, string> = {};
      if (Array.isArray(params.env)) {
        for (const item of params.env) {
          if (item && typeof item.name === 'string') {
            envMap[item.name] = String(item.value ?? '');
          }
        }
      }
      const terminalId = await acpTerminalCreate({
        workspaceRoot,
        command: params.command,
        args: params.args ?? null,
        cwd: params.cwd ?? null,
        env: Object.keys(envMap).length > 0 ? envMap : null,
        outputByteLimit: params.outputByteLimit ?? null,
      });
      return { terminalId };
    },
    terminalOutput: async (params) => {
      const snap = await acpTerminalOutput(params.terminalId);
      return {
        output: snap.output,
        truncated: snap.truncated,
        exitStatus: snap.exitStatus
          ? {
              exitCode: snap.exitStatus.exitCode,
              signal: snap.exitStatus.signal,
            }
          : null,
      };
    },
    terminalWaitForExit: async (params) => {
      const status = await acpTerminalWaitForExit(params.terminalId, null);
      return {
        exitCode: status.exitCode,
        signal: status.signal,
      };
    },
    terminalKill: async (params) => {
      await acpTerminalKill(params.terminalId);
      return {};
    },
    terminalRelease: async (params) => {
      await acpTerminalRelease(params.terminalId);
      return {};
    },
    ...overrides,
  };
}

export interface AcpControllerOptions {
  nativeResume?: NativeResumeAuthorization;
  agentId: string;
  workspaceRoot: string;
  transport?: AcpTransport;
  hostHandlers?: AcpHostCapabilityHandlers;
  clientOptions?: Omit<
    JsonRpcAcpClientOptions,
    'hostHandlers' | 'onSessionUpdate' | 'onExit'
  >;
  onSessionUpdate?: (params: AcpSessionUpdateNotificationParams) => void;
  onExit?: (code: number | null, reason?: string) => void;
  onStderr?: (line: string) => void;
}

export class AcpController {
  readonly client: JsonRpcAcpClient;
  readonly transport: AcpTransport;
  private initialized: AcpInitializeResult | null = null;
  private currentSessionId: string | null = null;

  constructor(private readonly options: AcpControllerOptions) {
    this.transport =
      options.transport ??
      new TauriAcpTransport(
        options.agentId,
        options.workspaceRoot,
        options.onStderr,
        options.nativeResume,
      );
    const hostHandlers =
      options.hostHandlers ?? createDesktopAcpHostHandlers(options.workspaceRoot);

    this.client = new JsonRpcAcpClient(this.transport, {
      ...options.clientOptions,
      hostHandlers,
      onSessionUpdate: options.onSessionUpdate,
      onExit: options.onExit,
    });
  }

  get initializeResult(): AcpInitializeResult | null {
    return this.initialized;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  setHostHandlers(handlers: Partial<AcpHostCapabilityHandlers>): void {
    this.client.setHostHandlers(handlers);
  }

  async connect(): Promise<AcpInitializeResult> {
    if (!this.client.isConnected) {
      await this.client.start();
    }
    if (!this.initialized) {
      this.initialized = await this.client.initialize();
    }
    return this.initialized;
  }

  async newSession(
    mcpServers: AcpMcpServerConfig[] = [],
  ): Promise<AcpSessionNewResult> {
    await this.connect();
    const res = await this.client.sessionNew({
      cwd: this.options.workspaceRoot,
      mcpServers,
    });
    this.currentSessionId = res.sessionId;
    return res;
  }

  async loadSession(
    sessionId: string,
    mcpServers: AcpMcpServerConfig[] = [],
  ): Promise<AcpSessionLoadResult> {
    await this.connect();
    const res = await this.client.sessionLoad({
      sessionId,
      cwd: this.options.workspaceRoot,
      mcpServers,
    });
    this.currentSessionId = sessionId;
    return res;
  }

  async prompt(
    input: string | AcpContentBlock[],
    sessionId = this.currentSessionId,
  ): Promise<AcpSessionPromptResult> {
    if (!sessionId) {
      throw new Error('ACP 会话尚未初始化');
    }
    const promptBlocks: AcpContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    return this.client.sessionPrompt({
      sessionId,
      prompt: promptBlocks,
    });
  }

  async cancel(sessionId = this.currentSessionId): Promise<void> {
    if (!sessionId) return;
    await this.client.sessionCancel({ sessionId });
  }

  async setMode(
    modeId: string,
    sessionId = this.currentSessionId,
  ): Promise<AcpSessionSetModeResult> {
    if (!sessionId) {
      throw new Error('ACP 会话尚未初始化');
    }
    return this.client.sessionSetMode({ sessionId, modeId });
  }

  async stop(): Promise<void> {
    this.initialized = null;
    await this.client.stop();
  }
}
