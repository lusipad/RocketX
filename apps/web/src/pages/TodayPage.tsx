import { AtSign, Bot, CalendarDays, CheckCircle2, ChevronDown, ChevronUp, Circle, ExternalLink, GitPullRequest, Loader2, MessageSquare, Play, Radio, RefreshCw, Sparkles, SquareCheckBig, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildTodayItems, todayCompletion, type TodayItem } from '../lib/today';
import { getServerBase, openExternal } from '../lib/client';
import { shouldExpandRun } from '../lib/butlerReport';
import type { ButlerEventCard } from '../lib/butlerWatchers';
import { useAuth } from '../stores/auth';
import { useCalendar } from '../stores/calendar';
import { useChat } from '../stores/chat';
import { useToday } from '../stores/today';
import { useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import { useRoutines, type Routine } from '../stores/routines';
import { renderMarkdown } from '../lib/markdown';
import { IPMSG_RID, useIpmsg } from '../ipmsg/store';

const kindMeta = {
  mention: { label: '@我', icon: MessageSquare, color: 'text-primary' },
  todo: { label: '待办', icon: SquareCheckBig, color: 'text-warning' },
  event: { label: '日程', icon: CalendarDays, color: 'text-purple-500' },
  workitem: { label: '工作项', icon: ExternalLink, color: 'text-success' },
  pr: { label: 'PR', icon: GitPullRequest, color: 'text-primary' },
  build: { label: '构建', icon: Workflow, color: 'text-danger' },
  ipmsg: { label: '局域网', icon: Radio, color: 'text-warning' },
} as const;

const butlerEventMeta = {
  'mention-stale': { icon: AtSign, color: 'text-primary' },
} as const;

function displayTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function routineScheduleLabel(trigger: { time: string; days?: number[] }): string {
  const dayText = trigger.days?.length
    ? trigger.days.map((day) => `周${'日一二三四五六'[day] ?? day}`).join('、')
    : '每日';
  return `${dayText} ${trigger.time}`;
}

interface RoutineReportCardProps {
  routine: Routine;
  running: boolean;
  onRunNow: (id: string) => Promise<void>;
}

/** 晨报卡：以报告内容为主体——今天的报告默认展开，没生成给一键生成，失败给重试 */
function RoutineReportCard({ routine, running, onRunNow }: RoutineReportCardProps) {
  const latest = routine.runs[0];
  const [expanded, setExpanded] = useState(() => shouldExpandRun(latest, Date.now()));
  const freshToday = shouldExpandRun(latest, Date.now());

  const handleRunNow = async () => {
    await onRunNow(routine.id);
    setExpanded(true);
  };

  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{routine.name}</span>
        <span className="shrink-0 text-xs text-ink-3">
          {latest
            ? latest.status === 'error'
              ? `${displayTime(latest.at)} 生成失败`
              : `${displayTime(latest.at)} 生成${freshToday ? '' : '（非今日）'}`
            : '今天还没生成'}
        </span>
        <button
          title={latest?.status === 'error' ? '重试' : latest ? '重新生成' : '立即生成'}
          aria-label={`立即生成${routine.name}`}
          onClick={() => void handleRunNow()}
          disabled={running}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        </button>
        {latest ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? `收起${routine.name}报告` : `展开${routine.name}报告`}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-fill-hover hover:text-ink"
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        ) : null}
      </div>
      {latest && expanded ? (
        <div className="mt-3 border-t border-line pt-3">
          {latest.status === 'ok'
            ? <div className="text-sm leading-6 text-ink">{renderMarkdown(latest.text)}</div>
            : <p className="text-sm leading-6 text-danger">{latest.text}</p>}
        </div>
      ) : null}
    </div>
  );
}

