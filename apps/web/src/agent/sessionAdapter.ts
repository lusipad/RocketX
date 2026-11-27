import { t } from '../i18n';
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
  badgeLabel: string;
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
      badgeLabel: t('agent.sessionAdapter.badge.readonly'),
      description: t('agent.sessionAdapter.desc.corruptLog'),
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
      badgeLabel: t('agent.sessionAdapter.badge.readonly'),
      description: t('agent.sessionAdapter.desc.workspaceMissing'),
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
      badgeLabel: t('agent.sessionAdapter.badge.readonly'),
      description: t('agent.sessionAdapter.desc.remoteLease'),
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
      badgeLabel: t('agent.sessionAdapter.badge.readonly'),
      description: t('agent.sessionAdapter.desc.externalWriter'),
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
      badgeLabel: t('agent.sessionAdapter.badge.controllable'),
      description: t('agent.sessionAdapter.desc.liveControl'),
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
      badgeLabel: t('agent.sessionAdapter.badge.readonly'),
      description: t('agent.sessionAdapter.desc.externalUnknown'),
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
    badgeLabel: t('agent.sessionAdapter.badge.resumable'),
    description: t('agent.sessionAdapter.desc.resumable'),
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
      reason: t('agent.sessionAdapter.dispatch.privacy'),
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
          ? t('agent.sessionAdapter.dispatch.readonlyExternal')
          : t('agent.sessionAdapter.dispatch.readonly'),
    };
  }

  if (actionKind === 'session_steer') {
    if (!capabilities.steerActiveTurn) {
      return {
        allowed: false,
        requiresColdResume: false,
        fallbackToImportContext: false,
        reason: t('agent.sessionAdapter.dispatch.noSteer', { runtime: session.runtime.toUpperCase() }),
      };
    }
    if (session.controlMode !== 'controllable') {
      return {
        allowed: false,
        requiresColdResume: true,
        fallbackToImportContext: false,
        reason: t('agent.sessionAdapter.dispatch.notControllable'),
      };
    }
    return {
      allowed: true,
      requiresColdResume: false,
      fallbackToImportContext: false,
      reason: t('agent.sessionAdapter.dispatch.steerAllowed'),
    };
  }

  if (actionKind === 'session_prompt') {
    if (session.controlMode === 'controllable') {
      return {
        allowed: true,
        requiresColdResume: false,
        fallbackToImportContext: false,
        reason: t('agent.sessionAdapter.dispatch.promptAllowed'),
      };
    }
    if (session.controlMode === 'resumable' && capabilities.coldResume) {
      return {
        allowed: true,
        requiresColdResume: true,
        fallbackToImportContext: false,
        reason: t('agent.sessionAdapter.dispatch.coldResumeAllowed'),
      };
    }
  }

  return {
    allowed: true,
    requiresColdResume: false,
    fallbackToImportContext: false,
    reason: t('agent.sessionAdapter.dispatch.allowed'),
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
      t('agent.sessionAdapter.import.goal', { runtime: options.sourceSession.runtime, sessionId: options.sourceSession.nativeSessionId, reason: options.sourceSession.controlReason ?? t('agent.sessionAdapter.import.readonlyFallback'), workspaceRoot: options.sourceSession.workspaceRoot }),
      t('agent.sessionAdapter.import.nextInstruction', { instruction: options.nextInstruction }),
    ].join('\n'),
    acceptance:
      options.acceptance && options.acceptance.length > 0
        ? options.acceptance
        : [t('agent.sessionAdapter.import.defaultAcceptance')],
    boundaries: [
      ...(options.boundaries ?? []),
      t('agent.sessionAdapter.import.boundary'),
    ],
    evidence: [
      {
        label: `${options.sourceSession.runtime}:${options.sourceSession.nativeSessionId} (${options.sourceSession.title ?? t('agent.sessionAdapter.import.defaultTitle')})`,
        text: options.recentTranscriptExcerpt,
      },
    ],
  };

  return renderDispatchSpec(specInput);
}
