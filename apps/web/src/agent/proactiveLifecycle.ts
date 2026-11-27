import { tsMs } from '@rcx/rc-client';
import { t } from '../i18n';
import { formatSharePayloadForChat, type ButlerSharePayload } from '../lib/butlerChatBridge';
import { useAcpAgents } from '../stores/acpAgents';
import { useAuth } from '../stores/auth';
import { useButlerCognition } from '../stores/butlerCognition';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useButlerRoomBindings } from '../stores/butlerRoomBindings';
import { useChat } from '../stores/chat';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useWorkLedger } from '../stores/workLedger';

interface AcpSessionWatermark {
  status: string;
  turnCount: number;
  permIds: Set<string>;
}

const acpWatermarks = new Map<string, AcpSessionWatermark>();
const cardWaitWatermarks = new Map<string, string>();
const actionApprovalWatermarks = new Set<string>();
const roomWatermarkLm = new Map<string, number>();
const roomWatermarkMentions = new Map<string, number>();
const threadUserCountWatermark = new Map<string, number>();
let activeLifecycleScope = '';

function postToBoundTargets(
  targetKind: 'acp_session' | 'watchpoint',
  targetId: string,
  dedupeKey: string,
  payload: ButlerSharePayload,
): void {
  const bindingsStore = useButlerRoomBindings.getState();
  const bindings = bindingsStore.getBindingsForTarget(targetKind, targetId);
  if (bindings.length === 0) return;

  const isLocalMode = useAuth.getState().localMode;
  const markdown = formatSharePayloadForChat(payload);
  for (const binding of bindings) {
    if (!binding.autoPost || binding.lastReportedKey === dedupeKey) continue;
    bindingsStore.markReported(binding.id, dedupeKey);
    if (isLocalMode) continue;
    void useChat
      .getState()
      .send(markdown, {
        rid: binding.rid,
        ...(binding.tmid ? { tmid: binding.tmid } : {}),
      })
      .catch(() => undefined);
  }
}