export default function TodayPage() {
  const userId = useAuth((state) => state.user?._id ?? 'guest');
  const todos = useTodos((state) => state.todos);
  const events = useCalendar((state) => state.events);
  const workItems = useWorkbench((state) => state.workItems);
  const pullRequests = useWorkbench((state) => state.prs);
  const builds = useWorkbench((state) => state.builds);
  const config = useWorkbench((state) => state.config);
  const lastRefresh = useWorkbench((state) => state.lastRefresh);
  const refreshWorkbench = useWorkbench((state) => state.refresh);
  const workbenchLoading = useWorkbench((state) => state.loading);
  const mentions = useToday((state) => state.mentions);
  const ipmsgMessages = useIpmsg((state) => state.messages);
  const processed = useToday((state) => state.processed);
  const loading = useToday((state) => state.loading);
  const warnings = useToday((state) => state.warnings);
  const hydrate = useToday((state) => state.hydrate);
  const refreshMentions = useToday((state) => state.refreshMentions);
  const setProcessed = useToday((state) => state.setProcessed);
  const routines = useRoutines((state) => state.routines);
  const eventCards = useRoutines((state) => state.eventCards);
  const runningIds = useRoutines((state) => state.runningIds);
  const hydrateRoutines = useRoutines((state) => state.hydrate);
  const setRoutineEnabled = useRoutines((state) => state.setEnabled);
  const runRoutineNow = useRoutines((state) => state.runNow);
  const dismissCard = useRoutines((state) => state.dismissCard);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    void hydrate().then(refreshMentions);
    if (config && !lastRefresh) void refreshWorkbench();
  }, [config, hydrate, lastRefresh, refreshMentions, refreshWorkbench]);

  useEffect(() => {
    hydrateRoutines();
  }, [hydrateRoutines]);

  const scope = `${getServerBase() || 'same-origin'}:${userId}`;
  const adoScope = config
    ? config.mode === 'direct'
      ? config.adoBase ?? 'direct'
      : config.bridge ?? 'bridge'
    : 'unconfigured';
  const items = useMemo(
    () => buildTodayItems({
      mentions,
      todos,
      events,
      workItems,
      pullRequests,
      builds,
      adoAccount: config?.account,
      ipmsg: ipmsgMessages,
      scope,
      adoScope,
      processed,
    }),
    [adoScope, builds, config?.account, events, ipmsgMessages, mentions, processed, pullRequests, scope, todos, workItems],
  );
  const completion = todayCompletion(items);
  const visible = showDone ? items : items.filter((item) => !item.processed);

  /** 规则提醒点击跳到对应模块（卡片本身只有摘要，没有深链数据） */
  const openEventCard = (_card: ButlerEventCard) => {
    useUI.getState().setModule('messages');
  };

  const openItem = async (item: TodayItem) => {
    if (item.kind === 'mention') {
      useUI.getState().setModule('messages');
      await useChat.getState().jumpToMessage(item.message._id, item.message.rid);
    } else if (item.kind === 'todo') {
      if (item.todo.rid && item.todo.mid) {
        useUI.getState().setModule('messages');
        await useChat.getState().jumpToMessage(item.todo.mid, item.todo.rid);
      } else {
        // 手动新建的待办没有来源消息可跳
        useUI.getState().setModule('todos');
      }
    } else if (item.kind === 'event') {
      const calendar = useCalendar.getState();
      calendar.setCursor(item.occurrenceDate);
      calendar.setSelectedDate(item.occurrenceDate);
      calendar.setView('day');
      useUI.getState().setModule('calendar');
    } else if (item.kind === 'ipmsg') {
      useUI.getState().setModule('messages');
      await useChat.getState().openRoom(IPMSG_RID);
    } else if (item.kind === 'workitem') {
      await openExternal(item.workItem.webUrl);
    } else if (item.kind === 'pr') {
      await openExternal(item.pullRequest.webUrl);
    } else {
      await openExternal(item.build.webUrl);
    }
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-surface-3">
      <div className="mx-auto max-w-4xl px-8 py-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xl font-semibold text-ink"><Sparkles size={20} className="text-primary" />今日</div>
            <p className="mt-1 text-sm text-ink-3">@我、局域网消息、到期待办、今日日程、我的工作项、PR 和构建</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void Promise.all([refreshMentions(), config ? refreshWorkbench() : Promise.resolve()])}
              disabled={loading || workbenchLoading}
              className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
            >
              {loading || workbenchLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}刷新
            </button>
          </div>
        </div>

        {/* AI 晨报：只放 AI 生成的报告；规则提醒在下方「提醒」组，不顶 AI 的帽子 */}
        <section className="mt-5 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink"><Bot size={17} className="text-primary" />AI 晨报</div>
          {routines.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-3">
              还没有例行晨报。到 AI 页面说一句「每天 9 点给我一份晨报」，确认草案后 AI 会按时生成。
              <button
                onClick={() => useUI.getState().setModule('ai-assistant')}
                className="ml-2 font-medium text-primary hover:underline"
              >
                去创建
              </button>
            </div>
          ) : (
            <>
              <div className="mt-3 space-y-2">
                {routines.filter((routine) => routine.enabled).map((routine) => (
                  <RoutineReportCard
                    key={routine.id}
                    routine={routine}
                    running={runningIds.includes(routine.id)}
                    onRunNow={runRoutineNow}
                  />
                ))}
                {routines.every((routine) => !routine.enabled) && (
                  <div className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-xs text-ink-3">
                    所有例行事务都已停用，在下方「管理」里开启。
                  </div>
                )}
              </div>
              <details className="group mt-3 rounded-md border border-line">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-ink-2">
                  管理例行事务
                  <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
                </summary>
                <div className="divide-y divide-line border-t border-line">
                  {routines.map((routine) => (
                    <label key={routine.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-ink">
                      <input
                        className="accent-primary"
                        type="checkbox"
                        checked={routine.enabled}
                        onChange={(event) => setRoutineEnabled(routine.id, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate">{routine.name}</span>
                      <span className="shrink-0 text-xs text-ink-3">{routineScheduleLabel(routine.trigger)}</span>
                    </label>
                  ))}
                </div>
              </details>
            </>
          )}
        </section>

        <div className="mt-5 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink">今日处理进度</span>
            <span className="text-ink-3">{completion.done} / {completion.total} · {Math.round(completion.rate * 100)}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-fill-hover">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${completion.rate * 100}%` }} />
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="mt-4 rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning">
            部分会话同步失败：{warnings.join('；')}
          </div>
        )}

        {/* 规则提醒：构建失败/@我超时/新分配等「新变化」，通知性质，可关闭，不计入处理进度 */}
        {eventCards.length > 0 && (
          <div className="mt-5">
            <h2 className="text-sm font-semibold text-ink">提醒</h2>
            <div className="mt-2 space-y-2">
              {eventCards.map((card) => {
                const meta = butlerEventMeta[card.kind];
                const Icon = meta.icon;
                return (
                  <div key={card.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
                    <Icon size={18} className={`shrink-0 ${meta.color}`} />
                    <button onClick={() => openEventCard(card)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium text-ink">{card.title}</div>
                      <div className="mt-0.5 truncate text-xs text-ink-3">{card.detail} · {displayTime(card.at)}</div>
                    </button>
                    <button title="关闭提醒" onClick={() => dismissCard(card.id)} className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={15} /></button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{showDone ? '全部条目' : '待处理'}</h2>
          <label className="flex items-center gap-2 text-xs text-ink-3">
            <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />显示已处理
          </label>
        </div>
        <div className="mt-2 space-y-2">
          {visible.map((item) => {
            const meta = kindMeta[item.kind];
            const Icon = meta.icon;
            return (
              <div key={item.key} className={`flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 ${item.processed ? 'opacity-55' : ''}`}>
                <button
                  title={item.processed ? '标记为待处理' : '标记为已处理'}
                  onClick={() => void setProcessed(item.key, !item.processed)}
                  className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-primary"
                >
                  {item.processed ? <CheckCircle2 size={19} className="text-success" /> : <Circle size={19} />}
                </button>
                <Icon size={18} className={meta.color} />
                <button onClick={() => void openItem(item)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2"><span className="rounded bg-fill-hover px-1.5 py-0.5 text-[11px] text-ink-3">{meta.label}</span><span className="truncate text-sm font-medium text-ink">{item.title}</span></div>
                  {item.meta && <div className="mt-1 truncate text-xs text-ink-3">{item.meta}</div>}
                </button>
              </div>
            );
          })}
          {!loading && visible.length === 0 && (
            <div className="rounded-lg border border-dashed border-line py-12 text-center text-sm text-ink-3">今天已经清空了。</div>
          )}
        </div>
      </div>
    </div>
  );
}
