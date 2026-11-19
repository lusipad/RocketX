import { renderDispatchSpec, type DispatchSpec } from './dispatchSpec';
import { workContextPathKey } from '../lib/workContext';
import type {
  DispatchActionKind,
  NativeWorkSessionRecord,
  WorkCardVisibility,
  WorkSessionControlMode,
  WorkSessionRuntime,
} from '../platform/desktopCommands';

export type AgentRuntimeId = WorkSessionRuntime;

/** Candidate for explicit cold handoff. The native host verifies the profile and original thread when opened. */
export function codexHandoffProfileId(session: NativeWorkSessionRecord, deviceId: string): string | null {
  if (!session.accountScope?.trim() || !session.hostDeviceId || session.hostDeviceId !== deviceId
    || !session.workspaceRoot.trim() || !session.sourceScope?.trim() || !session.nativeSessionId.trim()) return null;
  if (session.controlMode !== 'resumable' && !(session.controlMode === 'readonly'
    && ['active_external_writer', 'external_activity_unknown'].includes(session.controlReason ?? ''))) return null;
  try {
    const config = JSON.parse(session.configSnapshotJson ?? '{}');
    if (session.runtime !== 'codex' && config?.provider !== 'codex') return null;
    const profile = config?.executionProfileId ?? config?.agentId;
    return typeof profile === 'string' && profile.trim() ? profile : null;
  } catch { return null; }
}

/** A native ID is unique only inside its source/account and owning execution profile. */
export function matchesAcpWorkSession(
  record: Pick<NativeWorkSessionRecord, 'nativeSessionId' | 'sourceScope' | 'accountScope' | 'workspaceRoot' | 'configSnapshotJson'>,
  candidate: { acpSessionId: string; nativeSessionId?: string; agentId: string; sourceScope?: string; accountScope?: string; workspaceRoot: string },
  currentAccountScope: string,
): boolean {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(record.configSnapshotJson ?? '{}') ?? {}; } catch { /* legacy records can lack metadata */ }
  const profile = typeof meta.agentId === 'string' ? meta.agentId : typeof meta.executionProfileId === 'string' ? meta.executionProfileId : null;
  return record.nativeSessionId === (candidate.nativeSessionId ?? candidate.acpSessionId)
    && (record.sourceScope ?? 'default') === (candidate.sourceScope ?? 'default')
    && workContextPathKey(record.workspaceRoot) === workContextPathKey(candidate.workspaceRoot)
    && (!record.accountScope || record.accountScope === currentAccountScope)
    && (!candidate.accountScope || candidate.accountScope === currentAccountScope)
    && (!profile || profile === candidate.agentId);
}

export interface RuntimeCapabilities {
  runtime: AgentRuntimeId;
  discoverHistory: boolean;
  subscribeLiveEvents: boolean;
  createSession: boolean;
  coldResume: boolean;
  sendPrompt: boolean;
  steerActiveTurn: boolean;
  interruptTurn: boolean;
  respondApprovalAndQuestion: boolean;
  forkOrImportContext: boolean;
}

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'codex',
  discoverHistory: true,
  subscribeLiveEvents: true,
  createSession: true,
  coldResume: true,
  sendPrompt: true,
  steerActiveTurn: true,
  interruptTurn: true,
  respondApprovalAndQuestion: true,
  forkOrImportContext: true,
};

export const DSH_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'dsh',
  discoverHistory: true,
  subscribeLiveEvents: true,
  createSession: true,
  coldResume: true,
  sendPrompt: true,
  steerActiveTurn: false,
  interruptTurn: true,
  respondApprovalAndQuestion: true,
  forkOrImportContext: true,
};

export const PI_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'pi',
  discoverHistory: true,
  subscribeLiveEvents: true,
  createSession: true,
  coldResume: true,
  sendPrompt: true,
  steerActiveTurn: true,
  interruptTurn: true,
  respondApprovalAndQuestion: true,
  forkOrImportContext: true,
};

export const ACP_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'acp',
  discoverHistory: true,
  subscribeLiveEvents: true,
  createSession: true,
  coldResume: true,
  sendPrompt: true,
  steerActiveTurn: true,
  interruptTurn: true,
  respondApprovalAndQuestion: true,
  forkOrImportContext: true,
};

export function getRuntimeCapabilities(runtime: AgentRuntimeId): RuntimeCapabilities {
  if (runtime === 'dsh' || runtime === 'deepseek') return DSH_CAPABILITIES;
  if (runtime === 'pi') return PI_CAPABILITIES;
  if (runtime === 'acp') return ACP_CAPABILITIES;
  return CODEX_CAPABILITIES;
}

export type SessionControlReason =
  | 'owned_live_controller'
  | 'stopped_local_matching_cwd'
  | 'active_external_writer'
  | 'remote_device_lease'
  | 'workspace_missing'
  | 'external_activity_unknown'
  | 'corrupt_or_partial_log';

