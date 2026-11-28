import { LOCAL_ACCOUNT_OWNER } from '../../lib/accountScope';

export interface AcpSessionLedgerSyncInput {
  agentId: string;
  agentName: string;
  preset: string;
  autonomyMode: string;
  title: string;
  workspaceRoot: string;
  acpSessionId?: string | null;
  nativeSessionId?: string | null;
  sourceScope?: string;
  accountScope?: string | null;
  linkedTodoId?: string | null;
  status: 'idle' | 'connecting' | 'ready' | 'running' | 'waiting_approval' | 'stopped' | 'error';
  connectionReady?: boolean;
  turnCount: number;
  modesCurrentModeId?: string | null;
  lastTurnId?: string | null;
  nativeIdentityPending?: boolean;
}

export interface AcpHostBridge {
  resolveAccountScope: () => string;
  syncSessionToLedger: (session: AcpSessionLedgerSyncInput) => Promise<void>;
  findOriginalWorkTodoId: (input: {
    nativeSessionId: string;
    sourceScope?: string;
    accountScope: string;
    hostDeviceId: string;
    workspaceRoot: string;
  }) => string | undefined;
  canUsePersonalMemory: (linkedTodoId?: string | null) => boolean;
  recallMemoryBlock: (input: {
    query: string;
    workspaceRoot: string;
    limit: number;
  }) => Promise<string>;
}

function defaultAccountScope(): string {
  try {
    if (typeof localStorage === 'undefined') return LOCAL_ACCOUNT_OWNER;
    if (localStorage.getItem('rcx-local-mode') === '1') return LOCAL_ACCOUNT_OWNER;
    const owner = localStorage.getItem('rcx-owner')?.trim();
    return owner || LOCAL_ACCOUNT_OWNER;
  } catch {
    return LOCAL_ACCOUNT_OWNER;
  }
}

const DEFAULT_BRIDGE: AcpHostBridge = {
  resolveAccountScope: defaultAccountScope,
  syncSessionToLedger: async () => {},
  findOriginalWorkTodoId: () => undefined,
  canUsePersonalMemory: () => true,
  recallMemoryBlock: async () => '',
};

let activeBridge: AcpHostBridge = { ...DEFAULT_BRIDGE };

/** 由上层 Butler / WorkLedger 编排模块注册，使 ACP 进程管理层不再反向依赖业务账本或记忆。 */
export function registerAcpHostBridge(bridge: Partial<AcpHostBridge>): () => void {
  const previous = activeBridge;
  activeBridge = { ...activeBridge, ...bridge };
  return () => {
    activeBridge = previous;
  };
}

export function getAcpHostBridge(): AcpHostBridge {
  return activeBridge;
}
