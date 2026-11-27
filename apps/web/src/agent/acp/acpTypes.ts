export type AcpTransportExitHandler = (code: number | null, reason?: string) => void;
export type AcpTransportLineHandler = (line: string) => void;

/**
 * Pluggable NDJSON transport for ACP (Agent Client Protocol).
 * Works with TauriAcpTransport in desktop runtime and in-memory/mock transports in Node tests.
 */
export interface AcpTransport {
  start(): Promise<void>;
  sendLine(line: string): Promise<void>;
  stop(): Promise<void>;
  onLine(handler: AcpTransportLineHandler): () => void;
  onExit(handler: AcpTransportExitHandler): () => void;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export type AcpProtocolVersion = 1;

export interface AcpImplementationInfo {
  name: string;
  title?: string;
  version: string;
}

export interface AcpClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  [key: string]: unknown;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpInitializeParams {
  protocolVersion: AcpProtocolVersion;
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: AcpImplementationInfo;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: AcpImplementationInfo;
  authMethods?: AcpAuthMethod[];
}

export type AcpMcpServerConfig =
  | {
      name: string;
      command: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
    }
  | {
      type: 'http' | 'sse';
      name: string;
      url: string;
      headers?: Array<{ name: string; value: string }>;
    };

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface AcpSessionModel {
  modelId: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModelState {
  currentModelId: string;
  availableModels: AcpSessionModel[];
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: AcpMcpServerConfig[];
}

export interface AcpSessionNewResult {
  sessionId: string;
  modes?: AcpSessionModeState | null;
  models?: AcpSessionModelState | null;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServerConfig[];
}

export interface AcpSessionLoadResult {
  modes?: AcpSessionModeState | null;
  models?: AcpSessionModelState | null;
}

export type AcpContentBlock =
  | {
      type: 'text';
      text: string;
      annotations?: Record<string, unknown>;
    }
  | {
      type: 'image';
      data: string;
      mimeType: string;
      uri?: string | null;
    }
  | {
      type: 'audio';
      data: string;
      mimeType: string;
    }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      title?: string | null;
      description?: string | null;
      mimeType?: string | null;
      size?: number | null;
    }
  | {
      type: 'resource';
      resource: {
        uri: string;
        mimeType?: string | null;
        text?: string;
        blob?: string;
      };
    };

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | (string & {});

export interface AcpSessionPromptResult {
  stopReason: AcpStopReason;
}

export interface AcpSessionSetModeParams {
  sessionId: string;
  modeId: string;
}

export interface AcpSessionSetModeResult {
  [key: string]: unknown;
}

export interface AcpSessionSetModelParams {
  sessionId: string;
  modelId: string;
}

export interface AcpSessionSetModelResult {
  [key: string]: unknown;
}

export interface AcpSessionCancelParams {
  sessionId: string;
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AcpToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
}

export type AcpToolCallContent =
  | {
      type: 'content';
      content: AcpContentBlock;
    }
  | {
      type: 'diff';
      path: string;
      oldText?: string | null;
      newText: string;
    }
  | {
      type: 'terminal';
      terminalId: string;
    };

export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind?: AcpToolCallKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: AcpToolCallKind | null;
  status?: AcpToolCallStatus | null;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: {
    hint?: string | null;
  } | null;
}

export type AcpSessionUpdate =
  | {
      /** Internal bridge extension: transport session aliases are never native resume identities. */
      sessionUpdate: 'rocketx_native_session';
      nativeSessionId: string;
      provider: 'codex';
      workspaceRoot: string;
      sourceScope: string;
    }
  | {
      sessionUpdate: 'agent_message_chunk';
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: 'user_message_chunk';
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: 'agent_thought_chunk';
      content: AcpContentBlock;
    }
  | ({
      sessionUpdate: 'tool_call';
    } & AcpToolCall)
  | ({
      sessionUpdate: 'tool_call_update';
    } & AcpToolCallUpdate)
  | {
      sessionUpdate: 'plan';
      entries: AcpPlanEntry[];
    }
  | {
      sessionUpdate: 'current_mode_update';
      currentModeId: string;
    }
  | {
      sessionUpdate: 'available_commands_update';
      availableCommands: AcpAvailableCommand[];
    };

export interface AcpSessionUpdateNotificationParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

export interface AcpRequestPermissionResult {
  outcome:
    | {
        outcome: 'selected';
        optionId: string;
      }
    | {
        outcome: 'cancelled';
      };
}

export interface AcpFsReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface AcpFsReadTextFileResult {
  content: string;
}

export interface AcpFsWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpTerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: AcpEnvVariable[];
  outputByteLimit?: number | null;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
}

export interface AcpTerminalSessionParams {
  sessionId: string;
  terminalId: string;
}

export interface AcpTerminalExitStatusPayload {
  exitCode?: number | null;
  signal?: string | null;
}

export interface AcpTerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: AcpTerminalExitStatusPayload | null;
}

export interface AcpHostCapabilityHandlers {
  readTextFile?: (params: AcpFsReadTextFileParams) => Promise<AcpFsReadTextFileResult>;
  writeTextFile?: (params: AcpFsWriteTextFileParams) => Promise<Record<string, unknown>>;
  terminalCreate?: (params: AcpTerminalCreateParams) => Promise<AcpTerminalCreateResult>;
  terminalOutput?: (params: AcpTerminalSessionParams) => Promise<AcpTerminalOutputResult>;
  terminalWaitForExit?: (
    params: AcpTerminalSessionParams,
  ) => Promise<AcpTerminalExitStatusPayload>;
  terminalKill?: (params: AcpTerminalSessionParams) => Promise<Record<string, unknown>>;
  terminalRelease?: (params: AcpTerminalSessionParams) => Promise<Record<string, unknown>>;
  requestPermission?: (
    params: AcpRequestPermissionParams,
  ) => Promise<AcpRequestPermissionResult>;
}
