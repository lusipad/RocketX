import { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  ListTodo,
  Plus,
  Repeat,
  Wrench,
} from 'lucide-react';
import {
  useCalendar,
  monthGrid,
  weekDays,
  dateKey,
  eventsInRange,
  eventsForDate,
  DAY_NAMES,
  WEEK_HEADERS,
  type CalendarEvent,
  type CalendarView,
} from '../stores/calendar';
import { useTodos, todayKey, isOverdue, type Todo } from '../stores/todos';
import CalendarEventDialog from '../components/CalendarEventDialog';
import TimeGrid from '../components/TimeGrid';

const VIEW_LABELS: Record<CalendarView, string> = { month: '月', week: '周', day: '日' };

/** 日程+待办+工作台的统一条目 */
interface UnifiedItem {
  type: 'event' | 'todo';
  id: string;
  title: string;
  time?: string;
  color: string;
  done?: boolean;
  overdue?: boolean;
  repeat?: boolean;
  source: 'manual' | 'todo' | 'ado';
  raw: CalendarEvent | Todo;
}

function unifyForDate(
  events: CalendarEvent[],
  todos: Todo[],
  dateStr: string,
): UnifiedItem[] {
  const items: UnifiedItem[] = [];
  const today = todayKey();

  for (const e of eventsForDate(events, dateStr)) {
    items.push({
      type: 'event',
      id: e.id,
      title: e.title,
      time: e.allDay ? undefined : e.startTime,
      color: e.color,
      repeat: !!e.repeat,
      source: e.source,
      raw: e,
    });
  }

  for (const t of todos) {
    if (t.due !== dateStr) continue;
    items.push({
      type: 'todo',
      id: t.id,
      title: t.note || t.excerpt || '（无文字内容）',
      color: isOverdue(t, today) ? '#f54a45' : t.done ? '#8f959e' : '#3370ff',
      done: t.done,
      overdue: isOverdue(t, today),
      source: 'todo',
      raw: t,
    });
  }

  items.sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });

  return items;
}

/**
 * 月视图的一个格子。
 *
 * 之前叫 DayCell，格子里只画最多 3 个 1.5px 的圆点 —— 一个能放四行标题的格子，
 * 只用来画三个点，用户想知道今天开什么会必须点进去看右栏。现在直接把标题铺出来。
 */
function MonthCell({
  date,
  isCurrentMonth,
  isToday,
  isSelected,
  events,
  todos,
  onSelect,
  onPick,
  onCreate,
}: {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  events: CalendarEvent[];
  todos: Todo[];
  onSelect: () => void;
  onPick: (e: CalendarEvent) => void;
  onCreate: () => void;
}) {
  // 有时间的排前面（按时间），全天的垫后
  const sorted = [...events].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
    return (a.startTime ?? '').localeCompare(b.startTime ?? '');
  });
  const items: { key: string; color: string; label: string; onClick: () => void }[] = [
    ...sorted.map((e) => ({
      key: `e${e.id}`,
      color: e.color,
      label: e.allDay ? e.title : `${e.startTime ?? ''} ${e.title}`.trim(),
      onClick: () => onPick(e),
    })),
    ...todos.map((t) => ({
      key: `t${t.id}`,
      color: isOverdue(t) ? '#f54a45' : '#3370ff',
      label: `☑ ${t.note || t.excerpt}`,
      onClick: onSelect,
    })),
  ];

  const MAX = 3;

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onCreate}
      className={`group flex min-h-0 cursor-pointer flex-col border-r border-b border-line p-1 transition last:border-r-0 ${
        isSelected ? 'bg-primary-light/40' : 'hover:bg-fill-hover'
      } ${isCurrentMonth ? '' : 'bg-fill-1/50'}`}
      title="双击空白处新建日程"
    >
      <div className="flex shrink-0 items-center justify-between px-0.5">
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
            isToday
              ? 'bg-primary font-medium text-white'
              : isCurrentMonth
                ? 'text-ink'
                : 'text-ink-3'
          }`}
        >
          {date.getDate()}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCreate();
          }}
          className="text-ink-3 opacity-0 transition group-hover:opacity-100 hover:text-primary"
          title="新建日程"
        >
          <Plus size={12} />
        </button>
      </div>

      <div className="mt-0.5 min-h-0 flex-1 space-y-0.5 overflow-hidden">
        {items.slice(0, MAX).map((it) => (
          <button
            key={it.key}
            onClick={(e) => {
              e.stopPropagation();
              it.onClick();
            }}
            className="flex w-full items-center gap-1 rounded px-1 py-px text-left text-[11px] leading-tight transition hover:bg-fill-active"
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: it.color }}
            />
            <span className="min-w-0 flex-1 truncate text-ink-2">{it.label}</span>
          </button>
        ))}
        {items.length > MAX && (
          <div className="px-1 text-[10px] text-ink-3">还有 {items.length - MAX} 项</div>
        )}
      </div>
    </div>
  );
}

function EventItem({ item, onClick }: { item: UnifiedItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-fill-hover group"
    >
      <span
        className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: item.color }}
      />
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${item.done ? 'text-ink-3 line-through' : 'text-ink'}`}>
          {item.title}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-3">
          {item.time && (
            <span className="flex items-center gap-0.5">
              <Clock size={10} /> {item.time}
            </span>
          )}
          {item.repeat && (
            <span className="flex items-center gap-0.5">
              <Repeat size={10} /> 重复
            </span>
          )}
          {item.type === 'todo' && (
            <span className="flex items-center gap-0.5">
              <ListTodo size={10} /> 待办
            </span>
          )}
          {item.source === 'ado' && (
            <span className="flex items-center gap-0.5">
              <Wrench size={10} /> ADO
            </span>
          )}
          {item.overdue && (
            <span className="font-medium text-danger">已逾期</span>
          )}
        </div>
      </div>
    </button>
  );
}