export function syncProactiveSignalsSnapshot(now: number = Date.now()): boolean {
  const currentScope = resolveButlerAccountScope();
  if (activeLifecycleScope && activeLifecycleScope !== currentScope) {
    resetProactiveLifecycleWatermarksForTests();
    useButlerCognition.getState().hydrate(true);
    useButlerRoomBindings.getState().hydrate(true);
  }
  activeLifecycleScope = currentScope;

  const cog = useButlerCognition.getState();
  cog.hydrate();
  const bindingsStore = useButlerRoomBindings.getState();
  bindingsStore.hydrate();

  let ingestedHighSalience = false;
  const ingestAndTrack = (input: Parameters<typeof cog.ingestObservation>[0]) => {
    const beforeObsIds = new Set(useButlerCognition.getState().observations.map((o) => o.id));
    const added = cog.ingestObservation(input);
    const afterObs = useButlerCognition.getState().observations;
    for (const obs of afterObs) {
      if (!beforeObsIds.has(obs.id) && obs.kind === 'watchpoint_fired' && obs.ref?.watchpointId) {
        postToBoundTargets('watchpoint', obs.ref.watchpointId, `wp:${obs.ref.watchpointId}:${obs.at}`, {
          kind: 'watchpoint',
          watchpointId: obs.ref.watchpointId,
          reason: obs.summary,
          conditionKind: 'watchpoint_fired',
          expiresAt: now,
        });
      }
    }
    if (added && (added.salience === 'high' || afterObs[0]?.kind === 'watchpoint_fired')) {
      ingestedHighSalience = true;
    }
    return added;
  };

  // 1. Track user outbound activity watermark (Butler workspace + IM chat rooms).
  const ws = useCodexWorkspace.getState();
  const activeKey = ws.activeThreadId ?? '__active__';
  const userCount = ws.messages.filter((m) => m.role === 'user').length;
  const prevCount = threadUserCountWatermark.get(activeKey) ?? userCount;
  if (userCount > prevCount) {
    cog.recordUserActivity(now, 'butler');
  }
  threadUserCountWatermark.set(activeKey, userCount);

  const chat = useChat.getState();
  const selfUserId = useAuth.getState().user?._id;
  if (selfUserId) {
    for (const list of Object.values(chat.messages)) {
      for (let i = list.length - 1; i >= 0 && i >= list.length - 5; i -= 1) {
        const msg = list[i];
        if (msg?.u?._id === selfUserId) {
          const msgAt = tsMs(msg.ts);
          if (msgAt > cog.lastUserActivityAt) {
            cog.recordUserActivity(msgAt, 'chat');
          }
          break;
        }
      }
    }
  }

  // 2. Track ACP sub-agent lifecycle transitions.
  const acpSessions = useAcpAgents.getState().sessions;
  for (const session of Object.values(acpSessions)) {
    const prev = acpWatermarks.get(session.sessionKey);
    const currentPermIds = new Set(session.pendingPermissions.map((p) => p.requestId));

    if (!prev) {
      acpWatermarks.set(session.sessionKey, {
        status: session.status,
        turnCount: session.turnCount,
        permIds: currentPermIds,
      });
      continue;
    }

    if (session.turnCount > prev.turnCount && session.status === 'ready') {
      const lastReply = [...session.messages]
        .reverse()
        .find((m) => m.role === 'assistant')?.text
        .trim()
        .slice(0, 160) || '';
      const turnDedupeKey = `acp:turn:${session.sessionKey}:${session.turnCount}`;
      ingestAndTrack({
        dedupeKey: turnDedupeKey,
        at: now,
        source: 'acp',
        kind: 'acp_turn_completed',
        salience: session.linkedTodoId ? 'high' : 'normal',
        summary: t('agent.cognition.obs.acpTurnCompleted', {
          agent: session.agentName,
          title: session.title,
          preview: lastReply || t('agent.cognition.obs.noPreview'),
        }),
        ref: {
          sessionKey: session.sessionKey,
          ...(session.linkedTodoId ? { todoId: session.linkedTodoId } : {}),
        },
      });
      postToBoundTargets('acp_session', session.sessionKey, turnDedupeKey, {
        kind: 'acp_session',
        sessionKey: session.sessionKey,
        agentId: session.agentId,
        agentName: session.agentName,
        title: session.title,
        status: session.status,
        summary: lastReply || t('agent.cognition.obs.noPreview'),
        workspaceRoot: session.workspaceRoot,
      });
    }

    for (const perm of session.pendingPermissions) {
      if (!prev.permIds.has(perm.requestId)) {
        const permDedupeKey = `acp:perm:${session.sessionKey}:${perm.requestId}`;
        const permLabel = perm.toolCall.title || perm.reason || perm.requestId;
        ingestAndTrack({
          dedupeKey: permDedupeKey,
          at: now,
          source: 'acp',
          kind: 'acp_waiting_approval',
          salience: 'high',
          summary: t('agent.cognition.obs.acpPermission', {
            agent: session.agentName,
            tool: permLabel,
          }),
          ref: {
            sessionKey: session.sessionKey,
            ...(session.linkedTodoId ? { todoId: session.linkedTodoId } : {}),
          },
        });
        postToBoundTargets('acp_session', session.sessionKey, permDedupeKey, {
          kind: 'acp_session',
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          agentName: session.agentName,
          title: session.title,
          status: session.status,
          summary: session.plan.map((p) => p.content).slice(0, 3).join(' · ') || session.title,
          pendingApproval: permLabel,
          workspaceRoot: session.workspaceRoot,
        });
      }
    }

    if (session.status === 'error' && prev.status !== 'error') {
      const errDedupeKey = `acp:err:${session.sessionKey}:${session.updatedAt}`;
      const errText = session.error || t('agent.cognition.obs.unknownError');
      ingestAndTrack({
        dedupeKey: errDedupeKey,
        at: now,
        source: 'acp',
        kind: 'acp_error',
        salience: 'high',
        summary: t('agent.cognition.obs.acpError', {
          agent: session.agentName,
          error: errText,
        }),
        ref: {
          sessionKey: session.sessionKey,
          ...(session.linkedTodoId ? { todoId: session.linkedTodoId } : {}),
        },
      });
      postToBoundTargets('acp_session', session.sessionKey, errDedupeKey, {
        kind: 'acp_session',
        sessionKey: session.sessionKey,
        agentId: session.agentId,
        agentName: session.agentName,
        title: session.title,
        status: session.status,
        summary: errText,
        workspaceRoot: session.workspaceRoot,
      });
    }

    acpWatermarks.set(session.sessionKey, {
      status: session.status,
      turnCount: session.turnCount,
      permIds: currentPermIds,
    });
  }

  // 3. Track Work Ledger cards & dispatch actions.
  const ledger = useWorkLedger.getState();
  for (const card of ledger.cards) {
    if (card.done || !card.state) continue;
    const waitState = card.state.waitState;
    const prevWait = cardWaitWatermarks.get(card.id);
    cardWaitWatermarks.set(card.id, waitState);
    if (!prevWait || prevWait === waitState) continue;

    if (waitState === 'blocked' || waitState === 'waiting_approval' || waitState === 'waiting_input') {
      ingestAndTrack({
        dedupeKey: `card:${card.id}:${waitState}:${card.updatedAt}`,
        at: now,
        source: 'work_ledger',
        kind: waitState === 'blocked' ? 'work_card_blocked' : 'work_card_waiting',
        salience: 'high',
        summary: t('agent.cognition.obs.workCardWait', {
          title: card.title,
          waitState,
          reason: card.state.waitReason || card.state.nextStep || '',
        }),
        ref: { todoId: card.id },
      });
    }
  }

  for (const action of ledger.actions) {
    if (action.state !== 'awaiting_approval') continue;
    if (actionApprovalWatermarks.has(action.id)) continue;
    actionApprovalWatermarks.add(action.id);
    const card = ledger.cards.find((c) => c.id === action.todoId);
    ingestAndTrack({
      dedupeKey: `dispatch:approval:${action.id}`,
      at: now,
      source: 'work_ledger',
      kind: 'dispatch_awaiting_approval',
      salience: 'high',
      summary: t('agent.cognition.obs.dispatchApproval', {
        title: card?.title || action.todoId,
        kind: action.actionKind,
      }),
      ref: { todoId: action.todoId, actionId: action.id },
    });
  }

  // 4. Track IM room mentions & subscribed room messages.
  for (const sub of Object.values(chat.subscriptions)) {
    if (sub.open === false) continue;
    const room = chat.rooms[sub.rid];
    const lm = tsMs(room?.lm ?? room?.lastMessage?.ts ?? sub.ls);
    const mentions = sub.userMentions ?? 0;
    const prevLm = roomWatermarkLm.get(sub.rid);
    const prevMentions = roomWatermarkMentions.get(sub.rid);
    roomWatermarkLm.set(sub.rid, lm);
    roomWatermarkMentions.set(sub.rid, mentions);

    if (prevLm === undefined || prevMentions === undefined) continue;

    const roomName = sub.fname || sub.name || sub.rid;
    const lastMessage = chat.rooms[sub.rid]?.lastMessage;
    const preview = lastMessage?.msg?.slice(0, 120) ?? '';
    const roomBindings = bindingsStore.getBindingsForRoom(sub.rid);
    const matchingAcpBinding = roomBindings.find(
      (b) =>
        b.targetKind === 'acp_session'
        && (!b.tmid || b.tmid === lastMessage?.tmid),
    );
    const fromOtherUser = !lastMessage?.u?._id || lastMessage.u._id !== selfUserId;

    if (matchingAcpBinding && lm > prevLm && fromOtherUser) {
      ingestAndTrack({
        dedupeKey: `chat:bound:${sub.rid}:${lm}:${matchingAcpBinding.targetId}`,
        at: now,
        source: 'chat',
        kind: 'bound_room_reply',
        salience: 'high',
        summary: t('agent.cognition.obs.boundRoomReply', {
          room: roomName,
          label: matchingAcpBinding.label,
          preview,
        }),
        ref: {
          rid: sub.rid,
          ...(lastMessage?._id ? { mid: lastMessage._id } : {}),
          sessionKey: matchingAcpBinding.targetId,
        },
      });
    } else if (mentions > prevMentions) {
      ingestAndTrack({
        dedupeKey: `chat:mention:${sub.rid}:${lm}:${mentions}`,
        at: now,
        source: 'chat',
        kind: 'room_mention',
        salience: 'high',
        summary: t('agent.cognition.obs.roomMention', {
          room: roomName,
          preview,
        }),
        ref: { rid: sub.rid },
      });
    } else if (lm > prevLm) {
      ingestAndTrack({
        dedupeKey: `chat:msg:${sub.rid}:${lm}`,
        at: now,
        source: 'chat',
        kind: 'room_message',
        salience: 'low',
        summary: t('agent.cognition.obs.roomMessage', {
          room: roomName,
          preview,
        }),
        ref: { rid: sub.rid },
      });
    }
  }
  return ingestedHighSalience;
}

