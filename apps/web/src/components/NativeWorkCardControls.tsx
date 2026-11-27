import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { captureButlerAccountGeneration, captureButlerRuntimeAccountContext, subscribeButlerAccountSelection, waitForButlerAccountReady } from '../platform/butlerAccountReady';
import { answerNativeWork, readNativeWorkSnapshot, submitNativeWork } from '../platform/desktopCommands';
import type { NativeWorkCard, NativeWorkSessionRecord } from '../platform/desktopCommands';
import { listenDesktopEvent } from '../platform/desktopEvents';
import type { NativeWorkDecision, NativeWorkSnapshot } from '../platform/nativeWorkRuntime';
import { useWorkLedger } from '../stores/workLedger';
import { NativeDecision } from './NativeCodexWorkScene';
import { findWorkResultReply, pendingInvestigation, unresolvedWorkDelivery } from '../lib/nativeWorkResult';

export interface NativeWorkCardControlsProps {
  card: NativeWorkCard;
  session: NativeWorkSessionRecord;
  onOpen: () => void;
  allowStart?: boolean;
  onViewResult?: () => void;
  observationKey?: string;
  onSnapshot?: (snapshot: NativeWorkSnapshot | null, observationKey?: string) => void;
}

export function canAnswerWorkDecision(snapshot: NativeWorkSnapshot, card: NativeWorkCard, decision: NativeWorkDecision) {
  return snapshot.connectionStatus === 'connected' && Boolean(snapshot.connectionId) && snapshot.bindingVersion > 0
    && snapshot.capabilities.answer && decision.state === 'pending' && decision.nativeThreadId === snapshot.nativeThreadId
    && decision.nativeTurnId === snapshot.activeTurnId && decision.bindingVersion === snapshot.bindingVersion
    && decision.requirementsVersion === (card.state.requirementsVersion ?? 0);
}

