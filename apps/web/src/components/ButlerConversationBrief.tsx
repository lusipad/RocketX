import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { isTauri, isTauriRuntime } from '../lib/http';
import { completedWorkTurn, findWorkResultReply, unresolvedWorkDelivery } from '../lib/nativeWorkResult';
import { readNativeWorkSnapshot, type NativeWorkCard } from '../platform/desktopCommands';
import { listenDesktopEvent } from '../platform/desktopEvents';
import { captureButlerAccountGeneration, captureButlerRuntimeAccountContext, subscribeButlerAccountSelection, waitForButlerAccountReady } from '../platform/butlerAccountReady';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { captureWorkLedgerAccount, useWorkLedger } from '../stores/workLedger';

export type ConversationWorkTarget = { id: string; target?: 'evidence' | 'reply'; turnId?: string; sessionId?: string };

type ReplyCandidate = {
  card: NativeWorkCard;
  key: string;
  turnId: string;
  sessionId: string;
  nativeThreadId: string;
  sourceScope: string;
  executionProfileId: string;
};

function ConversationReply({ candidate, scope, onOpen, children }: {
  candidate: ReplyCandidate; scope: string; onOpen: (target: ConversationWorkTarget) => void; children: ReactNode;
}) {
  const t = useT();
  const [reply, setReply] = useState<{ text: string; historical: boolean } | null>(null);
  const { key, card, turnId, sessionId, nativeThreadId, sourceScope, executionProfileId } = candidate;
  useEffect(() => {
    let active = true;
    const assertAccount = captureButlerAccountGeneration();
    const fetchReply = async () => {
      await waitForButlerAccountReady();
      assertAccount();
      if (!active) return;
      const account = captureButlerRuntimeAccountContext();
      if (account.accountScope !== scope) return;
      const snapshot = await readNativeWorkSnapshot({ account, sessionId });
      assertAccount();
      if (!active || snapshot.protocolVersion !== 1
        || snapshot.sessionId !== sessionId || snapshot.nativeThreadId !== nativeThreadId
        || snapshot.executionProfileId !== executionProfileId || snapshot.sourceScope !== sourceScope
        || unresolvedWorkDelivery(snapshot.commands, card.id, sessionId)) return;
      const current = useWorkLedger.getState().cards.find(item => item.id === card.id);
      const result = current && findWorkResultReply(snapshot, current, turnId);
      if (result) setReply({ text: result.text, historical: snapshot.connectionStatus !== 'connected' || snapshot.runtimeStatus === 'unknown' });
    };
    void fetchReply().catch(() => {});
    return () => { active = false; };
  }, [key, scope, card.id, turnId, sessionId, nativeThreadId, sourceScope, executionProfileId]);
  return reply ? <button type="button" onClick={() => onOpen({ id: card.id, target: 'reply', turnId, sessionId })}>
    <span>{reply.historical ? t('butler.brief.historicalReply') : t('butler.brief.executorReply')}</span><strong>{card.title}</strong><small>{reply.text}</small><ArrowUpRight size={14} />
  </button> : children;
}