export function resetProactiveLifecycleWatermarksForTests(): void {
  acpWatermarks.clear();
  cardWaitWatermarks.clear();
  actionApprovalWatermarks.clear();
  roomWatermarkLm.clear();
  roomWatermarkMentions.clear();
  threadUserCountWatermark.clear();
  activeLifecycleScope = '';
}

export function startProactiveLifecycle(): () => void {
  syncProactiveSignalsSnapshot();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const onStoreSignal = () => {
    const highSalience = syncProactiveSignalsSnapshot();
    if (!highSalience) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void useButlerCognition.getState().evaluatePulse().catch(() => undefined);
    }, 2_000);
  };

  const unsubAuth = useAuth.subscribe(() => {
    const nextScope = resolveButlerAccountScope();
    if (activeLifecycleScope && activeLifecycleScope !== nextScope) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      resetProactiveLifecycleWatermarksForTests();
      useButlerCognition.getState().hydrate(true);
      useButlerRoomBindings.getState().hydrate(true);
      syncProactiveSignalsSnapshot();
    }
  });
  const unsubAcp = useAcpAgents.subscribe(onStoreSignal);
  const unsubLedger = useWorkLedger.subscribe(onStoreSignal);
  const unsubChat = useChat.subscribe(onStoreSignal);
  const unsubCodex = useCodexWorkspace.subscribe(onStoreSignal);

  const timer = setInterval(() => {
    syncProactiveSignalsSnapshot();
    const cog = useButlerCognition.getState();
    void cog.evaluatePulse().catch(() => undefined);
    void cog.maybeRunDailyDream().catch(() => undefined);
  }, 30_000);

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearInterval(timer);
    unsubAuth();
    unsubAcp();
    unsubLedger();
    unsubChat();
    unsubCodex();
  };
}
