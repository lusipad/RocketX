import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Bell,
  ChevronDown,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
} from 'lucide-react';
import ButlerConversation from '../components/ButlerConversation';
import ButlerRoutines from '../components/ButlerRoutines';
import { ledgerFromTodos, type LedgerEntry } from '../lib/butlerLedger';
import {
  runButlerRoundsNow,
  runDailyButlerRoundsIfNeeded,
  muteButlerRoundsItem,
  snoozeButlerRoundsItem,
  useButlerRoundsRunner,
  visibleButlerRoundItems,
} from '../lib/butlerRoundsRunner';
import { listMutes, removeMute } from '../lib/butlerMutes';
import { acceptButlerProposal, dismissButlerProposal } from '../lib/butlerProposalActions';
import { turnButlerBriefItemIntoTodo } from '../lib/butlerBriefActions';
import { runDraftWithBrain } from '../lib/butlerRoundsBrain';
import { isProposalHandled } from '../lib/butlerOutbox';
import { useButler } from '../stores/butler';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { dueLabel, todayKey, useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';

function lookedAtLabel(value: string | null): string {
  if (!value) return '我还没看过';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '我看过一圈';
  return `我 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 看了一圈`;
}

function canTurnIntoTodo(ref: string): boolean {
  return /^(?:wi|pr|build|msg):/.test(ref);
}

function sentMessageLabel(at: string, roomName: string, generatedAt?: string): string {
  const then = new Date(at).getTime();
  const now = generatedAt ? new Date(generatedAt).getTime() : Date.now();
  const days = Number.isFinite(then) && Number.isFinite(now)
    ? Math.max(0, Math.floor((now - then) / 86_400_000))
    : 0;
  return days === 0
    ? `这是你今天在「${roomName}」说的`
    : `这是你 ${days} 天前在「${roomName}」说的`;
}

function ledgerDue(entry: LedgerEntry, today: string): { label: string; color: string } {
  if (entry.dueState === 'overdue') {
    return { label: entry.due ? dueLabel(entry.due, today) : '已逾期', color: 'text-danger' };
  }
  if (entry.dueState === 'today') return { label: '今天到期', color: 'text-danger' };
  if (entry.due) return { label: dueLabel(entry.due, today), color: 'text-ink-3' };
  return { label: '没设日期', color: 'text-ink-3' };
}

function LedgerColumn({
  title,
  entries,
  today,
}: {
  title: string;
  entries: LedgerEntry[];
  today: string;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">{title}</h2>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-3">这里还是空的</p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => {
            const due = ledgerDue(entry, today);
            return (
              <div key={`${entry.kind}:${entry.todoId}`} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                <div className="text-sm font-medium text-ink">{entry.title}</div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-ink-2">{entry.who}</span>
                  <span className={due.color}>{due.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function ButlerPage() {
  const [input, setInput] = useState('');
  const [hiddenProposals, setHiddenProposals] = useState<Set<string>>(() => new Set());
  const [mutes, setMutes] = useState(() => listMutes());
  const [draftingRef, setDraftingRef] = useState<string | null>(null);
  const [draftCard, setDraftCard] = useState<{ ref: string; text: string; rid?: string } | null>(null);
  const draftTextRef = useRef<HTMLTextAreaElement>(null);
  const conversationOpen = useUI((state) => state.butlerConversationOpen);
  const openConversation = useUI((state) => state.openButlerConversation);
  const closeConversation = useUI((state) => state.closeButlerConversation);
  const setModule = useUI((state) => state.setModule);
  const openRoom = useChat((state) => state.openRoom);
  const todos = useTodos((state) => state.todos);
  const lastRoundsAt = useButlerRoundsRunner((state) => state.lastRoundsAt);
  const lastResult = useButlerRoundsRunner((state) => state.lastResult);
  const running = useButlerRoundsRunner((state) => state.running);
  const error = useButlerRoundsRunner((state) => state.error);

  useEffect(() => {
    void runDailyButlerRoundsIfNeeded();
  }, []);

  useEffect(() => {
    setHiddenProposals(new Set());
    setDraftCard(null);
  }, [lastResult?.generatedAt]);

  const today = todayKey();
  const ledger = useMemo(() => ledgerFromTodos(todos, today), [todos, today]);
  const commitments = useMemo(
    () => ledger.filter((entry) => entry.kind === 'commitment'),
    [ledger],
  );
  const waits = useMemo(() => ledger.filter((entry) => entry.kind === 'wait'), [ledger]);
  const result = lastResult?.result;
  const visibleItems = useMemo(() => visibleButlerRoundItems(lastResult), [lastResult]);
  const visibleProposals = useMemo(
    () => result?.proposals.filter((proposal) => !isProposalHandled(proposal.ref)) ?? [],
    [result],
  );

  const refTitles = useMemo(
    () => new Map(Object.entries(lastResult?.refTitles ?? {})),
    [lastResult],
  );
  const checkedCount = lastResult?.checkedCount ?? 0;

  function hideProposal(key: string): void {
    setHiddenProposals((current) => new Set(current).add(key));
  }

  function acceptProposal(
    proposal: NonNullable<typeof result>['proposals'][number],
    key: string,
  ): void {
    let who: string | undefined;
    if (proposal.kind === 'add-commitment' && !proposal.who) {
      who = window.prompt('这件事答应给谁？')?.trim();
      if (!who) return;
    }
    const outcome = acceptButlerProposal(proposal, {
      today,
      who,
      messageRefs: lastResult?.refMessages,
    });
    if (outcome === 'needs-who') return;
    if (outcome === 'missing-ref') toast.info('这项已经找不到了');
    else if (outcome === 'already-applied') toast.info('这项已经处理过了');
    else if (proposal.kind === 'close-wait') toast.success('已销账');
    else toast.success('已入账');
    hideProposal(key);
  }

  function muteItem(title: string): void {
    if (!muteButlerRoundsItem(title)) return;
    setMutes(listMutes());
    toast.success('已记住：这类少提');
  }

  function turnIntoTodo(ref: string): void {
    const outcome = turnButlerBriefItemIntoTodo(ref, refTitles.get(ref) ?? '相关事项', {
      message: lastResult?.refMessages?.[ref],
    });
    if (outcome === 'already-exists') toast.info('已在待办池');
    else if (outcome === 'created') toast.success('已转到待办池');
    else toast.info('这条暂时不能转任务');
  }

  async function draftReply(item: NonNullable<typeof result>['items'][number]): Promise<void> {
    const who = lastResult?.refPeople?.[item.ref];
    if (!who || draftingRef) return;
    setDraftingRef(item.ref);
    try {
      const draft = await runDraftWithBrain({
        subject: refTitles.get(item.ref) ?? '相关事项',
        who,
        context: lastResult?.refMessages?.[item.ref]?.text
          ?? [item.why, item.suggestedAction].filter(Boolean).join('；'),
      });
      setDraftCard({ ref: item.ref, text: draft.draft, rid: lastResult?.refRids?.[item.ref] });
    } catch (error) {
      toast.error(error, '这次没拟成，请稍后再试');
    } finally {
      setDraftingRef(null);
    }
  }

  async function copyDraft(): Promise<void> {
    if (!draftCard) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(draftCard.text);
      toast.success('草稿已复制');
    } catch {
      draftTextRef.current?.focus();
      draftTextRef.current?.select();
      toast.info('已选中草稿，请按 Ctrl+C 复制');
    }
  }

  async function goToDraftConversation(): Promise<void> {
    if (!draftCard?.rid) return;
    setModule('messages');
    await openRoom(draftCard.rid);
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    openConversation();
    void useButler.getState().ask(text);
  }

  if (conversationOpen) {
    return <ButlerConversation onCollapse={closeConversation} />;
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface-3">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Bell size={20} className="shrink-0 text-primary" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">管家</h1>
            <p className="text-xs text-ink-3">{lookedAtLabel(lastRoundsAt)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void runButlerRoundsNow()}
          disabled={running}
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          再看一圈
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
              这轮没看成：{error}
            </div>
          )}

          <section className="rounded-xl border border-line bg-surface p-5">
            {result ? (
              <>
                <div className="border-b border-line pb-4">
                  <div className="mb-1 text-xs font-medium text-ink-3">简报</div>
                  <h2 className="text-xl font-semibold text-ink">{result.headline}</h2>
                  <p className="mt-1.5 text-sm leading-6 text-ink-2">{result.summary}</p>
                </div>

                {visibleItems.length > 0 ? (
                  <div className="mt-4 flex flex-col gap-3">
                    {visibleItems.map((item, index) => (
                      <article key={`${item.ref}:${index}`} className="rounded-lg border border-line bg-surface-2 p-4">
                        <div className="flex items-start gap-3">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold text-ink">{refTitles.get(item.ref) ?? '相关事项'}</h3>
                            <p className="mt-1 text-xs leading-5 text-ink-2">为什么找你：{item.why}</p>
                            {item.suggestedAction && (
                              <p className="mt-2 text-xs leading-5 text-ink-2">建议：{item.suggestedAction}</p>
                            )}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {canTurnIntoTodo(item.ref) && (
                                <button
                                  type="button"
                                  onClick={() => turnIntoTodo(item.ref)}
                                  className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-fill-hover"
                                >
                                  转任务
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  if (snoozeButlerRoundsItem(item.ref)) toast.info('这轮先放一放');
                                }}
                                className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-fill-hover"
                              >
                                稍后
                              </button>
                              {lastResult?.refPeople?.[item.ref] && (
                                <button
                                  type="button"
                                  onClick={() => void draftReply(item)}
                                  disabled={draftingRef !== null}
                                  className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-fill-hover disabled:opacity-50"
                                >
                                  {draftingRef === item.ref && <Loader2 size={12} className="animate-spin" />}
                                  帮我拟一句
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => muteItem(refTitles.get(item.ref) ?? '相关事项')}
                                className="px-1.5 py-1 text-xs text-ink-3 hover:text-ink"
                              >
                                少来这种
                              </button>
                            </div>
                            {draftCard?.ref === item.ref && (
                              <div className="mt-3 rounded-lg border border-primary/25 bg-surface p-3">
                                <div className="text-xs font-medium text-ink-2">给你的草稿</div>
                                <textarea
                                  ref={draftTextRef}
                                  readOnly
                                  value={draftCard.text}
                                  aria-label="拟好的消息草稿"
                                  className="mt-2 min-h-16 w-full resize-none rounded-md border border-line bg-surface-2 px-3 py-2 text-sm leading-6 text-ink outline-none"
                                />
                                <div className="mt-2 flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void copyDraft()}
                                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                                  >
                                    复制
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void goToDraftConversation()}
                                    disabled={!draftCard.rid}
                                    title={draftCard.rid ? undefined : '这条没有关联会话'}
                                    className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-fill-hover disabled:opacity-50"
                                  >
                                    去会话
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-ink-3">这轮没有必须找你的事。</p>
                )}

                {visibleProposals.map((proposal, index) => {
                  const key = `${proposal.kind}:${proposal.ref}:${index}`;
                  if (hiddenProposals.has(key)) return null;
                  const sentMessage = lastResult?.refMessages?.[proposal.ref];
                  return (
                    <div key={key} className="mt-3 rounded-lg border border-primary/25 bg-primary-light/20 p-4">
                      <div className="text-sm font-medium text-ink">
                        {sentMessage
                          ? sentMessageLabel(sentMessage.at, sentMessage.roomName, lastResult?.generatedAt)
                          : (refTitles.get(proposal.ref) ?? '相关事项')}
                      </div>
                      {sentMessage && (
                        <blockquote className="mt-2 rounded-r border-l-2 border-primary/35 bg-surface/70 px-3 py-2 text-xs leading-5 text-ink-2">
                          {sentMessage.text}
                        </blockquote>
                      )}
                      <p className="mt-1 text-xs leading-5 text-ink-2">{proposal.reason}</p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => acceptProposal(proposal, key)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                        >
                          {proposal.kind === 'close-wait' ? '销账' : '入账'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            dismissButlerProposal(proposal);
                            hideProposal(key);
                            toast.info('这次先不管');
                          }}
                          className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover"
                        >
                          先不管
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            ) : running ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-2">
                <Loader2 size={16} className="animate-spin" />
                我正在看……
              </div>
            ) : (
              <div className="py-12 text-center text-sm text-ink-3">还没有简报，点“再看一圈”试试。</div>
            )}
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <LedgerColumn title="我答应的" entries={commitments} today={today} />
            <LedgerColumn title="我在等的" entries={waits} today={today} />
          </div>

          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-ink-2">
              <span>
                工作日志 · 看了 {checkedCount} 项，上面说了 {visibleItems.length} 条，压下 {result?.suppressed.length ?? 0} 条
              </span>
              <ChevronDown size={16} className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-line px-4 py-3">
              {lastResult?.triggerReason && (
                <p className="mb-3 text-xs text-ink-3">这次主动来看：{lastResult.triggerReason}</p>
              )}
              {result?.suppressed.length ? (
                <div className="flex flex-col gap-2">
                  {result.suppressed.map((item, index) => (
                    <div key={`${item.ref}:${index}`} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
                      <div className="font-medium text-ink">{refTitles.get(item.ref) ?? '相关事项'}</div>
                      <div className="mt-0.5 leading-5 text-ink-3">{item.reason}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-2 text-center text-sm text-ink-3">这次没有压下的内容。</p>
              )}
              {mutes.length > 0 && (
                <section className="mt-4 border-t border-line pt-3">
                  <h3 className="text-xs font-medium text-ink-2">我记着少提的（{mutes.length}）</h3>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {mutes.map((mute) => (
                      <div key={mute.id} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate text-ink-3">{mute.text}</span>
                        <button
                          type="button"
                          onClick={() => {
                            removeMute(mute.id);
                            setMutes(listMutes());
                            toast.success('已删掉这条');
                          }}
                          className="shrink-0 px-1.5 py-1 text-ink-3 hover:text-ink"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </details>

          <ButlerRoutines />
        </div>
      </main>

      <div className="shrink-0 border-t border-line bg-surface px-6 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2">
          <button
            type="button"
            onClick={openConversation}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-2 hover:bg-fill-hover hover:text-ink"
          >
            <MessageCircle size={14} />展开对话
          </button>
          <form onSubmit={submitQuestion} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 focus-within:border-primary/50">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="问管家一句……"
              aria-label="问管家"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="发送"
              className="rounded-md bg-primary p-2 text-white hover:bg-primary-hover disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