export interface SessionInspectionInput {
  runtime: AgentRuntimeId;
  nativeSessionId: string;
  origin?: 'rocketx_managed' | 'native_cli' | 'native_desktop';
  workspaceRoot: string;
  workspaceExists?: boolean;
  hasOwnedLiveController?: boolean;
  externalWriterActive?: boolean;
  externalActivityUnknown?: boolean;
  writerLeaseOwner?: string | null;
  writerLeaseExpiresAt?: number | null;
  currentWriterId?: string | null;
  hostDeviceId?: string | null;
  currentDeviceId?: string | null;
  hasRemoteControlEndpoint?: boolean;
  logIntegrity?: 'complete' | 'partial' | 'corrupt';
  nowMs?: number;
}

export interface SessionControlEvaluation {
  controlMode: WorkSessionControlMode;
  controlReason: SessionControlReason;
  badgeLabel: '只读' | '可恢复' | '可实时控制';
  description: string;
  capabilities: RuntimeCapabilities;
  canSendPromptDirectly: boolean;
  canSteerActiveTurn: boolean;
  canColdResume: boolean;
  canImportContextToNewSession: boolean;
}

export function evaluateSessionControlMode(
  input: SessionInspectionInput,
): SessionControlEvaluation {
  const capabilities = getRuntimeCapabilities(input.runtime);
  const now = input.nowMs ?? Date.now();

  if (input.logIntegrity === 'corrupt' || input.logIntegrity === 'partial') {
    return {
      controlMode: 'readonly',
      controlReason: 'corrupt_or_partial_log',
      badgeLabel: '只读',
      description: '会话日志部分损坏或尚未落盘完成，已降级为只读浏览',
      capabilities,
      canSendPromptDirectly: false,
      canSteerActiveTurn: false,
      canColdResume: false,
      canImportContextToNewSession: capabilities.forkOrImportContext,
    };
  }

  if (input.workspaceExists === false || !input.workspaceRoot.trim()) {
    return {
      controlMode: 'readonly',
      controlReason: 'workspace_missing',
      badgeLabel: '只读',
      description: '工作区目录不存在或当前不可访问，仅支持只读查看与导入上下文',
      capabilities,
      canSendPromptDirectly: false,
      canSteerActiveTurn: false,
      canColdResume: false,
      canImportContextToNewSession: capabilities.forkOrImportContext,
    };
  }

  if (
    input.hostDeviceId &&
    input.currentDeviceId &&
    input.hostDeviceId !== input.currentDeviceId &&
    !input.hasRemoteControlEndpoint
  ) {
    return {
      controlMode: 'readonly',
      controlReason: 'remote_device_lease',
      badgeLabel: '只读',
      description: '该会话归属其他设备且无远程控制端点，仅支持只读查看或导入到本机新会话',
      capabilities,
      canSendPromptDirectly: false,
      canSteerActiveTurn: false,
      canColdResume: false,
      canImportContextToNewSession: capabilities.forkOrImportContext,
    };
  }

  const leaseActiveByOther =
    Boolean(input.writerLeaseOwner) &&
    input.writerLeaseOwner !== (input.currentWriterId ?? 'rocketx:local') &&
    (input.writerLeaseExpiresAt == null || input.writerLeaseExpiresAt > now);

  if (input.externalWriterActive || leaseActiveByOther) {
    return {
      controlMode: 'readonly',
      controlReason: 'active_external_writer',
      badgeLabel: '只读',
      description: '外部终端或其他实例正持有该会话写入权，RocketX 不会抢占，可导入上下文新建受管会话',
      capabilities,
      canSendPromptDirectly: false,
      canSteerActiveTurn: false,
      canColdResume: false,
      canImportContextToNewSession: capabilities.forkOrImportContext,
    };
  }

  if (input.hasOwnedLiveController) {
    return {
      controlMode: 'controllable',
      controlReason: 'owned_live_controller',
      badgeLabel: '可实时控制',
      description: '当前由 RocketX 实时托管，可直接追问、追加约束、中断或响应审批',
      capabilities,
      canSendPromptDirectly: capabilities.sendPrompt,
      canSteerActiveTurn: capabilities.steerActiveTurn,
      canColdResume: false,
      canImportContextToNewSession: capabilities.forkOrImportContext,
    };
  }

  if (input.externalActivityUnknown) {
    return {
      controlMode: 'readonly',
      controlReason: 'external_activity_unknown',
      badgeLabel: '只读',
      description: '尚未确认原端已停止。请在原端停止执行，再明确交接到 RocketX；不会自动启动第二个执行器',
      capabilities,
      canSendPromptDirectly: false,
      canSteerActiveTurn: false,
      canColdResume: false,
      canImportContextToNewSession: capabilities.forkOrImportContext,
    };
  }

  return {
    controlMode: 'resumable',
    controlReason: 'stopped_local_matching_cwd',
    badgeLabel: '可恢复',
    description: '本地会话当前已停止且无外部占用，可在原工作区冷恢复后继续推进',
    capabilities,
    canSendPromptDirectly: false,
    canSteerActiveTurn: false,
    canColdResume: capabilities.coldResume,
    canImportContextToNewSession: capabilities.forkOrImportContext,
  };
}