export default function CalendarPage() {
  const events = useCalendar((s) => s.events);
  const view = useCalendar((s) => s.view);
  const cursor = useCalendar((s) => s.cursor);
  const selectedDate = useCalendar((s) => s.selectedDate);
  const setView = useCalendar((s) => s.setView);
  const setCursor = useCalendar((s) => s.setCursor);
  const setSelectedDate = useCalendar((s) => s.setSelectedDate);
  const prev = useCalendar((s) => s.prev);
  const next = useCalendar((s) => s.next);
  const goToday = useCalendar((s) => s.today);

  const todos = useTodos((s) => s.todos);
  const toggleTodo = useTodos((s) => s.toggle);

  const [dialog, setDialog] = useState<{
    mode: 'create' | 'edit';
    event?: CalendarEvent;
    defaultDate?: string;
    /** 在时间轴上点了 14:00 的空白，新建弹窗就该带着 14:00 打开 */
    defaultStart?: string;
  } | null>(null);

  const today = todayKey();

  const cursorDate = useMemo(() => {
    const [y, m, d] = cursor.split('-').map(Number);
    return new Date(y, m - 1, d);
  }, [cursor]);

  const headerLabel = useMemo(() => {
    if (view === 'month') {
      return `${cursorDate.getFullYear()} 年 ${cursorDate.getMonth() + 1} 月`;
    }
    if (view === 'week') {
      const days = weekDays(cursorDate);
      const s = days[0];
      const e = days[6];
      if (s.getMonth() === e.getMonth()) {
        return `${s.getFullYear()} 年 ${s.getMonth() + 1} 月 ${s.getDate()}-${e.getDate()} 日`;
      }
      return `${s.getMonth() + 1}/${s.getDate()} - ${e.getMonth() + 1}/${e.getDate()}`;
    }
    return `${cursorDate.getFullYear()} 年 ${cursorDate.getMonth() + 1} 月 ${cursorDate.getDate()} 日`;
  }, [view, cursorDate]);

  const gridDates = useMemo(() => {
    if (view === 'month') return monthGrid(cursorDate.getFullYear(), cursorDate.getMonth());
    if (view === 'week') return weekDays(cursorDate);
    return [cursorDate];
  }, [view, cursorDate]);

  const eventMap = useMemo(() => eventsInRange(events, gridDates), [events, gridDates]);

  const selectedItems = useMemo(
    () => (selectedDate ? unifyForDate(events, todos, selectedDate) : []),
    [events, todos, selectedDate],
  );

  const todayItems = useMemo(
    () => unifyForDate(events, todos, today),
    [events, todos, today],
  );

  const handleItemClick = (item: UnifiedItem) => {
    if (item.type === 'event' && item.source === 'manual') {
      setDialog({ mode: 'edit', event: item.raw as CalendarEvent });
    } else if (item.type === 'todo') {
      toggleTodo(item.id);
    }
  };

  return (
    <div className="flex min-w-0 flex-1">
      {/* 左侧日历面板 */}
      <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
        {/* 顶栏 */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface-4 px-5">
          <div className="flex items-center gap-3">
            <span className="text-[15px] font-semibold text-ink">{headerLabel}</span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={prev}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={goToday}
                className="h-7 rounded-md px-2 text-xs text-ink-2 transition hover:bg-fill-hover"
              >
                今天
              </button>
              <button
                onClick={next}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-line">
              {(['month', 'week', 'day'] as CalendarView[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`h-7 px-3 text-xs transition first:rounded-l-md last:rounded-r-md ${
                    view === v
                      ? 'bg-primary text-white'
                      : 'text-ink-2 hover:bg-fill-hover'
                  }`}
                >
                  {VIEW_LABELS[v]}
                </button>
              ))}
            </div>
            <button
              onClick={() => setDialog({ mode: 'create', defaultDate: selectedDate ?? today })}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover"
            >
              <Plus size={14} />
              新建日程
            </button>
          </div>
        </header>

        {/* 日历网格 */}
        {view === 'month' ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* 星期头（按周起始日排，国内习惯周一） */}
            <div className="grid grid-cols-7 border-b border-line bg-surface-4">
              {WEEK_HEADERS.map((name, i) => (
                <div key={i} className="py-2 text-center text-xs font-medium text-ink-3">
                  {name}
                </div>
              ))}
            </div>

            {/* 日期格子：直接显示日程标题。
                之前一个 100px 高的格子里只画三个 1.5px 的圆点 —— 月视图的价值就是
                「扫一眼这个月有什么」，只给点等于没给。 */}
            <div
              className="grid flex-1 grid-cols-7 overflow-y-auto"
              style={{ gridTemplateRows: `repeat(${gridDates.length / 7}, minmax(0, 1fr))` }}
            >
              {gridDates.map((d) => {
                const key = dateKey(d);
                const dayEvents = eventMap.get(key) ?? [];
                const dayTodos = todos.filter((t) => t.due === key && !t.done);
                return (
                  <MonthCell
                    key={key}
                    date={d}
                    isCurrentMonth={d.getMonth() === cursorDate.getMonth()}
                    isToday={key === today}
                    isSelected={key === selectedDate}
                    events={dayEvents}
                    todos={dayTodos}
                    onSelect={() => {
                      setSelectedDate(key);
                      if (d.getMonth() !== cursorDate.getMonth()) setCursor(key);
                    }}
                    onPick={(e) => setDialog({ mode: 'edit', event: e })}
                    onCreate={() => setDialog({ mode: 'create', defaultDate: key })}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          /* 周 / 日视图：真正的时间轴 */
          <TimeGrid
            days={gridDates}
            events={events}
            todos={todos}
            onPick={(e) => setDialog({ mode: 'edit', event: e })}
            onCreate={(date, hour) =>
              setDialog({
                mode: 'create',
                defaultDate: date,
                defaultStart: `${String(hour).padStart(2, '0')}:00`,
              })
            }
          />
        )}
      </main>

      {/* 右侧详情面板 */}
      <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface-4">
        {/* 选中日期的日程 */}
        <div className="border-b border-line px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">
              {selectedDate
                ? (() => {
                    const d = new Date(selectedDate + 'T00:00:00');
                    return `${d.getMonth() + 1}月${d.getDate()}日 · 周${DAY_NAMES[d.getDay()]}`;
                  })()
                : '选择日期'}
            </span>
            <button
              onClick={() =>
                setDialog({
                  mode: 'create',
                  defaultDate: selectedDate ?? today,
                })
              }
              className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {selectedDate && selectedItems.length > 0 ? (
            <div className="py-1">
              {selectedItems.map((item) => (
                <EventItem key={item.id} item={item} onClick={() => handleItemClick(item)} />
              ))}
            </div>
          ) : (
            selectedDate && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="text-xs text-ink-3">暂无日程</div>
                <button
                  onClick={() => setDialog({ mode: 'create', defaultDate: selectedDate })}
                  className="text-xs text-primary transition hover:underline"
                >
                  添加日程
                </button>
              </div>
            )
          )}

          {/* 今日概览（当选中日期不是今天时显示） */}
          {selectedDate !== today && todayItems.length > 0 && (
            <div className="border-t border-line">
              <div className="px-4 py-2.5">
                <span className="text-xs font-medium text-ink-3">今日日程</span>
              </div>
              {todayItems.map((item) => (
                <EventItem key={`today-${item.id}`} item={item} onClick={() => handleItemClick(item)} />
              ))}
            </div>
          )}

          {/* 近期待办 */}
          {(() => {
            const upcoming = todos
              .filter((t) => !t.done && t.due && t.due >= today)
              .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))
              .slice(0, 5);
            if (upcoming.length === 0) return null;
            return (
              <div className="border-t border-line">
                <div className="px-4 py-2.5">
                  <span className="text-xs font-medium text-ink-3">近期待办</span>
                </div>
                {upcoming.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      if (t.due) {
                        setSelectedDate(t.due);
                        setCursor(t.due);
                      }
                    }}
                    className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-fill-hover"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">
                      {t.note || t.excerpt}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-3">{t.due}</span>
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      </aside>

      {/* 对话框 */}
      {dialog && (
        <CalendarEventDialog
          existing={dialog.mode === 'edit' ? dialog.event : undefined}
          defaultDate={dialog.defaultDate}
          defaultStart={dialog.defaultStart}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
