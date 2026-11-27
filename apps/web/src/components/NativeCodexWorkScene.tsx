import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Send, Square } from 'lucide-react';
import { useT, type MessageKey } from '../i18n';
import { agentDeviceId } from '../agent/device';
import { useStickToBottom } from '../lib/stickToBottom';
import { isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import { findWorkResultReply, pendingInvestigation, unresolvedWorkDelivery } from '../lib/nativeWorkResult';
import { captureButlerAccountGeneration, captureButlerRuntimeAccountContext, subscribeButlerAccountSelection } from '../platform/butlerAccountReady';
import { acpLocalSessionHandoff, answerNativeWork, cancelQueuedNativeWork, createGitCheckpoint, listWorkspaceFiles, readNativeWorkSnapshot, resumeNativeWork, submitNativeWork } from '../platform/desktopCommands';
import { applyComposerReplacement, detectComposerTrigger, type ActiveComposerToken } from '../lib/composerCommands';
import { ButlerComposerFilePopover } from './ButlerComposerPopovers';
import type { NativeDispatchActionRecord, NativeWorkCard, NativeWorkSessionRecord } from '../platform/desktopCommands';
import type { NativeWorkDecision, NativeWorkSnapshot } from '../platform/nativeWorkRuntime';
import type { NativeCodexIntent } from '../platform/workRuntimeContract';
import { useAgentComposerDraft, useAgentComposerDrafts } from '../stores/agentComposerDrafts';
import { useWorkLedger } from '../stores/workLedger';

const STATUS_KEYS = {
  idle: 'agent.nativeScene.status.idle',
  running: 'agent.nativeScene.status.running',
  waiting_input: 'agent.nativeScene.status.waitingInput',
  waiting_approval: 'agent.nativeScene.status.waitingApproval',
  interrupted: 'agent.nativeScene.status.interrupted',
  unknown: 'agent.nativeScene.status.unknown',
} as const satisfies Record<string, MessageKey>;
const textError = (error: unknown) => error instanceof Error ? error.message : String(error);
function commandDetails(command: NativeDispatchActionRecord): { requestId?: string; queueAfterTurn?: boolean; intent?: NativeCodexIntent } {
  try { return JSON.parse(command.specJson); } catch { return {}; }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function NativeDecision({ decision, current, busy, onAnswer }: {
  decision: NativeWorkDecision; current: boolean; busy: boolean; onAnswer: (answer: unknown) => void;
}) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const params = object(decision.params);
  const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
  const userInput = decision.method === 'item/tool/requestUserInput';
  const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(decision.method);
  const permissions = decision.method === 'item/permissions/requestApproval';
  const available = Object.hasOwn(params, 'availableDecisions')
    ? Array.isArray(params.availableDecisions) ? params.availableDecisions.filter((choice): choice is string => typeof choice === 'string') : []
    : ['accept', 'decline'];
  const allowOnce = available.includes('accept');
  const refusal = available.includes('decline') ? 'decline' : available.includes('cancel') ? 'cancel' : null;
  const reason = typeof params.reason === 'string' ? params.reason : null;
  return <section aria-label={t('agent.nativeScene.decision.aria')} data-native-decision-id={decision.id} className={`rounded-xl border border-warning/30 bg-warning/5 p-2.5 ${current ? 'native-work-current-decision' : ''}`}>
    <h4 className="text-sm font-semibold text-ink">{decision.state === 'unknown' ? t('agent.nativeScene.decision.verifyReply') : !current ? t('agent.nativeScene.decision.expired') : userInput ? t('agent.nativeScene.status.waitingInput') : t('agent.nativeScene.status.waitingApproval')}</h4>
    <div className={current ? 'native-work-decision-body' : undefined}>
    {decision.state === 'unknown' && <p className="mt-2 text-sm text-ink-2">{t('agent.nativeScene.decision.unknownHint')}</p>}
    {reason && reason.length <= 240 && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-2">{reason}</p>}
    {typeof params.command === 'string' && <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-4 p-3 text-xs text-ink-2">{params.command}</pre>}
    {approval && decision.method.includes('fileChange') && <p className="mt-2 text-sm text-ink-2">{t('agent.nativeScene.decision.fileChangeHint')}</p>}
    {userInput && questions.map((question, index) => {
      const id = typeof question.id === 'string' ? question.id : String(index);
      const options = Array.isArray(question.options) ? question.options.map(object) : [];
      return <label key={id} className="mt-1.5 block text-sm text-ink-2">
        <span>{String(question.question ?? question.header ?? t('agent.nativeScene.decision.addRequirementFallback'))}</span>
        {options.length > 0 && <select aria-label={String(question.question ?? question.header ?? t('agent.nativeScene.decision.selectAnswerFallback'))} disabled={!current || busy} value={answers[id] ?? ''} onChange={(event) => setAnswers((previous) => ({ ...previous, [id]: event.target.value }))} className="mt-1.5 block w-full rounded-lg border border-line bg-surface-3 px-3 py-1.5">
          <option value="">{t('agent.nativeScene.decision.selectPlaceholder')}</option>{options.map((option) => <option key={String(option.label)} value={String(option.label)}>{String(option.label)}{option.description ? ` · ${String(option.description)}` : ''}</option>)}
        </select>}
        {(options.length === 0 || question.isOther === true) && <input aria-label={String(question.question ?? question.header ?? t('agent.nativeScene.decision.answerFallback'))} type={question.isSecret === true ? 'password' : 'text'} disabled={!current || busy} value={answers[id] ?? ''} onChange={(event) => setAnswers((previous) => ({ ...previous, [id]: event.target.value }))} className="mt-1.5 block w-full rounded-lg border border-line bg-surface-3 px-3 py-1.5" />}
      </label>;
    })}
    {reason && reason.length > 240 && <details className="mt-2 text-sm text-ink-2"><summary className="cursor-pointer text-xs">{t('agent.nativeScene.decision.viewFullReason')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{reason}</p></details>}
    </div>
    <div className="mt-2 flex shrink-0 flex-wrap gap-3 text-sm">
      {approval && <>{allowOnce && <button type="button" disabled={!current || busy} onClick={() => onAnswer({ decision: 'accept' })} className="rounded-lg bg-primary px-3 py-1.5 text-white disabled:opacity-50">{t('agent.nativeScene.decision.allowOnce')}</button>}{refusal && <button type="button" disabled={!current || busy} onClick={() => onAnswer({ decision: refusal })} className="rounded-lg border border-line px-3 py-1.5 text-ink-2 disabled:opacity-50">{refusal === 'cancel' ? t('agent.nativeScene.decision.declineAndStop') : t('agent.nativeScene.decision.decline')}</button>}{!allowOnce && !refusal && <p className="text-ink-3">{t('agent.nativeScene.decision.noSingleOption')}</p>}</>}
      {permissions && <><p className="w-full text-ink-2">{t('agent.nativeScene.decision.permissionsDeclineOnly')}</p><button type="button" disabled={!current || busy} onClick={() => onAnswer({ permissions: {}, scope: 'turn' })} className="rounded-lg border border-line px-3 py-1.5 text-ink-2 disabled:opacity-50">{t('agent.nativeScene.decision.declinePermissions')}</button></>}
      {userInput && <button type="button" disabled={!current || busy || questions.length === 0 || questions.some((question, index) => !answers[typeof question.id === 'string' ? question.id : String(index)]?.trim())} onClick={() => onAnswer({ answers: Object.fromEntries(questions.map((question, index) => { const id = typeof question.id === 'string' ? question.id : String(index); return [id, { answers: [answers[id]] }]; })) })} className="rounded-lg bg-primary px-3 py-1.5 text-white disabled:opacity-50">{t('agent.nativeScene.decision.submitAnswer')}</button>}
      {!approval && !permissions && !userInput && <p className="text-ink-3">{t('agent.nativeScene.decision.unsupportedType')}</p>}
    </div>
  </section>;
}

export interface NativeCodexWorkSceneProps {
  card: NativeWorkCard;
  session: NativeWorkSessionRecord;
  onViewHistory: () => void;
  onViewResults: () => void;
  fillHeight?: boolean;
  requirements?: ReactNode;
  resultTurnId?: string;
  resultRequest?: object;
}

export default function NativeCodexWorkScene({ card, session, onViewHistory, onViewResults, fillHeight = false, requirements, resultTurnId, resultRequest }: NativeCodexWorkSceneProps) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<NativeWorkSnapshot | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<{ id: string; kind: NativeCodexIntent['kind'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const evidences = useWorkLedger((state) => state.evidences);
  const sceneRef = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  const reading = useRef(false);
  const operation = useRef(false);
  const requestSequence = useRef(0);
  const ledgerRefresh = useRef<{ epoch: number; promise: Promise<void> } | null>(null);
  const ledgerSignature = useRef<string | null>(null);
  let accountScope = session.accountScope;
  if (!accountScope) { try { accountScope = captureButlerRuntimeAccountContext().accountScope; } catch { /* Wait for the selected account before sending. */ } }
  const target = { kind: 'native-work' as const, scope: accountScope ?? 'unselected-account', workspaceRoot: session.workspaceRoot, recipientId: session.id };
  const { key: composerKey, draft } = useAgentComposerDraft(target);
  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([snapshot?.cursor, snapshot?.messages], composerKey);
  const refreshLedger = useCallback(async () => {
    const currentEpoch = epoch.current;
    const accountGuard = captureButlerAccountGeneration();
    const account = captureButlerRuntimeAccountContext();
    if (session.accountScope && session.accountScope !== account.accountScope) throw new Error(t('agent.nativeScene.guard.wrongAccount'));
    if (ledgerRefresh.current?.epoch !== currentEpoch) {
      const promise = useWorkLedger.getState().hydrate();
      ledgerRefresh.current = { epoch: currentEpoch, promise };
      void promise.finally(() => { if (ledgerRefresh.current?.promise === promise) ledgerRefresh.current = null; }).catch(() => {});
    }
    await ledgerRefresh.current.promise;
    accountGuard();
    if (currentEpoch !== epoch.current) throw new Error(t('agent.nativeScene.guard.unpublishedSwitch'));
    if (useWorkLedger.getState().lastError) throw new Error(useWorkLedger.getState().lastError!);
  }, [session.accountScope]);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const currentEpoch = epoch.current;
    const sequence = ++requestSequence.current;
    try {
      const account = captureButlerRuntimeAccountContext();
      if (session.accountScope && session.accountScope !== account.accountScope) throw new Error(t('agent.nativeScene.guard.wrongAccount'));
      const next = await readNativeWorkSnapshot({ account, sessionId: session.id });
      if (currentEpoch !== epoch.current || sequence !== requestSequence.current) return;
      if (next.protocolVersion !== 1 || next.todoId !== card.id || next.sessionId !== session.id || next.nativeThreadId !== session.nativeSessionId) throw new Error(t('agent.nativeScene.guard.protocolMismatch'));
      setSnapshot(next); setReadError(null);
    } catch (cause) { if (currentEpoch === epoch.current && sequence === requestSequence.current) setReadError(textError(cause)); }
    finally { reading.current = false; }
  }, [card.id, session.id, session.nativeSessionId, session.accountScope]);
  useEffect(() => {
    epoch.current += 1; requestSequence.current += 1;
    setSnapshot(null); setActionError(null); setReadError(null); setNotice(null); setLastRequest(null); setConfirmed(false); setBusy(false); operation.current = false; ledgerSignature.current = null;
    const unsubscribe = subscribeButlerAccountSelection(() => {
      epoch.current += 1; requestSequence.current += 1; setSnapshot(null); setActionError(null); setReadError(null); setLastRequest(null); setBusy(false); operation.current = false; ledgerSignature.current = null;
    });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { epoch.current += 1; requestSequence.current += 1; clearInterval(timer); unsubscribe(); };
  }, [refresh]);
  // Streaming text advances the provider cursor, but only changed work facts need a full ledger read.
  const projectionSignature = snapshot ? JSON.stringify([snapshot.bindingVersion, snapshot.connectionStatus, snapshot.runtimeStatus, snapshot.activeTurnId,
    snapshot.commands.map((command) => [command.id, command.state]), snapshot.decisions.map((decision) => [decision.id, decision.state])]) : null;
  useEffect(() => {
    if (!projectionSignature || projectionSignature === ledgerSignature.current) return;
    const currentEpoch = epoch.current;
    const timer = setTimeout(() => {
      void refreshLedger().then(() => { if (currentEpoch === epoch.current) ledgerSignature.current = projectionSignature; })
        .catch((cause) => { if (currentEpoch === epoch.current) setReadError(textError(cause)); });
    }, 250);
    return () => clearTimeout(timer);
  }, [projectionSignature, refreshLedger]);

  const act = async (action: (account: ReturnType<typeof captureButlerRuntimeAccountContext>, assertCurrent: () => void) => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setActionError(null); setNotice(null); setLastRequest(null);
    const currentEpoch = epoch.current;
    const accountGuard = captureButlerAccountGeneration();
    const assertCurrent = () => { accountGuard(); if (currentEpoch !== epoch.current) throw new Error(t('agent.nativeScene.guard.switchedNoImpact')); };
    try { await action(captureButlerRuntimeAccountContext(), assertCurrent); assertCurrent(); }
    catch (cause) { if (currentEpoch === epoch.current) setActionError(textError(cause)); }
    finally { if (currentEpoch === epoch.current) { operation.current = false; setBusy(false); void refresh(); } }
  };
  const resume = () => void act(async (account, assertCurrent) => {
    if (!snapshot?.capabilities.resume || !confirmed) return;
    const authorization = await acpLocalSessionHandoff({ sessionId: session.nativeSessionId, sourceScope: snapshot.sourceScope, accountScope: account.accountScope, hostDeviceId: agentDeviceId(), workspaceRoot: session.workspaceRoot, profileId: snapshot.executionProfileId });
    assertCurrent();
    const next = await resumeNativeWork({ account, sessionId: session.id, todoId: card.id, expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0, expectedBindingVersion: snapshot.bindingVersion, authorization });
    assertCurrent(); await refreshLedger();
    assertCurrent(); requestSequence.current += 1; setSnapshot(next); setConfirmed(false);
    setNotice(next.connectionStatus === 'connected' ? t('agent.nativeScene.notice.resumedConnected') : t('agent.nativeScene.notice.resumedChecking'));
  });
  const unresolved = unresolvedWorkDelivery(snapshot?.commands ?? [], card.id, session.id);
  const uncertainStop = Boolean(unresolvedWorkDelivery(snapshot?.commands ?? [], card.id, session.id, 'session_interrupt'));
  const unresolvedIntent = unresolved && commandDetails(unresolved).intent;
  const starting = pendingInvestigation(snapshot);
  const sendBlockedReason = card.state.stage === 'done' ? t('agent.nativeScene.blocked.done')
    : card.state.waitState === 'canceled' ? t('agent.nativeScene.blocked.canceled')
    : card.state.waitState === 'paused' ? t('agent.nativeScene.blocked.paused')
    : card.state.autonomyMode === 'readonly' ? t('agent.nativeScene.blocked.readonly')
    : unresolved ? t('agent.nativeScene.blocked.unresolved') : starting;
  const send = (immediatelyAdjust = false) => {
    if (sendBlockedReason || !snapshot || operation.current || draft.pending || draft.images.length || snapshot.connectionStatus !== 'connected') return;
    try {
      const account = captureButlerRuntimeAccountContext();
      if (session.accountScope && session.accountScope !== account.accountScope) throw new Error(t('agent.nativeScene.guard.wrongAccount'));
    } catch (cause) { setActionError(textError(cause)); return; }
    const running = Boolean(snapshot.activeTurnId);
    if (immediatelyAdjust ? !running || !snapshot.capabilities.steer : !snapshot.capabilities.prompt) return;
    const request = useAgentComposerDrafts.getState().begin(target, { mode: immediatelyAdjust ? 'steer' : 'queue' });
    if (!request) return;
    const frozen = snapshot;
    void act(async (account, assertCurrent) => {
      let submitted = false;
      try {
        const intent: NativeCodexIntent = immediatelyAdjust ? { kind: 'steer', text: request.text } : { kind: 'prompt', text: request.text };
        setLastRequest({ id: request.id, kind: intent.kind });
        submitted = true;
        await submitNativeWork({ account, command: { requestId: request.id, todoId: card.id, sessionId: session.id, expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0, expectedBindingVersion: frozen.bindingVersion, ...(intent.kind === 'steer' ? { nativeTurnId: frozen.activeTurnId } : {}), ...(running && !immediatelyAdjust ? { queueAfterTurn: true } : {}), intent, submittedBy: 'user' } });
        assertCurrent(); useAgentComposerDrafts.getState().finish(composerKey, request.id); await refreshLedger(); assertCurrent();
        stickToBottom.current = true;
        setNotice(running && !immediatelyAdjust ? t('agent.nativeScene.notice.queued') : t('agent.nativeScene.notice.recordedWaiting'));
      } catch (cause) {
        useAgentComposerDrafts.getState().finish(composerKey, request.id, cause, submitted);
        throw cause;
      }
    });
  };
  const stop = () => void act(async (account, assertCurrent) => {
    if (!snapshot?.activeTurnId || !snapshot.capabilities.interrupt || uncertainStop) return;
    const requestId = crypto.randomUUID(); setLastRequest({ id: requestId, kind: 'interrupt' });
    await submitNativeWork({ account, command: { requestId, todoId: card.id, sessionId: session.id, expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0, expectedBindingVersion: snapshot.bindingVersion, nativeTurnId: snapshot.activeTurnId, intent: { kind: 'interrupt' }, submittedBy: 'user' } });
    assertCurrent(); await refreshLedger();
    assertCurrent(); setNotice(t('agent.nativeScene.notice.stopRecorded'));
  });
  const answer = (decision: NativeWorkDecision, value: unknown) => void act(async (account, assertCurrent) => {
    const next = await answerNativeWork({ account, sessionId: session.id, decisionId: decision.id, expectedBindingVersion: decision.bindingVersion, expectedRequirementsVersion: decision.requirementsVersion, nativeTurnId: decision.nativeTurnId, answer: value });
    assertCurrent(); await refreshLedger();
    assertCurrent(); requestSequence.current += 1; setSnapshot(next); setNotice(t('agent.nativeScene.notice.answerSubmitted'));
  });
  const cancelQueued = (requestId: string) => void act(async (account, assertCurrent) => {
    await cancelQueuedNativeWork({ account, sessionId: session.id, requestId });
    assertCurrent(); await refreshLedger();
    assertCurrent(); setNotice(t('agent.nativeScene.notice.withdrawn'));
  });
  const running = Boolean(snapshot?.activeTurnId);
  const nativeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [fileToken, setFileToken] = useState<ActiveComposerToken | null>(null);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileActiveIdx, setFileActiveIdx] = useState(0);

  useEffect(() => {
    if (!fileToken || !isTauriRuntime() || !session.workspaceRoot?.trim()) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    void listWorkspaceFiles(session.workspaceRoot, fileToken.query, 30)
      .then((list) => {
        if (!cancelled) {
          setFileMatches(list);
          setFileActiveIdx(0);
        }
      })
      .catch(() => {
        if (!cancelled) setFileMatches([]);
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => { cancelled = true; };
  }, [fileToken, session.workspaceRoot]);

  const applyNativeFileChoice = (relPath: string) => {
    if (!fileToken) return;
    const { nextText, nextCursor } = applyComposerReplacement(draft.text, fileToken, `@${relPath}`);
    useAgentComposerDrafts.getState().edit(composerKey, { text: nextText });
    setFileToken(null);
    requestAnimationFrame(() => {
      nativeTextareaRef.current?.focus();
      nativeTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const prevTurnIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevTurnIdRef.current;
    const next = snapshot?.activeTurnId ?? null;
    prevTurnIdRef.current = next;
    if (prev && !next && snapshot?.runtimeStatus !== 'interrupted' && isTauriRuntime() && session.workspaceRoot?.trim()) {
      void createGitCheckpoint(session.workspaceRoot, t('agent.diff.turnCheckpointLabel'), prev).catch(() => undefined);
    }
  }, [session.workspaceRoot, snapshot?.activeTurnId, snapshot?.runtimeStatus, t]);
  const connected = snapshot?.connectionStatus === 'connected';
  const queued = snapshot?.commands.flatMap((command) => { const details = commandDetails(command); return command.state === 'prepared' && details.queueAfterTurn && details.requestId ? [{ command, details }] : []; }) ?? [];
  const decisions = snapshot?.decisions.filter((decision) => decision.state === 'pending' || decision.state === 'unknown') ?? [];
  const canAnswerDecision = (decision: NativeWorkDecision) => Boolean(connected && snapshot?.capabilities.answer && decision.state === 'pending' && decision.nativeThreadId === snapshot.nativeThreadId && decision.nativeTurnId === snapshot.activeTurnId && decision.bindingVersion === snapshot.bindingVersion && decision.requirementsVersion === (card.state.requirementsVersion ?? 0));
  const currentDecisions = decisions.filter(canAnswerDecision);
  const historicalDecisions = decisions.filter((decision) => !canAnswerDecision(decision));
  const latestReply = snapshot?.messages.slice().reverse().find((message) => message.role === 'assistant' && message.text.trim());
  const hasEvidence = evidences.some((evidence) => evidence.todoId === card.id);
  const revealReply = (id: string) => {
    sceneRef.current?.querySelector<HTMLElement>(`[data-native-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
  };
  const resultReply = resultTurnId ? findWorkResultReply(snapshot, card, resultTurnId) : undefined;
  const revealed = useRef<{ id: string; request?: object }>();
  useEffect(() => {
    if (!resultReply || readError) { revealed.current = undefined; return; }
    if (revealed.current?.id !== resultReply.id || revealed.current.request !== resultRequest) {
      revealReply(resultReply.id);
      revealed.current = { id: resultReply.id, request: resultRequest };
    }
  }, [resultReply?.id, readError, resultRequest]);
  const viewResults = () => {
    if (hasEvidence) { onViewResults(); return; }
    if (latestReply) revealReply(latestReply.id);
    else setNotice(t('agent.nativeScene.notice.emptyHistory'));
  };
  const lastCommand = lastRequest ? snapshot?.commands.find((command) => commandDetails(command).requestId === lastRequest.id) : null;
  let currentNotice = notice;
  if (lastCommand) {
    if (snapshot?.runtimeStatus === 'interrupted' || (lastRequest?.kind === 'interrupt' && lastCommand.state === 'completed')) currentNotice = t('agent.nativeScene.statusNotice.stopped');
    else if (lastCommand.state === 'completed') currentNotice = t('agent.nativeScene.statusNotice.completedUnverified');
    else if (lastCommand.state === 'failed') currentNotice = lastCommand.errorMessage || t('agent.nativeScene.statusNotice.failedFallback');
    else if (lastCommand.state === 'canceled') currentNotice = t('agent.nativeScene.statusNotice.canceled');
    else if (lastCommand.state === 'verifying_delivery') currentNotice = null;
    else if (lastRequest?.kind === 'interrupt') currentNotice = t('agent.nativeScene.notice.stopRecorded');
    else if (lastCommand.state === 'acknowledged') currentNotice = t('agent.nativeScene.statusNotice.acknowledged');
    else if (lastCommand.state === 'awaiting_approval') currentNotice = t('agent.nativeScene.statusNotice.awaitingApproval');
    else if (lastCommand.state === 'dispatched') currentNotice = t('agent.nativeScene.statusNotice.dispatched');
    else currentNotice = commandDetails(lastCommand).queueAfterTurn ? t('agent.nativeScene.notice.queued') : t('agent.nativeScene.statusNotice.queuedWaiting');
  }
  const sendingDisabled = Boolean(sendBlockedReason) || !connected || busy || Boolean(draft.pending) || !draft.loaded || !draft.text.trim() || draft.images.length > 0;
  const connectionLabel = !snapshot ? t('agent.nativeScene.conn.reading') : !connected
    ? snapshot.connectionStatus === 'connecting' ? t('agent.nativeScene.conn.connecting') : t('agent.nativeScene.conn.disconnected')
    : starting || (snapshot.runtimeStatus === 'idle' && lastRequest?.kind !== 'interrupt' && lastCommand?.state === 'prepared')
      ? t('agent.nativeScene.conn.waitingStart') : t(STATUS_KEYS[snapshot.runtimeStatus]);
  return <section ref={sceneRef} aria-label={t('agent.nativeScene.header.aria')} className={`min-w-0 bg-surface-3 ${fillHeight ? 'native-work-scene-fill' : 'space-y-4 rounded-xl border border-line p-4'}`}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className={fillHeight ? 'sr-only' : 'text-sm font-semibold text-ink'}>{t('agent.nativeScene.header.title')}</h3><p role="status" title={snapshot?.runtimeVersion ? t('agent.nativeScene.header.runtimeVersion', { version: snapshot.runtimeVersion }) : undefined} className="mt-1 text-xs text-ink-3">{t('agent.nativeScene.header.statusLine', { state: unresolved ? t('agent.nativeScene.header.verifyDelivery') : connectionLabel })}</p></div>
      <div className="flex flex-wrap gap-4 text-xs"><button type="button" onClick={viewResults} className="text-primary hover:underline">{t('agent.nativeScene.header.viewOutcomes')}</button><button type="button" onClick={onViewHistory} className="text-ink-3 hover:text-primary">{t('agent.nativeScene.header.originalHistory')}</button></div>
    </header>
    {snapshot?.admissionWait && sendBlockedReason !== snapshot.admissionWait.message && <p role="status" className="shrink-0 text-xs text-ink-2">{snapshot.admissionWait.message}</p>}
    {resultTurnId !== undefined && snapshot && !readError && !resultReply && <p role="status" className="shrink-0 text-xs text-ink-2">{t('agent.nativeScene.resultUnverifiable')}</p>}
    {currentDecisions.length > 0 && <div aria-label={t('agent.nativeScene.currentDecisionsAria')} role="region" className="native-work-current-decisions space-y-2">{currentDecisions.map((decision) => <NativeDecision key={decision.id} decision={decision} current busy={busy} onAnswer={(value) => answer(decision, value)} />)}</div>}
    <div ref={fillHeight ? scrollRef : undefined} onScroll={fillHeight ? onScroll : undefined} aria-label={fillHeight ? t('agent.nativeScene.contentAria') : undefined} className={fillHeight ? 'native-work-scene-content' : 'space-y-4'}>
    {requirements}
    {unresolved && <div role="region" aria-label={t('agent.nativeScene.unresolved.aria')} className="space-y-1 rounded-lg border border-warning/30 p-2.5 text-sm text-ink-2">
      <p className="font-medium text-ink">{unresolved.actionKind === 'session_interrupt' ? t('agent.nativeScene.unresolved.stop') : unresolved.actionKind === 'session_resume' ? t('agent.nativeScene.unresolved.resume') : t('agent.nativeScene.unresolved.delivery')}</p>
      {unresolvedIntent && typeof unresolvedIntent === 'object' && 'text' in unresolvedIntent && typeof unresolvedIntent.text === 'string'
        && <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{unresolvedIntent.text}</p>}
      <button type="button" onClick={onViewHistory} className="text-xs text-primary hover:underline">{t('agent.nativeScene.unresolved.checkHistory')}</button>
    </div>}
    {(actionError || readError || snapshot?.error) && <div role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{actionError || readError || snapshot?.error}<button type="button" onClick={() => void refresh()} className="ml-3 underline">{t('agent.nativeScene.recheck')}</button></div>}
    {!connected && snapshot && <div className="space-y-3 text-sm text-ink-2">
      <p>{t('agent.nativeScene.resume.desc')}</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t('agent.nativeScene.resume.confirmCheckbox')}</label>
      <button type="button" disabled={!confirmed || !snapshot.capabilities.resume || busy} onClick={resume} className="rounded-lg bg-primary px-4 py-2.5 font-medium text-white disabled:opacity-50">{busy ? t('agent.nativeScene.resume.resuming') : t('agent.nativeScene.resume.continueHere')}</button>
      {!snapshot.capabilities.resume && <p className="text-xs text-ink-3">{snapshot.error ?? t('agent.nativeScene.resume.unavailableFallback')}</p>}
    </div>}
    {snapshot?.messages.length ? <div ref={fillHeight ? undefined : scrollRef} onScroll={fillHeight ? undefined : onScroll} aria-label={t('agent.nativeScene.messages.aria')} className={`native-work-messages space-y-4 ${fillHeight ? '' : 'max-h-[420px] overflow-y-auto rounded-lg border border-line p-3'}`}>
      {snapshot.historyTruncated && <p className="text-xs text-ink-3">{t('agent.nativeScene.messages.truncated')}</p>}
      {snapshot.messages.map((message) => <article key={message.id} data-native-message-id={message.id} className={message.role === 'user' ? 'ml-5 rounded-lg bg-primary/10 p-3' : 'mr-2 p-1'}><p className="mb-1 text-xs font-medium text-ink-3">{message.role === 'user' ? t('agent.sessionPreview.youSpeaker') : message.id === latestReply?.id ? t('agent.nativeScene.messages.latestReply') : 'Codex'}{message.streaming ? t('agent.nativeScene.messages.streamingSuffix') : ''}</p>{message.role === 'assistant' ? <div className="native-work-markdown break-words text-sm leading-relaxed text-ink">{renderMarkdownDoc(message.text, undefined, (label, href) => /^https?:\/\//i.test(href) ? undefined : <span title={href}>{label}</span>)}</div> : <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{message.text}</div>}</article>)}
    </div> : connected ? <p className="text-sm text-ink-3">{t('agent.nativeScene.messages.emptyConnected')}</p> : null}
    {historicalDecisions.length > 0 && <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-xs text-ink-3">{t('agent.nativeScene.historicalDecisions', { count: historicalDecisions.length })}</summary><div className="mt-3 space-y-3">{historicalDecisions.map((decision) => <NativeDecision key={decision.id} decision={decision} current={false} busy={busy} onAnswer={(value) => answer(decision, value)} />)}</div></details>}
    {queued.length > 0 && <section aria-label={t('agent.nativeScene.queued.aria')} className="rounded-lg border border-line p-3"><h4 className="text-xs font-medium text-ink-3">{t('agent.nativeScene.queued.heading', { count: queued.length })}</h4><ul className="mt-2 space-y-2">{queued.map(({ command, details }) => <li key={command.id} className="flex items-start gap-3 text-sm"><span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink-2">{details.intent && 'text' in details.intent ? details.intent.text : t('agent.nativeScene.queued.fallback')}</span><button type="button" disabled={busy} onClick={() => cancelQueued(details.requestId!)} className="shrink-0 text-primary disabled:opacity-50">{t('agent.nativeScene.queued.withdraw')}</button></li>)}</ul></section>}
    {draft.failed.map((request) => <div key={request.id} role="alert" className="rounded-lg border border-warning/30 p-3 text-xs text-ink-2"><p>{request.requiresVerification ? t('agent.nativeScene.draft.verifyRequired') : t('agent.nativeScene.draft.sendFailed')} {request.error}</p><p className="mt-1 whitespace-pre-wrap break-words">{request.text}</p><button type="button" onClick={onViewHistory} className="mt-2 text-primary">{t('agent.nativeScene.draft.checkHistory')}</button></div>)}
    </div>
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        e.preventDefault();
        const refs = files.map((f) => `@${f.name}`).join(' ');
        const cur = draft.text.trimEnd();
        useAgentComposerDrafts.getState().edit(composerKey, { text: cur ? `${cur} ${refs} ` : `${refs} ` });
      }}
      className="native-work-composer space-y-2 rounded-xl border border-line bg-surface-4 p-3"
    >
      {sendBlockedReason ? <p role="status" className="text-xs text-ink-2">{sendBlockedReason}</p>
        : running && <p className="text-xs text-ink-3">{t('agent.nativeScene.composer.runningHint')}</p>}
      <ButlerComposerFilePopover
        open={Boolean(fileToken)}
        loading={fileLoading}
        files={fileMatches}
        activeIndex={fileActiveIdx}
        onSelect={applyNativeFileChoice}
      />
      <textarea
        ref={nativeTextareaRef}
        aria-label={t('agent.nativeScene.composer.aria')}
        data-work-composer="native-work"
        data-work-session-id={session.nativeSessionId}
        value={draft.text}
        onChange={(event) => {
          const val = event.target.value;
          const pos = event.target.selectionStart ?? val.length;
          const tok = detectComposerTrigger(val, pos);
          setFileToken(tok?.kind === 'file' ? tok : null);
          useAgentComposerDrafts.getState().edit(composerKey, { text: val });
        }}
        onKeyDown={(event) => {
          if (fileToken) {
            if (event.key === 'ArrowDown' && fileMatches.length > 0) {
              event.preventDefault();
              setFileActiveIdx((i) => (i + 1) % fileMatches.length);
              return;
            }
            if (event.key === 'ArrowUp' && fileMatches.length > 0) {
              event.preventDefault();
              setFileActiveIdx((i) => (i - 1 + fileMatches.length) % fileMatches.length);
              return;
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && fileMatches[fileActiveIdx]) {
              event.preventDefault();
              applyNativeFileChoice(fileMatches[fileActiveIdx]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setFileToken(null);
              return;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            send();
          }
        }}
        rows={fillHeight ? 2 : 3}
        placeholder={connected ? t('agent.nativeScene.composer.placeholderConnected') : t('agent.nativeScene.composer.placeholderDisconnected')}
        className={`block w-full border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3 ${fillHeight ? 'resize-none' : 'resize-y'}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-ink-3">{draft.saveError ?? (draft.loaded ? t('agent.nativeScene.composer.draftSaved') : t('agent.nativeScene.composer.draftLoading'))}</span><div className="flex flex-wrap items-center gap-3">{running && <><button type="button" disabled={busy || !snapshot?.capabilities.interrupt || !connected || uncertainStop} onClick={stop} className="inline-flex items-center gap-1.5 text-xs text-ink-2 disabled:opacity-50"><Square size={12} />{t('agent.nativeCard.stopTurn')}</button>{snapshot?.capabilities.steer && <button type="button" disabled={sendingDisabled} onClick={() => send(true)} className="text-xs text-primary disabled:opacity-50" title={t('agent.nativeScene.composer.steerTitle')}>{t('agent.nativeScene.composer.steer')}</button>}</>}<button type="button" disabled={sendingDisabled || !snapshot?.capabilities.prompt} onClick={() => send()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}{t('agent.nativeScene.composer.send')}</button></div></div>
      {draft.images.length > 0 && <p className="text-xs text-warning">{t('agent.nativeScene.composer.attachmentsUnsupported')}</p>}
    </div>
    {currentNotice && <p role="status" className="native-work-scene-notice text-xs text-ink-2">{currentNotice}</p>}
  </section>;
}
