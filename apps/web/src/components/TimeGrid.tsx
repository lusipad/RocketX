import { useEffect, useMemo, useRef } from 'react';
import { dateKey, eventsForDate, DAY_NAMES, type CalendarEvent } from '../stores/calendar';
import { isOverdue, type Todo } from '../stores/todos';

/**
 * 周/日视图的时间轴。
 *
 * 之前的「周视图」是把月视图砍成一行：7 根空柱子，只有小圆点，没有任何小时刻度 ——
 * 于是 startTime/endTime 存了也无处安放，14:00 的会和 09:00 的会长得一模一样。
 * 日历真正的价值就是「这一天的时间被谁占了」，没有时间轴就等于没做。
 */

const HOUR_HEIGHT = 48; // 每小时的像素高度
const START_HOUR = 0;
const END_HOUR = 24;

/** "HH:mm" → 距 0 点的分钟数；解析不了就返回 null */
function toMinutes(hhmm?: string): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

interface Positioned {
  event: CalendarEvent;
  top: number;
  height: number;
  /** 同一时段重叠时的横向分栏 */
  column: number;
  columns: number;
}

/** 把有时间的事件按时间定位，并解决重叠（重叠的并排显示，而不是叠在一起看不见） */
function layout(events: CalendarEvent[]): { timed: Positioned[]; allDay: CalendarEvent[] } {
  const allDay: CalendarEvent[] = [];
  const spans: { event: CalendarEvent; start: number; end: number }[] = [];

  for (const e of events) {
    const start = toMinutes(e.startTime);
    if (e.allDay || start === null) {
      allDay.push(e);
      continue;
    }
    // 没写结束时间就按 1 小时算，否则块会没有高度
    const end = toMinutes(e.endTime) ?? start + 60;
    spans.push({ event: e, start, end: Math.max(end, start + 15) });
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  // 把时间上有交叠的分成一簇，簇内并排
  const timed: Positioned[] = [];
  let cluster: typeof spans = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    cluster.forEach((s, i) => {
      timed.push({
        event: s.event,
        top: ((s.start - START_HOUR * 60) / 60) * HOUR_HEIGHT,
        height: Math.max(((s.end - s.start) / 60) * HOUR_HEIGHT, 18),
        column: i,
        columns: cluster.length,
      });
    });
    cluster = [];
    clusterEnd = -1;
  };

  for (const s of spans) {
    if (cluster.length && s.start >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  flush();

  return { timed, allDay };
}

function DayColumn({
  date,
  events,
  todos,
  onPick,
  onCreate,
}: {
  date: Date;
  events: CalendarEvent[];
  todos: Todo[];
  onPick: (e: CalendarEvent) => void;
  onCreate: (date: string, hour: number) => void;
}) {
  const key = dateKey(date);
  const dayEvents = useMemo(() => eventsForDate(events, key), [events, key]);
  const { timed, allDay } = useMemo(() => layout(dayEvents), [dayEvents]);
  const dayTodos = useMemo(() => todos.filter((t) => t.due === key && !t.done), [todos, key]);
  const today = dateKey(new Date());

  return (
    <div className="relative flex-1 border-r border-line last:border-r-0">
      {/* 全天事件与待办：钉在顶部，不参与时间轴 */}
      {(allDay.length > 0 || dayTodos.length > 0) && (
        <div className="space-y-0.5 border-b border-line bg-fill-1 p-1">
          {allDay.map((e) => (
            <button
              key={e.id}
              onClick={() => onPick(e)}
              className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white"
              style={{ background: e.color }}
            >
              {e.title}
            </button>
          ))}
          {dayTodos.map((t) => (
            <div
              key={t.id}
              className={`truncate rounded px-1.5 py-0.5 text-[11px] ${
                isOverdue(t) ? 'bg-danger/15 text-danger' : 'bg-fill-2 text-ink-2'
              }`}
              title="来自待办"
            >
              ☑ {t.note || t.excerpt}
            </div>
          ))}
        </div>
      )}

      {/* 时间轴：每小时一格，点空白直接建日程 */}
      <div className="relative" style={{ height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
        {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
          <button
            key={i}
            onClick={() => onCreate(key, START_HOUR + i)}
            className="block w-full border-b border-line/60 transition hover:bg-fill-hover"
            style={{ height: HOUR_HEIGHT }}
            title={`新建 ${String(START_HOUR + i).padStart(2, '0')}:00 的日程`}
          />
        ))}

        {timed.map((p) => {
          const width = 100 / p.columns;
          return (
            <button
              key={p.event.id}
              onClick={() => onPick(p.event)}
              className="absolute overflow-hidden rounded px-1.5 py-0.5 text-left text-[11px] leading-tight text-white shadow-sm"
              style={{
                top: p.top,
                height: p.height,
                left: `calc(${p.column * width}% + 2px)`,
                width: `calc(${width}% - 4px)`,
                background: p.event.color,
              }}
              title={`${p.event.startTime}${p.event.endTime ? ` - ${p.event.endTime}` : ''} ${p.event.title}`}
            >
              <div className="truncate font-medium">{p.event.title}</div>
              {p.height > 30 && (
                <div className="truncate opacity-85">
                  {p.event.startTime}
                  {p.event.endTime ? ` - ${p.event.endTime}` : ''}
                </div>
              )}
            </button>
          );
        })}

        {/* 当前时刻的红线（只画在今天） */}
        {key === today && <NowLine />}
      </div>
    </div>
  );
}

function NowLine() {
  const now = new Date();
  const top = ((now.getHours() * 60 + now.getMinutes() - START_HOUR * 60) / 60) * HOUR_HEIGHT;
  return (
    <div className="pointer-events-none absolute right-0 left-0 z-10 flex items-center" style={{ top }}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
      <span className="h-px flex-1 bg-danger" />
    </div>
  );
}

/** 周视图 / 日视图（days 长度 7 或 1） */
export default function TimeGrid({
  days,
  events,
  todos,
  onPick,
  onCreate,
}: {
  days: Date[];
  events: CalendarEvent[];
  todos: Todo[];
  onPick: (e: CalendarEvent) => void;
  onCreate: (date: string, hour: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = dateKey(new Date());

  // 打开时滚到早上 8 点：默认停在 0 点的话，一屏全是凌晨
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 8 * HOUR_HEIGHT;
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 日期表头 */}
      <div className="flex shrink-0 border-b border-line pl-12">
        {days.map((d) => {
          const isToday = dateKey(d) === today;
          return (
            <div key={dateKey(d)} className="flex-1 py-2 text-center">
              <div className="text-[11px] text-ink-3">周{DAY_NAMES[d.getDay()]}</div>
              <div
                className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-sm ${
                  isToday ? 'bg-primary font-medium text-white' : 'text-ink'
                }`}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 overflow-y-auto">
        {/* 小时刻度 */}
        <div className="w-12 shrink-0">
          {/* 与列内的全天区对齐：全天区高度不定，这里用 sticky 的相对定位躲开 */}
          <div style={{ height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }} className="relative">
            {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
              <div
                key={i}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-ink-3"
                style={{ top: i * HOUR_HEIGHT }}
              >
                {i > 0 ? `${String(START_HOUR + i).padStart(2, '0')}:00` : ''}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-1">
          {days.map((d) => (
            <DayColumn
              key={dateKey(d)}
              date={d}
              events={events}
              todos={todos}
              onPick={onPick}
              onCreate={onCreate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
