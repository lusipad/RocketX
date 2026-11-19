import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Send, Square } from 'lucide-react';
import { agentDeviceId } from '../agent/device';
import { useStickToBottom } from '../lib/stickToBottom';
import { renderMarkdownDoc } from '../lib/markdown';
import { findWorkResultReply, pendingInvestigation, unresolvedWorkDelivery } from '../lib/nativeWorkResult';
import { captureButlerAccountGeneration, captureButlerRuntimeAccountContext, subscribeButlerAccountSelection } from '../platform/butlerAccountReady';
import { acpLocalSessionHandoff, answerNativeWork, cancelQueuedNativeWork, readNativeWorkSnapshot, resumeNativeWork, submitNativeWork } from '../platform/desktopCommands';
import type { NativeDispatchActionRecord, NativeWorkCard, NativeWorkSessionRecord } from '../platform/desktopCommands';
import type { NativeWorkDecision, NativeWorkSnapshot } from '../platform/nativeWorkRuntime';
import type { NativeCodexIntent } from '../platform/workRuntimeContract';
import { useAgentComposerDraft, useAgentComposerDrafts } from '../stores/agentComposerDrafts';
import { useWorkLedger } from '../stores/workLedger';

const STATUS = { idle: '可以继续交代', running: '正在执行', waiting_input: '需要你补充', waiting_approval: '需要你决定', interrupted: '本轮已停止', unknown: '执行状态待核对' };
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
  return <section aria-label="执行者需要你决定" data-native-decision-id={decision.id} className={`rounded-xl border border-warning/30 bg-warning/5 p-2.5 ${current ? 'native-work-current-decision' : ''}`}>
    <h4 className="text-sm font-semibold text-ink">{decision.state === 'unknown' ? '答复结果待核对' : !current ? '这条请求已失效' : userInput ? '需要你补充' : '需要你决定'}</h4>
    <div className={current ? 'native-work-decision-body' : undefined}>
    {decision.state === 'unknown' && <p className="mt-2 text-sm text-ink-2">答复可能已经送达，请先核对原端结果；不会重复回答。</p>}
    {reason && reason.length <= 240 && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-2">{reason}</p>}
    {typeof params.command === 'string' && <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-4 p-3 text-xs text-ink-2">{params.command}</pre>}
    {approval && decision.method.includes('fileChange') && <p className="mt-2 text-sm text-ink-2">执行者申请修改工作区文件，请核对本轮要求后决定。</p>}
    {userInput && questions.map((question, index) => {
      const id = typeof question.id === 'string' ? question.id : String(index);
      const options = Array.isArray(question.options) ? question.options.map(object) : [];
      return <label key={id} className="mt-1.5 block text-sm text-ink-2">
        <span>{String(question.question ?? question.header ?? '补充要求')}</span>
        {options.length > 0 && <select aria-label={String(question.question ?? question.header ?? '选择回答')} disabled={!current || busy} value={answers[id] ?? ''} onChange={(event) => setAnswers((previous) => ({ ...previous, [id]: event.target.value }))} className="mt-1.5 block w-full rounded-lg border border-line bg-surface-3 px-3 py-1.5">
          <option value="">请选择</option>{options.map((option) => <option key={String(option.label)} value={String(option.label)}>{String(option.label)}{option.description ? ` · ${String(option.description)}` : ''}</option>)}
        </select>}
        {(options.length === 0 || question.isOther === true) && <input aria-label={String(question.question ?? question.header ?? '回答')} type={question.isSecret === true ? 'password' : 'text'} disabled={!current || busy} value={answers[id] ?? ''} onChange={(event) => setAnswers((previous) => ({ ...previous, [id]: event.target.value }))} className="mt-1.5 block w-full rounded-lg border border-line bg-surface-3 px-3 py-1.5" />}
      </label>;
    })}
    {reason && reason.length > 240 && <details className="mt-2 text-sm text-ink-2"><summary className="cursor-pointer text-xs">查看完整说明</summary><p className="mt-2 whitespace-pre-wrap break-words">{reason}</p></details>}
    </div>
    <div className="mt-2 flex shrink-0 flex-wrap gap-3 text-sm">
      {approval && <>{allowOnce && <button type="button" disabled={!current || busy} onClick={() => onAnswer({ decision: 'accept' })} className="rounded-lg bg-primary px-3 py-1.5 text-white disabled:opacity-50">允许本次操作</button>}{refusal && <button type="button" disabled={!current || busy} onClick={() => onAnswer({ decision: refusal })} className="rounded-lg border border-line px-3 py-1.5 text-ink-2 disabled:opacity-50">{refusal === 'cancel' ? '拒绝并结束本轮' : '拒绝'}</button>}{!allowOnce && !refusal && <p className="text-ink-3">当前请求没有可支持的单次允许或拒绝选项，请在原端处理。</p>}</>}
      {permissions && <><p className="w-full text-ink-2">这类权限目前仅支持拒绝；不会自动授予额外权限。</p><button type="button" disabled={!current || busy} onClick={() => onAnswer({ permissions: {}, scope: 'turn' })} className="rounded-lg border border-line px-3 py-1.5 text-ink-2 disabled:opacity-50">拒绝额外权限</button></>}
      {userInput && <button type="button" disabled={!current || busy || questions.length === 0 || questions.some((question, index) => !answers[typeof question.id === 'string' ? question.id : String(index)]?.trim())} onClick={() => onAnswer({ answers: Object.fromEntries(questions.map((question, index) => { const id = typeof question.id === 'string' ? question.id : String(index); return [id, { answers: [answers[id]] }]; })) })} className="rounded-lg bg-primary px-3 py-1.5 text-white disabled:opacity-50">提交回答</button>}
      {!approval && !permissions && !userInput && <p className="text-ink-3">当前版本不能处理这类请求，请查看原对话。</p>}
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
    if (session.accountScope && session.accountScope !== account.accountScope) throw new Error('这条工作属于原账号，请切回原账号继续');
    if (ledgerRefresh.current?.epoch !== currentEpoch) {
      const promise = useWorkLedger.getState().hydrate();
      ledgerRefresh.current = { epoch: currentEpoch, promise };
      void promise.finally(() => { if (ledgerRefresh.current?.promise === promise) ledgerRefresh.current = null; }).catch(() => {});
    }
    await ledgerRefresh.current.promise;
    accountGuard();
    if (currentEpoch !== epoch.current) throw new Error('工作或账号已切换，旧工作记录未发布');
    if (useWorkLedger.getState().lastError) throw new Error(useWorkLedger.getState().lastError!);
  }, [session.accountScope]);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const currentEpoch = epoch.current;
    const sequence = ++requestSequence.current;
    try {
      const account = captureButlerRuntimeAccountContext();
      if (session.accountScope && session.accountScope !== account.accountScope) throw new Error('这条工作属于原账号，请切回原账号继续');
      const next = await readNativeWorkSnapshot({ account, sessionId: session.id });
      if (currentEpoch !== epoch.current || sequence !== requestSequence.current) return;
      if (next.protocolVersion !== 1 || next.todoId !== card.id || next.sessionId !== session.id || next.nativeThreadId !== session.nativeSessionId) throw new Error('原生工作身份或协议不匹配，请重新打开原工作');
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
    const assertCurrent = () => { accountGuard(); if (currentEpoch !== epoch.current) throw new Error('工作或账号已切换，原操作不再影响当前工作'); };
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
    setNotice(next.connectionStatus === 'connected' ? '已接续原会话，可以在下面继续交代。' : '接续请求已记下，正在核对原会话状态。');
  });
  const unresolved = unresolvedWorkDelivery(snapshot?.commands ?? [], card.id, session.id);
  const uncertainStop = Boolean(unresolvedWorkDelivery(snapshot?.commands ?? [], card.id, session.id, 'session_interrupt'));
  const unresolvedIntent = unresolved && commandDetails(unresolved).intent;
  const starting = pendingInvestigation(snapshot);
  const sendBlockedReason = card.state.stage === 'done' ? '这项工作已标记完成，返工后可发送新要求。'
    : card.state.waitState === 'canceled' ? '这项工作已取消，无法发送新要求。'
    : card.state.waitState === 'paused' ? '这项工作已暂停，恢复后可发送新要求。'
    : card.state.autonomyMode === 'readonly' ? '这项工作为只读，无法发送新要求。'
    : unresolved ? '上次操作的送达结果待核对，新的要求会保留为草稿。' : starting;
  const send = (immediatelyAdjust = false) => {
    if (sendBlockedReason || !snapshot || operation.current || draft.pending || draft.images.length || snapshot.connectionStatus !== 'connected') return;
    try {
      const account = captureButlerRuntimeAccountContext();
      if (session.accountScope && session.accountScope !== account.accountScope) throw new Error('这条工作属于原账号，请切回原账号继续');
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
        setNotice(running && !immediatelyAdjust ? '要求已排队，本轮结束后发送；可以在下方撤回。' : '要求已记下，正在等待原端确认。');
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
    assertCurrent(); setNotice('停止请求已记下，正在等待本轮终止回执。');
  });
  const answer = (decision: NativeWorkDecision, value: unknown) => void act(async (account, assertCurrent) => {
    const next = await answerNativeWork({ account, sessionId: session.id, decisionId: decision.id, expectedBindingVersion: decision.bindingVersion, expectedRequirementsVersion: decision.requirementsVersion, nativeTurnId: decision.nativeTurnId, answer: value });
    assertCurrent(); await refreshLedger();
    assertCurrent(); requestSequence.current += 1; setSnapshot(next); setNotice('回答已提交，等待执行者继续。');
  });
  const cancelQueued = (requestId: string) => void act(async (account, assertCurrent) => {
    await cancelQueuedNativeWork({ account, sessionId: session.id, requestId });
    assertCurrent(); await refreshLedger();
    assertCurrent(); setNotice('已撤回这条尚未发送的要求。');
  });
  const running = Boolean(snapshot?.activeTurnId);
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
    else setNotice('还没有回复或验证记录，交代下一步后会显示在这里。');
  };
  const lastCommand = lastRequest ? snapshot?.commands.find((command) => commandDetails(command).requestId === lastRequest.id) : null;
  let currentNotice = notice;
  if (lastCommand) {
    if (snapshot?.runtimeStatus === 'interrupted' || (lastRequest?.kind === 'interrupt' && lastCommand.state === 'completed')) currentNotice = '本轮已停止；这项工作尚未验收。';
    else if (lastCommand.state === 'completed') currentNotice = '本轮回复已结束；最近回复尚未核验。';
    else if (lastCommand.state === 'failed') currentNotice = lastCommand.errorMessage || '本轮执行未完成，请查看当前对话。';
    else if (lastCommand.state === 'canceled') currentNotice = '这条尚未执行的要求已撤回。';
    else if (lastCommand.state === 'verifying_delivery') currentNotice = null;
    else if (lastRequest?.kind === 'interrupt') currentNotice = '停止请求已记下，正在等待本轮终止回执。';
    else if (lastCommand.state === 'acknowledged') currentNotice = '原端已接收，正在执行本轮。';
    else if (lastCommand.state === 'awaiting_approval') currentNotice = '执行者需要你决定，处理当前请求后继续。';
    else if (lastCommand.state === 'dispatched') currentNotice = '要求已发送，正在等待原端回执。';
    else currentNotice = commandDetails(lastCommand).queueAfterTurn ? '要求已排队，本轮结束后发送；可以在下方撤回。' : '要求已排队，等待执行。';
  }
  const sendingDisabled = Boolean(sendBlockedReason) || !connected || busy || Boolean(draft.pending) || !draft.loaded || !draft.text.trim() || draft.images.length > 0;
  const connectionLabel = !snapshot ? '正在读取原会话' : !connected
    ? snapshot.connectionStatus === 'connecting' ? '正在连接会话' : '尚未连接原会话'
    : starting || (snapshot.runtimeStatus === 'idle' && lastRequest?.kind !== 'interrupt' && lastCommand?.state === 'prepared')
      ? '等待开工' : STATUS[snapshot.runtimeStatus];
  return <section ref={sceneRef} aria-label="Codex 工作现场" className={`min-w-0 bg-surface-3 ${fillHeight ? 'native-work-scene-fill' : 'space-y-4 rounded-xl border border-line p-4'}`}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className={fillHeight ? 'sr-only' : 'text-sm font-semibold text-ink'}>继续这项工作</h3><p role="status" title={snapshot?.runtimeVersion ? `运行版本 ${snapshot.runtimeVersion}` : undefined} className="mt-1 text-xs text-ink-3">Codex · {unresolved ? '送达待核对' : connectionLabel}</p></div>
      <div className="flex flex-wrap gap-4 text-xs"><button type="button" onClick={viewResults} className="text-primary hover:underline">查看成果</button><button type="button" onClick={onViewHistory} className="text-ink-3 hover:text-primary">原对话记录</button></div>
    </header>
    {snapshot?.admissionWait && sendBlockedReason !== snapshot.admissionWait.message && <p role="status" className="shrink-0 text-xs text-ink-2">{snapshot.admissionWait.message}</p>}
    {resultTurnId !== undefined && snapshot && !readError && !resultReply && <p role="status" className="shrink-0 text-xs text-ink-2">这轮回复暂不可核对，可查看原对话记录。</p>}
    {currentDecisions.length > 0 && <div aria-label="当前需要你决定" role="region" className="native-work-current-decisions space-y-2">{currentDecisions.map((decision) => <NativeDecision key={decision.id} decision={decision} current busy={busy} onAnswer={(value) => answer(decision, value)} />)}</div>}
    <div ref={fillHeight ? scrollRef : undefined} onScroll={fillHeight ? onScroll : undefined} aria-label={fillHeight ? '工作对话与决定' : undefined} className={fillHeight ? 'native-work-scene-content' : 'space-y-4'}>
    {requirements}
    {unresolved && <div role="region" aria-label="待核对的原操作" className="space-y-1 rounded-lg border border-warning/30 p-2.5 text-sm text-ink-2">
      <p className="font-medium text-ink">{unresolved.actionKind === 'session_interrupt' ? '停止请求待核对' : unresolved.actionKind === 'session_resume' ? '接续请求待核对' : '这条要求的送达结果待核对'}</p>
      {unresolvedIntent && typeof unresolvedIntent === 'object' && 'text' in unresolvedIntent && typeof unresolvedIntent.text === 'string'
        && <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{unresolvedIntent.text}</p>}
      <button type="button" onClick={onViewHistory} className="text-xs text-primary hover:underline">核对原会话记录</button>
    </div>}
    {(actionError || readError || snapshot?.error) && <div role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{actionError || readError || snapshot?.error}<button type="button" onClick={() => void refresh()} className="ml-3 underline">重新核对</button></div>}
    {!connected && snapshot && <div className="space-y-3 text-sm text-ink-2">
      <p>接续这条 Codex 原会话后，可以在这里补充要求并查看结果。请先停止原窗口中的执行。</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />原 Codex 会话已停止执行</label>
      <button type="button" disabled={!confirmed || !snapshot.capabilities.resume || busy} onClick={resume} className="rounded-lg bg-primary px-4 py-2.5 font-medium text-white disabled:opacity-50">{busy ? '正在接续原会话…' : '在这里继续原会话'}</button>
      {!snapshot.capabilities.resume && <p className="text-xs text-ink-3">{snapshot.error ?? '暂时无法恢复这条记录，请核对原执行配置和项目目录。'}</p>}
    </div>}
    {snapshot?.messages.length ? <div ref={fillHeight ? undefined : scrollRef} onScroll={fillHeight ? undefined : onScroll} aria-label="这项工作的对话" className={`native-work-messages space-y-4 ${fillHeight ? '' : 'max-h-[420px] overflow-y-auto rounded-lg border border-line p-3'}`}>
      {snapshot.historyTruncated && <p className="text-xs text-ink-3">这里只显示最近对话，完整历史可查看原对话记录。</p>}
      {snapshot.messages.map((message) => <article key={message.id} data-native-message-id={message.id} className={message.role === 'user' ? 'ml-5 rounded-lg bg-primary/10 p-3' : 'mr-2 p-1'}><p className="mb-1 text-xs font-medium text-ink-3">{message.role === 'user' ? '你' : message.id === latestReply?.id ? '最近回复 · 未核验' : 'Codex'}{message.streaming ? ' · 正在回复' : ''}</p>{message.role === 'assistant' ? <div className="native-work-markdown break-words text-sm leading-relaxed text-ink">{renderMarkdownDoc(message.text, undefined, (label, href) => /^https?:\/\//i.test(href) ? undefined : <span title={href}>{label}</span>)}</div> : <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{message.text}</div>}</article>)}
    </div> : connected ? <p className="text-sm text-ink-3">原会话已接续，交代下一步后会在这里显示回复。</p> : null}
    {historicalDecisions.length > 0 && <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-xs text-ink-3">待核对的历史请求 · {historicalDecisions.length}</summary><div className="mt-3 space-y-3">{historicalDecisions.map((decision) => <NativeDecision key={decision.id} decision={decision} current={false} busy={busy} onAnswer={(value) => answer(decision, value)} />)}</div></details>}
    {queued.length > 0 && <section aria-label="本轮结束后发送的要求" className="rounded-lg border border-line p-3"><h4 className="text-xs font-medium text-ink-3">本轮结束后发送 · {queued.length}</h4><ul className="mt-2 space-y-2">{queued.map(({ command, details }) => <li key={command.id} className="flex items-start gap-3 text-sm"><span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink-2">{details.intent && 'text' in details.intent ? details.intent.text : '排队要求'}</span><button type="button" disabled={busy} onClick={() => cancelQueued(details.requestId!)} className="shrink-0 text-primary disabled:opacity-50">撤回</button></li>)}</ul></section>}
    {draft.failed.map((request) => <div key={request.id} role="alert" className="rounded-lg border border-warning/30 p-3 text-xs text-ink-2"><p>{request.requiresVerification ? '上次发送结果尚未确认，先核对原会话，避免重复发送。' : '这条要求未能发送。'} {request.error}</p><p className="mt-1 whitespace-pre-wrap break-words">{request.text}</p><button type="button" onClick={onViewHistory} className="mt-2 text-primary">核对原对话</button></div>)}
    </div>
    <div className="native-work-composer space-y-2 rounded-xl border border-line bg-surface-4 p-3">
      {sendBlockedReason ? <p role="status" className="text-xs text-ink-2">{sendBlockedReason}</p>
        : running && <p className="text-xs text-ink-3">正在执行；补充要求会在本轮结束后发送。</p>}
      <textarea aria-label="补充这项工作的要求" data-work-composer="native-work" data-work-session-id={session.nativeSessionId} value={draft.text} onChange={(event) => useAgentComposerDrafts.getState().edit(composerKey, { text: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send(); } }} rows={fillHeight ? 2 : 3} placeholder={connected ? '交代下一步，或补充这项工作的要求…' : '可以先写下要求，接续后再发送…'} className={`block w-full border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3 ${fillHeight ? 'resize-none' : 'resize-y'}`} />
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-ink-3">{draft.saveError ?? (draft.loaded ? '草稿自动保存在本机 · Enter 发送' : '正在读取草稿…')}</span><div className="flex flex-wrap items-center gap-3">{running && <><button type="button" disabled={busy || !snapshot?.capabilities.interrupt || !connected || uncertainStop} onClick={stop} className="inline-flex items-center gap-1.5 text-xs text-ink-2 disabled:opacity-50"><Square size={12} />停止本轮</button>{snapshot?.capabilities.steer && <button type="button" disabled={sendingDisabled} onClick={() => send(true)} className="text-xs text-primary disabled:opacity-50" title="把当前输入作为本轮的一次调整立即发送">立即调整</button>}</>}<button type="button" disabled={sendingDisabled || !snapshot?.capabilities.prompt} onClick={() => send()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}发送</button></div></div>
      {draft.images.length > 0 && <p className="text-xs text-warning">此入口暂不能发送附件，已有草稿附件仍保留。</p>}
    </div>
    {currentNotice && <p role="status" className="native-work-scene-notice text-xs text-ink-2">{currentNotice}</p>}
  </section>;
}
