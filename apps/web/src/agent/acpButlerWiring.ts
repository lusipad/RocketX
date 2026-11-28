import { agentDeviceId } from './device';
import { registerAcpHostBridge, type AcpSessionLedgerSyncInput } from './acp/acpHostBridge';
import { workContextPathKey } from '../lib/workContext';
import {
  formatMemoryRecallPromptBlock,
  resolveButlerAccountScope,
  useButlerMemory,
} from '../stores/butlerMemory';
import { useWorkLedger } from '../stores/workLedger';

function mapAcpStatusToLedgerStatus(
  status: AcpSessionLedgerSyncInput['status'],
): 'idle' | 'running' | 'waiting_approval' | 'stopped' | 'error' {
  switch (status) {
    case 'running':
    case 'connecting':
      return 'running';
    case 'waiting_approval':
      return 'waiting_approval';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    case 'ready':
    case 'idle':
    default:
      return 'idle';
  }
}

async function syncAcpSessionToLedger(session: AcpSessionLedgerSyncInput): Promise<void> {
  if (session.nativeIdentityPending) return;
  const nativeSessionId = session.nativeSessionId ?? session.acpSessionId;
  if (!nativeSessionId) return;
  const accountScope = session.accountScope ?? resolveButlerAccountScope();
  if (accountScope !== resolveButlerAccountScope()) return;
  const ledger = useWorkLedger.getState();
  const existingLedgerSession = ledger.sessions.find(
    (s) =>
      s.runtime === 'acp' &&
      s.nativeSessionId === nativeSessionId &&
      (s.sourceScope ?? 'default') === (session.sourceScope ?? 'default') &&
      (!s.accountScope || s.accountScope === accountScope) &&
      (!s.hostDeviceId || s.hostDeviceId === agentDeviceId()),
  );
  const resolvedTodoId = session.linkedTodoId ?? existingLedgerSession?.todoId ?? null;
  const card = resolvedTodoId
    ? ledger.cards.find((c) => c.id === resolvedTodoId)
    : undefined;
  const visibility = card?.state.visibility ?? existingLedgerSession?.visibility ?? 'private';
  const stopped = session.status === 'stopped' || session.status === 'error';
  const disconnected = stopped || session.connectionReady === false;

  let preservedMeta: Record<string, unknown> = {};
  if (existingLedgerSession?.configSnapshotJson) {
    try {
      const parsed = JSON.parse(existingLedgerSession.configSnapshotJson) as Record<
        string,
        unknown
      >;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['provider', 'sourcePath', 'preview', 'stepCount']) {
          if (parsed[key] !== undefined && parsed[key] !== null) {
            preservedMeta[key] = parsed[key];
          }
        }
      }
    } catch {
      // ignore malformed snapshot JSON
    }
  }

  await ledger.upsertSession({
    todoId: resolvedTodoId,
    visibility,
    runtime: 'acp',
    origin: 'rocketx_managed',
    nativeSessionId,
    sourceScope: session.sourceScope,
    title: `${session.agentName}: ${session.title}`,
    workspaceRoot: session.workspaceRoot,
    environmentId: null,
    accountScope,
    controlEndpoint: disconnected ? null : `acp://${session.agentId}/${session.acpSessionId}`,
    controlMode: disconnected ? 'resumable' : 'controllable',
    controlReason:
      session.connectionReady === false
        ? 'connection_unavailable'
        : stopped
          ? 'stopped_local_matching_cwd'
          : 'owned_live_controller',
    hostDeviceId: agentDeviceId(),
    writerLeaseOwner: 'rocketx:local',
    writerLeaseExpiresAt: null,
    runtimeStatus: mapAcpStatusToLedgerStatus(session.status),
    configSnapshotJson: JSON.stringify({
      ...preservedMeta,
      agentId: session.agentId,
      preset: session.preset,
      autonomyMode: session.autonomyMode,
      modeId: session.modesCurrentModeId ?? null,
      transportSessionId: session.acpSessionId,
    }),
    lastEventSeq: session.turnCount,
    lastTurnId: session.lastTurnId ?? null,
  });
}

let wired = false;

export function installAcpButlerWiring(): void {
  if (wired) return;
  wired = true;
  registerAcpHostBridge({
    resolveAccountScope: resolveButlerAccountScope,
    syncSessionToLedger: syncAcpSessionToLedger,
    findOriginalWorkTodoId: (input) => {
      const match = useWorkLedger.getState().sessions.find(
        (record) =>
          record.runtime === 'acp' &&
          record.nativeSessionId === input.nativeSessionId &&
          (record.sourceScope ?? 'default') === (input.sourceScope ?? 'default') &&
          (!record.accountScope || record.accountScope === input.accountScope) &&
          (!record.hostDeviceId || record.hostDeviceId === input.hostDeviceId) &&
          workContextPathKey(record.workspaceRoot) === workContextPathKey(input.workspaceRoot),
      );
      return match?.todoId ?? undefined;
    },
    canUsePersonalMemory: (linkedTodoId) =>
      !linkedTodoId ||
      useWorkLedger.getState().cards.find((card) => card.id === linkedTodoId)?.state.visibility === 'private',
    recallMemoryBlock: async ({ query, workspaceRoot, limit }) => {
      const memories = await useButlerMemory.getState().recallRelevantMemories({
        query,
        workspaceRoot,
        limit,
      });
      return formatMemoryRecallPromptBlock(memories);
    },
  });
}

installAcpButlerWiring();