export default function ButlerConversationBrief({ onOpen }: { onOpen: (target: ConversationWorkTarget) => void }) {
  const t = useT();
  const scope = useAuth(() => resolveButlerAccountScope());
  const cards = useWorkLedger(state => state.cards);
  const actions = useWorkLedger(state => state.actions);
  const sessions = useWorkLedger(state => state.sessions);
  const evidences = useWorkLedger(state => state.evidences);
  const hydrated = useWorkLedger(state => state.hydrated);
  const error = useWorkLedger(state => state.lastError);
  const [verifiedScope, setVerifiedScope] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!active || timer) return;
      timer = setTimeout(async () => {
        timer = undefined;
        try {
          const assertSelection = captureButlerAccountGeneration();
          if (isTauri) await waitForButlerAccountReady();
          assertSelection();
          const assertAccount = captureWorkLedgerAccount();
          if (!active || resolveButlerAccountScope() !== scope) return;
          await useWorkLedger.getState().hydrate();
          assertAccount(); assertSelection();
          if (active) setVerifiedScope(scope);
        } catch { /* Account selection can invalidate an in-flight read. */ }
      }, 150);
    };
    const unsubscribe = subscribeButlerAccountSelection(() => { setVerifiedScope(null); refresh(); });
    // The desktop host emits this event for turn/decision/status changes, never token deltas.
    const registration = isTauriRuntime() ? listenDesktopEvent<{ accountScope: string; sessionId?: string; changes?: { semantic?: boolean; waiting?: boolean; summary?: boolean } }>('native-work-updated', ({ payload }) => {
      if (payload?.accountScope !== scope || !payload.sessionId) return;
      if (payload.changes && !payload.changes.semantic && !payload.changes.waiting && !payload.changes.summary) return;
      if (useWorkLedger.getState().sessions.some(session => session.id === payload.sessionId && session.accountScope === scope)) refresh();
    }).catch(() => undefined) : undefined;
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', refresh);
      void registration?.then(stop => stop?.()).catch(() => {});
    };
  }, [scope]);

  if (verifiedScope !== scope || !hydrated || error) return null;
  const current = cards.filter(card => !card.done && card.state.stage !== 'done'
    && !['canceled', 'paused'].includes(card.state.waitState));
  const deliveries = new Map<string, { sessionId: string; updatedAt: number }>();
  for (const session of sessions) {
    if (!session.todoId || (session.accountScope && session.accountScope !== scope)) continue;
    const unresolved = unresolvedWorkDelivery(actions, session.todoId, session.id);
    if (unresolved && unresolved.updatedAt >= (deliveries.get(session.todoId)?.updatedAt ?? 0))
      deliveries.set(session.todoId, { sessionId: session.id, updatedAt: unresolved.updatedAt });
  }
  const waiting = current.map(card => {
    const delivery = deliveries.get(card.id);
    if (delivery) return { card, label: t('butler.brief.verifyDeliveryLabel'), detail: t('butler.brief.verifyDeliveryDetail'), ...delivery };
    const waitingSession = sessions.find(session => session.todoId === card.id
      && (!session.accountScope || session.accountScope === scope) && ['waiting_input', 'waiting_approval'].includes(session.runtimeStatus));
    const needsInput = card.state.waitState === 'waiting_input' || waitingSession?.runtimeStatus === 'waiting_input';
    const needsApproval = card.state.waitState === 'waiting_approval' || waitingSession?.runtimeStatus === 'waiting_approval'
      || actions.some(action => action.todoId === card.id && action.state === 'awaiting_approval');
    const label = needsInput ? t('butler.brief.needsInput') : needsApproval ? t('butler.brief.needsApproval') : card.state.waitState === 'blocked' ? t('butler.brief.blocked') : null;
    return { card, label, detail: card.state.waitReason, sessionId: waitingSession?.id, updatedAt: card.updatedAt ?? 0 };
  }).filter(item => item.label).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const result = evidences.filter(evidence => !evidence.stale && current.some(card =>
    card.id === evidence.todoId && card.id !== waiting?.card.id && !deliveries.has(card.id)
    && (card.state.requirementsVersion ?? 0) === (evidence.requirementsVersion ?? 0)
    && (card.state.contentVersion ?? 0) === (evidence.contentVersion ?? 0)))
    .sort((a, b) => b.verifiedAt - a.verifiedAt)[0];
  const resultCard = result && current.find(card => card.id === result.todoId);
  let reply: ReplyCandidate | undefined;
  for (const action of actions.filter(action => action.actionKind === 'session_prompt' && action.state === 'completed'
    && (!result || action.updatedAt > result.verifiedAt)).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const card = current.find(card => card.id === action.todoId && card.id !== waiting?.card.id && !deliveries.has(card.id));
    if (!card) continue;
    const session = sessions.find(item => item.todoId === card.id && item.id === action.sessionId);
    if (!session || session.accountScope !== scope || !session.sourceScope) continue;
    try {
      const config = JSON.parse(session.configSnapshotJson ?? '{}');
      const executionProfileId = config?.executionProfileId ?? config?.agentId;
      if (typeof executionProfileId !== 'string' || !executionProfileId.trim()) continue;
      const source = { sessionId: session.id, nativeThreadId: session.nativeSessionId, executionProfileId, sourceScope: session.sourceScope };
      const turnId = completedWorkTurn(action, card, source);
      if (!turnId) continue;
      const key = JSON.stringify([scope, action.id, turnId, source, card.state.requirementsVersion, card.state.contentVersion, session.updatedAt]);
      reply = { ...source, key, card, turnId };
      break;
    } catch { /* Older records may lack their original source configuration. */ }
  }
  if (!waiting && !resultCard && !reply) return null;
  const evidenceNotice = resultCard && <button type="button" onClick={() => onOpen({ id: resultCard.id, target: 'evidence' })}>
    <span>{result.kind === 'agent_report' ? t('butler.brief.executorReport') : t('butler.brief.latestRecord')}</span>
    <strong>{resultCard.title}</strong><small>{result.summary || result.title}</small><ArrowUpRight size={14} />
  </button>;
  return <nav aria-label={t('butler.brief.noticesAria')} className="butler-work-notices">
    {waiting && <button type="button" onClick={() => onOpen({ id: waiting.card.id, sessionId: waiting.sessionId })}>
      <span className="text-warning">{waiting.label}</span>
      <strong>{waiting.card.title}</strong>{waiting.detail && <small>{waiting.detail}</small>}<ArrowUpRight size={14} />
    </button>}
    {reply ? <ConversationReply key={reply.key} candidate={reply} scope={scope} onOpen={onOpen}>{evidenceNotice}</ConversationReply> : evidenceNotice}
  </nav>;
}