export interface SessionDispatchEligibility {
  allowed: boolean;
  requiresColdResume: boolean;
  fallbackToImportContext: boolean;
  reason: string;
}

export function checkSessionDispatchEligibility(
  session: Pick<
    NativeWorkSessionRecord,
    'runtime' | 'controlMode' | 'controlReason' | 'visibility' | 'runtimeStatus'
  >,
  cardVisibility: WorkCardVisibility,
  actionKind: DispatchActionKind,
): SessionDispatchEligibility {
  // 隐私防火墙：私密任务不得派发到房间共享会话
  if (cardVisibility === 'private' && session.visibility === 'room_shared') {
    return {
      allowed: false,
      requiresColdResume: false,
      fallbackToImportContext: false,
      reason: '隐私保护拦截：个人私密卡片禁止派发到房间共享会话',
    };
  }

  const capabilities = getRuntimeCapabilities(session.runtime);

  if (session.controlMode === 'readonly') {
    return {
      allowed: false,
      requiresColdResume: false,
      fallbackToImportContext: capabilities.forkOrImportContext,
      reason:
        session.controlReason === 'active_external_writer'
          ? '目标会话正被外部写入方占用（只读），禁止直接注入指令；可导入上下文新建受管会话'
          : '目标会话当前为只读模式，禁止直接发送指令；可导入上下文新建受管会话',
    };
  }

  if (actionKind === 'session_steer') {
    if (!capabilities.steerActiveTurn) {
      return {
        allowed: false,
        requiresColdResume: false,
        fallbackToImportContext: false,
        reason: `${session.runtime.toUpperCase()} 运行时不支持在活跃轮次中实时追加转向指令（steer），请等待当前轮次结束或中断后发送`,
      };
    }
    if (session.controlMode !== 'controllable') {
      return {
        allowed: false,
        requiresColdResume: true,
        fallbackToImportContext: false,
        reason: '目标会话当前未处于实时托管态，需先冷恢复会话后再发送指令',
      };
    }
    return {
      allowed: true,
      requiresColdResume: false,
      fallbackToImportContext: false,
      reason: '允许实时追加转向指令',
    };
  }

  if (actionKind === 'session_prompt') {
    if (session.controlMode === 'controllable') {
      return {
        allowed: true,
        requiresColdResume: false,
        fallbackToImportContext: false,
        reason: '会话处于实时可控制状态，可直接发送指令',
      };
    }
    if (session.controlMode === 'resumable' && capabilities.coldResume) {
      return {
        allowed: true,
        requiresColdResume: true,
        fallbackToImportContext: false,
        reason: '会话处于可恢复状态，冷恢复后可继续发送指令',
      };
    }
  }

  return {
    allowed: true,
    requiresColdResume: false,
    fallbackToImportContext: false,
    reason: '允许执行派发动作',
  };
}

export interface ContextImportOptions {
  sourceSession: Pick<
    NativeWorkSessionRecord,
    'runtime' | 'nativeSessionId' | 'title' | 'workspaceRoot' | 'controlReason'
  >;
  cardGoal: string;
  acceptance?: string[];
  boundaries?: string[];
  recentTranscriptExcerpt: string;
  nextInstruction: string;
}

export function buildSessionContextImportSpec(options: ContextImportOptions): string {
  const specInput: DispatchSpec = {
    title: options.cardGoal,
    goal: [
      `原会话（${options.sourceSession.runtime}:${options.sourceSession.nativeSessionId}）因「${options.sourceSession.controlReason ?? '只读限制'}」保持只读，已在工作区 ${options.sourceSession.workspaceRoot} 创建新的 RocketX 受管会话接续推进。`,
      `本次推进指令：${options.nextInstruction}`,
    ].join('\n'),
    acceptance:
      options.acceptance && options.acceptance.length > 0
        ? options.acceptance
        : ['完成本次推进指令并产出可验证的证据（测试、构建或代码变更说明）'],
    boundaries: [
      ...(options.boundaries ?? []),
      '不得假定原只读会话仍在协同执行，动手前先核查当前工作区 git status 与最新 HEAD',
    ],
    evidence: [
      {
        label: `${options.sourceSession.runtime}:${options.sourceSession.nativeSessionId} (${options.sourceSession.title ?? '原会话最近上下文摘要'})`,
        text: options.recentTranscriptExcerpt,
      },
    ],
  };

  return renderDispatchSpec(specInput);
}
