import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Bell,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Smartphone,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import ButlerConversation from '../components/ButlerConversation';
import ButlerErrandRunCard from '../components/ButlerErrandRunCard';
import Button from '../components/ui/Button';
import ButlerLearnedPanel from '../components/ButlerLearnedPanel';
import ButlerRoutines from '../components/ButlerRoutines';
import ButlerAuditTrail from '../components/ButlerAuditTrail';
import ButlerSources from '../components/ButlerSources';
import type { ButlerSource } from '../lib/butlerContext';
import type { StoredRoundsResult } from '../lib/butlerRoundsRunner';
import { ledgerFromTodos, type LedgerEntry } from '../lib/butlerLedger';
import {
  runButlerRoundsNow,
  runDailyButlerRoundsIfNeeded,
  markButlerRoundsItemFeedback,
  muteButlerRoundsItem,
  snoozeButlerRoundsItem,
  useButlerRoundsRunner,
  visibleButlerRoundItems,
} from '../lib/butlerRoundsRunner';
import { listBriefFeedback, removeBriefFeedback, type ButlerBriefVerdict } from '../lib/butlerBriefFeedback';
import {
  briefDeliverySettings,
  deliverButlerBrief,
  setBriefDeliveryEnabled,
} from '../lib/butlerBriefDelivery';
import { listMutes, removeMute } from '../lib/butlerMutes';
import {
  acceptButlerProposal,
  createButlerProposalCheckpoint,
  dismissButlerProposal,
} from '../lib/butlerProposalActions';
import { turnButlerBriefItemIntoTodo } from '../lib/butlerBriefActions';
import { runDraftWithBrain } from '../lib/butlerRoundsBrain';
import { isProposalHandled } from '../lib/butlerOutbox';
import { butlerRecapAgoLabel, executeApprovedButlerOperation, useButler } from '../stores/butler';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { dueLabel, todayKey, useTodos } from '../stores/todos';
import { useAuth } from '../stores/auth';
import { useUI } from '../stores/ui';

function lookedAtLabel(value: string | null): string {
  if (!value) return '我还没看过';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '我看过一圈';
  return `我 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 看了一圈`;
}