export default function NativeWorkCardControls({ card, session, onOpen, allowStart = true, onViewResult, observationKey, onSnapshot }: NativeWorkCardControlsProps) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<NativeWorkSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<{ id: string; kind: 'prompt' | 'interrupt' } | null>(null);
  const [uncertainAnswer, setUncertainAnswer] = useState<string | null>(null);
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const operating = useRef(false);
  const snapshotCallback = useRef(onSnapshot);
  snapshotCallback.current = onSnapshot;
  const observation = useRef(observationKey);
  observation.current = observationKey;
  const previousObservation = useRef(observationKey);
  let executionProfileId: string | undefined;
  try {
    const config = JSON.parse(session.configSnapshotJson ?? '{}');
    const profile = config.executionProfileId ?? config.agentId;
    if (typeof profile === 'string') executionProfileId = profile;
  } catch { /* Historical metadata may not include a usable execution profile. */ }

  const refresh = useCallback(async () => {
    const generation = epoch.current;
    const sequence = ++readSequence.current;
    const observed = observation.current;
    try {
      const assertAccount = await waitForButlerAccountReady();
      assertAccount();
      const account = captureButlerRuntimeAccountContext();
      if (session.accountScope && session.accountScope !== account.accountScope) throw new Error(t('agent.nativeCard.switchAccount'));
      const next = await readNativeWorkSnapshot({ account, sessionId: session.id });
      assertAccount();
      if (generation !== epoch.current || sequence !== readSequence.current || observed !== observation.current) return;
      if (next.protocolVersion !== 1 || next.todoId !== card.id || next.sessionId !== session.id || next.nativeThreadId !== session.nativeSessionId
        || next.sourceScope !== session.sourceScope || !executionProfileId || next.executionProfileId !== executionProfileId) throw new Error(t('agent.nativeCard.identityChanged'));
      setSnapshot(next);
      setError(null);
      snapshotCallback.current?.(next, observed);
    } catch (cause) {
      if (generation !== epoch.current || sequence !== readSequence.current || observed !== observation.current) return;
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      snapshotCallback.current?.(null, observed);
    }
  }, [card.id, session.id, session.nativeSessionId, session.accountScope, session.sourceScope, executionProfileId]);

  useEffect(() => {
    epoch.current += 1;
    setSnapshot(null); setError(null); setNotice(null); setPendingRequest(null); setUncertainAnswer(null);
    setBusy(false); operating.current = false;
    let subscribing = true;
    const unsubscribe = subscribeButlerAccountSelection(() => {
      epoch.current += 1; readSequence.current += 1;
      setSnapshot(null); setError(null); setNotice(null); setPendingRequest(null); setUncertainAnswer(null);
      setBusy(false); operating.current = false;
      if (!subscribing) { snapshotCallback.current?.(null, observation.current); void refresh(); }
    });
    subscribing = false;
    return () => { epoch.current += 1; readSequence.current += 1; unsubscribe(); };
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh, session.updatedAt, session.runtimeStatus, session.controlMode, card.state.requirementsVersion, card.state.contentVersion]);

  useEffect(() => {
    if (previousObservation.current === observationKey) return;
    previousObservation.current = observationKey;
    const timer = setTimeout(() => { void refresh(); }, 250);
    return () => clearTimeout(timer);
  }, [refresh, observationKey]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    void listenDesktopEvent<{ accountScope: string; sessionId: string }>('native-work-updated', ({ payload }) => {
      if (!current || payload?.sessionId !== session.id) return;
      // A board-provided observation key already invalidates and schedules this read.
      if (observation.current !== undefined) return;
      try {
        if (payload.accountScope !== captureButlerRuntimeAccountContext().accountScope) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { if (current) void refresh(); }, 250);
      } catch { /* The current account has not finished initialization. */ }
    }).then(stop => { if (current) unlisten = stop; else stop(); }).catch(() => { /* The ledger's next update also refreshes this projection. */ });
    return () => { current = false; if (timer) clearTimeout(timer); unlisten?.(); };
  }, [refresh, session.id]);

  const perform = async (action: (account: ReturnType<typeof captureButlerRuntimeAccountContext>, assertCurrent: () => void) => Promise<void>) => {
    if (operating.current) return;
    operating.current = true; setBusy(true); setNotice(null);
    const generation = epoch.current;
    const assertAccount = captureButlerAccountGeneration();
    const assertCurrent = () => { assertAccount(); if (generation !== epoch.current) throw new Error(t('agent.nativeCard.switchedAccount')); };
    try {
      const account = captureButlerRuntimeAccountContext();
      if (session.accountScope && session.accountScope !== account.accountScope) throw new Error(t('agent.nativeCard.switchAccount'));
      await action(account, assertCurrent);
      assertCurrent();
      await useWorkLedger.getState().hydrate();
      assertCurrent();
    } catch (cause) {
      if (generation === epoch.current) setNotice(t('agent.nativeCard.resultPending', { message: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      if (generation === epoch.current) { operating.current = false; setBusy(false); void refresh(); }
    }
  };

  const command = snapshot?.commands.find(item => {
    try { return JSON.parse(item.specJson).requestId === pendingRequest?.id; } catch { return false; }
  });
  const pending = Boolean(pendingRequest && (!command || !['completed', 'failed', 'canceled'].includes(command.state)));
  const preparedPrompt = snapshot?.commands.some(item => item.actionKind === 'session_prompt' && !['completed', 'failed', 'canceled'].includes(item.state));
  const stopping = pendingRequest?.kind === 'interrupt' && !['failed', 'canceled'].includes(command?.state ?? '')
    && snapshot?.runtimeStatus !== 'interrupted' && Boolean(snapshot?.activeTurnId || snapshot?.runtimeStatus === 'unknown');
  const connected = snapshot?.connectionStatus === 'connected' && Boolean(snapshot.connectionId) && snapshot.bindingVersion > 0;
  const ready = connected && snapshot?.runtimeStatus === 'idle' && !snapshot.activeTurnId;
  const uncertainDelivery = unresolvedWorkDelivery(snapshot?.commands ?? [], card.id, session.id);
  const uncertainStop = Boolean(unresolvedWorkDelivery(snapshot?.commands ?? [], card.id, session.id, 'session_interrupt'));
  const writable = !uncertainDelivery && card.state.waitState === 'none' && card.state.autonomyMode !== 'readonly' && card.state.stage !== 'done'
    && snapshot?.capabilities.prompt && !snapshot.admissionWait && !onViewResult;
  const canStart = writable && ready && allowStart && !pendingInvestigation(snapshot) && ['triage', 'ready'].includes(card.state.stage)
    && Boolean(card.state.goal?.trim()) && !findWorkResultReply(snapshot, card);
  const canContinue = writable && allowStart && connected && snapshot.runtimeStatus === 'interrupted' && !snapshot.activeTurnId
    && !snapshot.error && !snapshot.decisions.some(item => item.state === 'pending' || item.state === 'unknown');
  const canAnswer = (decision: NativeWorkDecision) => Boolean(snapshot && canAnswerWorkDecision(snapshot, card, decision));
  const currentDecisions = snapshot?.decisions.filter(canAnswer) ?? [];
  const submit = (kind: 'prompt' | 'interrupt') => {
    if (!snapshot || !connected || busy || (kind === 'interrupt' ? stopping || uncertainStop : pending || preparedPrompt)) return;
    const frozen = snapshot;
    if (kind === 'interrupt' ? !frozen.activeTurnId || !frozen.capabilities.interrupt : !canStart && !canContinue) return;
    const requestId = crypto.randomUUID();
    setPendingRequest({ id: requestId, kind });
    void perform(async (account, assertCurrent) => {
      await submitNativeWork({ account, command: { requestId, todoId: card.id, sessionId: session.id,
        expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0,
        expectedBindingVersion: frozen.bindingVersion, ...(kind === 'interrupt' ? { nativeTurnId: frozen.activeTurnId } : {}),
        intent: kind === 'interrupt' ? { kind: 'interrupt' } : { kind: 'prompt', text: canContinue ? t('agent.nativeCard.continuePrompt') : card.state.goal!.trim() }, submittedBy: 'user' } });
      assertCurrent(); setNotice(kind === 'interrupt' ? t('agent.nativeCard.stopping') : canContinue ? t('agent.nativeCard.continuing') : t('agent.nativeCard.starting'));
    });
  };
  const answer = (decision: NativeWorkDecision, value: unknown) => {
    if (!canAnswer(decision) || uncertainAnswer === decision.id) return;
    const observed = observation.current;
    setUncertainAnswer(decision.id);
    void perform(async (account, assertCurrent) => {
      const next = await answerNativeWork({ account, sessionId: session.id, decisionId: decision.id,
        expectedBindingVersion: decision.bindingVersion, expectedRequirementsVersion: decision.requirementsVersion,
        nativeTurnId: decision.nativeTurnId, answer: value });
      assertCurrent(); readSequence.current += 1;
      setSnapshot(next);
      if (observed === observation.current) snapshotCallback.current?.(next, observed);
      setUncertainAnswer(null); setNotice(t('agent.nativeCard.replySubmitted'));
    });
  };

  return <div className="work-control-card-actions" aria-label={t('agent.nativeCard.controlsAria', { title: card.title })}>
    {currentDecisions.map(decision => <NativeDecision key={decision.id} decision={decision} current busy={busy || uncertainAnswer === decision.id} onAnswer={value => answer(decision, value)} />)}
    {snapshot?.decisions.some(decision => decision.state === 'unknown') && <p className="text-xs text-ink-2">{t('agent.nativeCard.unknownDecisionHint')}</p>}
    <div className="flex flex-wrap items-center gap-3 text-xs">
      {connected && snapshot?.activeTurnId && snapshot.capabilities.interrupt && <button type="button" disabled={busy || stopping || uncertainStop} onClick={() => submit('interrupt')} className="text-ink-2 disabled:opacity-50">{t('agent.nativeCard.stopTurn')}</button>}
      {(canStart || canContinue) && <button type="button" disabled={busy || pending || preparedPrompt} onClick={() => submit('prompt')} className="rounded-lg bg-primary px-3 py-1.5 text-white disabled:opacity-50">{canContinue ? t('agent.nativeCard.continueWork') : t('agent.nativeCard.startWork')}</button>}
      {onViewResult ? <button type="button" onClick={onViewResult} className="rounded-lg bg-primary px-3 py-1.5 text-white">{t('agent.nativeCard.viewResult')}</button>
        : <button type="button" onClick={onOpen} className="text-primary">{uncertainDelivery ? t('agent.nativeCard.verifyDelivery') : error ? t('agent.nativeCard.verifyConnection') : connected ? t('agent.nativeCard.addRequirement') : t('agent.nativeCard.openWork')}</button>}
    </div>
    {(notice || error) && <p role="status" className="text-xs text-ink-2">{notice || error}</p>}
  </div>;
}