function roundSources(ref: string, stored: StoredRoundsResult | null): ButlerSource[] {
  if (!stored) return [];
  const label = stored.refTitles[ref] ?? '相关事项';
  const message = stored.refMessages?.[ref];
  if (message) return [{ kind: 'message', id: ref.slice(4), mid: ref.slice(4), rid: message.rid, label }];
  const [kind, id = ''] = ref.split(':', 2);
  if (!id) return [];
  if (kind === 'todo' || kind === 'ledger') return [{ kind: 'todo', id, label }];
  if (kind === 'wi') return [{ kind: 'work-item', id, label }];
  if (kind === 'pr') return [{ kind: 'pull-request', id, label }];
  if (kind === 'build') return [{ kind: 'build', id, label }];
  return [];
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
    <section className="min-w-0 rounded-xl bg-surface p-4 shadow-raise">
      <h2 className="mb-3 text-sm font-semibold text-ink">{title}</h2>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-3">这里还是空的</p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => {
            const due = ledgerDue(entry, today);
            return (
              <div key={`${entry.kind}:${entry.todoId}`} className="rounded-lg bg-surface-2 px-3 py-2.5">
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
  const [briefFeedback, setBriefFeedback] = useState(() => listBriefFeedback());
  const [draftingRef, setDraftingRef] = useState<string | null>(null);
  const [proposalOperationKey, setProposalOperationKey] = useState<string | null>(null);
  const [draftCard, setDraftCard] = useState<{ ref: string; text: string; rid?: string } | null>(null);
  const draftTextRef = useRef<HTMLTextAreaElement>(null);
  const conversationOpen = useUI((state) => state.butlerConversationOpen);
  const openConversation = useUI((state) => state.openButlerConversation);
  const butlerSessions = useButler((state) => state.sessions);
  const activeButlerSessionId = useButler((state) => state.activeSessionId);
  const switchButlerSession = useButler((state) => state.switchSession);
  const hydrateButler = useButler((state) => state.hydrate);
  const butlerUserId = useAuth((state) => state.user?._id);
  const deskSessions = butlerSessions.filter((session) => session.lastAsk).slice(0, 5);
  const openSessionConversation = async (sessionId: string): Promise<void> => {
    if (sessionId !== activeButlerSessionId) await switchButlerSession(sessionId);
    openConversation();
  };
  const closeConversation = useUI((state) => state.closeButlerConversation);
  const setModule = useUI((state) => state.setModule);
  const openRoom = useChat((state) => state.openRoom);
  const todos = useTodos((state) => state.todos);
  const lastRoundsAt = useButlerRoundsRunner((state) => state.lastRoundsAt);
  const lastResult = useButlerRoundsRunner((state) => state.lastResult);
  const running = useButlerRoundsRunner((state) => state.running);
  const error = useButlerRoundsRunner((state) => state.error);
  const [briefSync, setBriefSync] = useState(() => briefDeliverySettings().enabled);
  const [briefSyncBusy, setBriefSyncBusy] = useState(false);

  const toggleBriefSync = async (): Promise<void> => {
    if (briefSyncBusy) return;
    const next = !briefSync;
    setBriefDeliveryEnabled(next);
    setBriefSync(next);
    if (!next) {
      toast.info('已停止把简报发到 Rocket.Chat');
      return;
    }
    // 开启即投递当前这份（手动语义），让「手机能看到」立刻成立
    if (!lastResult) {
      toast.success('已开启：下次简报会发到你和自己的私聊，手机也能看');
      return;
    }
    setBriefSyncBusy(true);
    try {
      await deliverButlerBrief(lastResult, { manual: true });
      toast.success('今天的简报已发到你和自己的私聊，手机打开 Rocket.Chat 就能看');
    } catch (deliverError) {
      toast.error(deliverError, '简报投递失败');
    } finally {
      setBriefSyncBusy(false);
    }
  };

  useEffect(() => {
    void runDailyButlerRoundsIfNeeded();
  }, []);

  // 桌面视图不挂 ButlerConversation/ButlerPanel，没有它就拿不到会话列表：
  // 同日刷新时 runDailyButlerRoundsIfNeeded 会直接 return，「我们手头的事」永远空。
  useEffect(() => {
    if (butlerUserId) void hydrateButler();
  }, [butlerUserId, hydrateButler]);

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

  async function acceptProposal(
    proposal: NonNullable<typeof result>['proposals'][number],
    key: string,
  ): Promise<void> {
    let who: string | undefined;
    if (proposal.kind === 'add-commitment' && !proposal.who) {
      who = window.prompt('这件事答应给谁？')?.trim();
      if (!who) return;
    }
    setProposalOperationKey(key);
    try {
      const checkpoint = createButlerProposalCheckpoint(proposal, {
        action: 'accept',
        generatedAt: lastResult?.generatedAt,
        today,
        who,
      });
      const outcome = await executeApprovedButlerOperation(checkpoint, () => acceptButlerProposal(proposal, {
        today,
        who,
        messageRefs: lastResult?.refMessages,
      }));
      if (outcome === 'needs-who') return;
      if (outcome === 'missing-ref') toast.info('这项已经找不到了');
      else if (outcome === 'already-applied') toast.info('这项已经处理过了');
      else if (proposal.kind === 'close-wait') toast.success('已销账');
      else toast.success('已入账');
      hideProposal(key);
    } catch (error) {
      toast.error(error, '建议执行失败，可明确重试');
    } finally {
      setProposalOperationKey(null);
    }
  }

  async function dismissProposal(
    proposal: NonNullable<typeof result>['proposals'][number],
    key: string,
  ): Promise<void> {
    setProposalOperationKey(key);
    try {
      const checkpoint = createButlerProposalCheckpoint(proposal, {
        action: 'dismiss',
        generatedAt: lastResult?.generatedAt,
      });
      await executeApprovedButlerOperation(checkpoint, () => {
        dismissButlerProposal(proposal);
        return 'dismissed';
      });
      hideProposal(key);
      toast.info('这次先不管');
    } catch (error) {
      toast.error(error, '暂时无法忽略这项建议');
    } finally {
      setProposalOperationKey(null);
    }
  }

  function muteItem(title: string): void {
    if (!muteButlerRoundsItem(title)) return;
    setMutes(listMutes());
    toast.success('已记住：这类少提');
  }

  function feedbackItem(ref: string, title: string, verdict: ButlerBriefVerdict): void {
    if (!markButlerRoundsItemFeedback(ref, title, verdict)) return;
    setBriefFeedback(listBriefFeedback());
    if (verdict === 'noise') toast.success('记下了：这类以后少报');
    else toast.success('记下了：这类会继续盯');
  }

  /**
   * 简报条目背后的待办 id。`ledger:` 与 `todo:` 两种前缀都直接带 id——
   * 这类条目「本来就是待办」，所以不该给「转任务」，而该给真正能了结它的动作。
   */
  function todoIdOf(ref: string): string | null {
    const [kind, id = ''] = ref.split(':', 2);
    if ((kind !== 'ledger' && kind !== 'todo') || !id) return null;
    return todos.some((todo) => todo.id === id && !todo.done) ? id : null;
  }

  function completeTodo(ref: string): void {
    const id = todoIdOf(ref);
    if (!id) return;
    const title = refTitles.get(ref) ?? '这件事';
    useTodos.getState().toggle(id);
    toast.undo(`已完成「${title}」`, () => useTodos.getState().toggle(id));
  }

  /** 逾期条目最常见的处理不是「完成」也不是「稍后」，而是「就今天」 */
  function scheduleToday(ref: string): void {
    const id = todoIdOf(ref);
    if (!id) return;
    const previous = todos.find((todo) => todo.id === id)?.due;
    const today = todayKey();
    useTodos.getState().update(id, { due: today });
    toast.undo('已改到今天', () => useTodos.getState().update(id, { due: previous }));
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
        <div className="flex items-center gap-2">
          <Button
            variant={briefSync ? 'primary' : 'secondary'}
            icon={Smartphone}
            loading={briefSyncBusy}
            onClick={() => void toggleBriefSync()}
            title={briefSync ? '简报会发到你和自己的私聊，任何 Rocket.Chat 客户端可看；点击停止' : '把每天的简报发到你和自己的私聊，手机打开 Rocket.Chat 就能看'}
          >
            {briefSync ? '已同步到手机' : '同步到手机'}
          </Button>
          <Button
            icon={RefreshCw}
            loading={running}
            onClick={() => void runButlerRoundsNow()}
          >
            再看一圈
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
              这轮没看成：{error}
            </div>
          )}

          <section className="rounded-xl bg-surface p-5 shadow-raise">
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
                      <article key={`${item.ref}:${index}`} className="rounded-lg bg-surface-2 p-4">
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
                            <ButlerSources sources={roundSources(item.ref, lastResult)} />
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {canTurnIntoTodo(item.ref) && (
                                <Button
                                  size="sm"
                                  onClick={() => turnIntoTodo(item.ref)}
                                >
                                  转任务
                                </Button>
                              )}
                              {todoIdOf(item.ref) && (
                                <Button
                                  size="sm"
                                  icon={CheckCircle2}
                                  onClick={() => completeTodo(item.ref)}
                                >
                                  完成
                                </Button>
                              )}
                              {todoIdOf(item.ref) && todos.find((todo) => todo.id === todoIdOf(item.ref))?.due !== today && (
                                <Button
                                  size="sm"
                                  icon={CalendarCheck}
                                  onClick={() => scheduleToday(item.ref)}
                                >
                                  就今天
                                </Button>
                              )}
                              {/* 只从这份简报里收起，不碰待办本身。原文案「稍后」会被读成
                                  「稍后处理这件事」，跟旁边真的改期的「就今天」撞在一起 */}
                              <Button
                                size="sm"
                                title="从这份简报里收起。不改待办；下次我再看一圈时它若还在，还会提"
                                onClick={() => {
                                  if (snoozeButlerRoundsItem(item.ref)) toast.info('已从这份简报收起，下次我再看一圈还在的话会提');
                                }}
                              >
                                先收起
                              </Button>
                              {lastResult?.refPeople?.[item.ref] && (
                                <Button
                                  size="sm"
                                  loading={draftingRef === item.ref}
                                  disabled={draftingRef !== null}
                                  onClick={() => void draftReply(item)}
                                >
                                  帮我拟一句
                                </Button>
                              )}
                              {/* 左边是「怎么处理这件事」，右边是「这条报得对不对」——
                                  两类语义平铺成一行时，光看图标猜不出点了会发生什么 */}
                              <span className="ml-auto text-2xs text-ink-3">这条报得好吗</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={ThumbsUp}
                                title="这类以后继续盯"
                                onClick={() => feedbackItem(item.ref, refTitles.get(item.ref) ?? '相关事项', 'useful')}
                              >
                                有用
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={ThumbsDown}
                                title="这条不该报；同类以后少提"
                                onClick={() => feedbackItem(item.ref, refTitles.get(item.ref) ?? '相关事项', 'noise')}
                              >
                                没用
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="把这件事加入静音清单，以后不再出现"
                                onClick={() => muteItem(refTitles.get(item.ref) ?? '相关事项')}
                              >
                                别再提
                              </Button>
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
                      <ButlerSources sources={roundSources(proposal.ref, lastResult)} />
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={proposalOperationKey === key}
                          onClick={() => void acceptProposal(proposal, key)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                        >
                          {proposalOperationKey === key ? '执行中…' : proposal.kind === 'close-wait' ? '销账' : '入账'}
                        </button>
                        <button
                          type="button"
                          disabled={proposalOperationKey === key}
                          onClick={() => void dismissProposal(proposal, key)}
                          className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover disabled:opacity-50"
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

          {deskSessions.length > 0 && (
            <section className="rounded-xl bg-surface p-5 shadow-raise">
              <h2 className="text-sm font-semibold text-ink">我们手头的事</h2>
              <div className="mt-3 flex flex-col gap-2">
                {deskSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => void openSessionConversation(session.id)}
                    className="flex items-center gap-3 rounded-lg bg-surface-2 px-3.5 py-2.5 text-left hover:border-primary/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{session.title}</div>
                      <div className="mt-0.5 truncate text-xs text-ink-2">上回说到：{session.lastAsk}</div>
                    </div>
                    <span className="shrink-0 text-xs text-ink-3">{butlerRecapAgoLabel(session.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <ButlerErrandRunCard />

          <div className="grid gap-4 md:grid-cols-2">
            <LedgerColumn title="我答应的" entries={commitments} today={today} />
            <LedgerColumn title="我在等的" entries={waits} today={today} />
          </div>

          <ButlerLearnedPanel />

          <details className="group rounded-xl bg-surface shadow-raise">
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
                      <ButlerSources sources={roundSources(item.ref, lastResult)} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-2 text-center text-sm text-ink-3">这次没有压下的内容。</p>
              )}
              {briefFeedback.length > 0 && (
                <section className="mt-4 border-t border-line pt-3">
                  <h3 className="text-xs font-medium text-ink-2">你最近的反馈（{briefFeedback.length}）</h3>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {[...briefFeedback].reverse().slice(0, 10).map((entry) => (
                      <div key={`${entry.title}:${entry.at}`} className="flex items-center gap-2 text-xs text-ink-3">
                        {entry.verdict === 'noise'
                          ? <ThumbsDown size={12} className="shrink-0" />
                          : <ThumbsUp size={12} className="shrink-0" />}
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        <span className="shrink-0">{entry.verdict === 'noise' ? '以后少报' : '继续盯'}</span>
                        <button
                          type="button"
                          onClick={() => {
                            removeBriefFeedback(entry.title);
                            setBriefFeedback(listBriefFeedback());
                            toast.success('已撤销这条反馈');
                          }}
                          className="shrink-0 px-1.5 py-1 text-ink-3 hover:text-ink"
                        >
                          撤销
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
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
              <ButlerAuditTrail />
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
          <form onSubmit={submitQuestion} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 focus-within:border-primary/50">
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
              <Send size={14} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
