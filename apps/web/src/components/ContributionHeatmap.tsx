import { useMemo } from 'react';
import type { ContributionEvent, ContributionRange } from '../lib/adoContributions';

const LEVEL_COLORS = [
  'var(--color-fill-1)',
  'color-mix(in srgb, var(--color-primary) 25%, var(--color-surface-3))',
  'color-mix(in srgb, var(--color-primary) 45%, var(--color-surface-3))',
  'color-mix(in srgb, var(--color-primary) 70%, var(--color-surface-3))',
  'var(--color-primary)',
] as const;

function parseLocalDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, 12);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export interface ContributionHeatmapDay {
  day: string;
  count: number;
  inRange: boolean;
}

export function buildContributionWeeks(
  range: ContributionRange,
  events: ContributionEvent[],
): ContributionHeatmapDay[][] {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.day, (counts.get(event.day) ?? 0) + 1);

  const from = parseLocalDay(range.from);
  const to = parseLocalDay(range.to);
  const first = addDays(from, -from.getDay());
  const last = addDays(to, 6 - to.getDay());
  const weeks: ContributionHeatmapDay[][] = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 7)) {
    weeks.push(
      Array.from({ length: 7 }, (_, offset) => {
        const day = dayKey(addDays(cursor, offset));
        return {
          day,
          count: counts.get(day) ?? 0,
          inRange: day >= range.from && day <= range.to,
        };
      }),
    );
  }
  return weeks;
}

export function contributionLevel(count: number, maximum: number): number {
  if (count <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / maximum) * 4)));
}

function monthLabels(weeks: ContributionHeatmapDay[][]): (string | null)[] {
  let previous = -1;
  return weeks.map((week) => {
    const firstInRange = week.find((day) => day.inRange);
    if (!firstInRange) return null;
    const month = parseLocalDay(firstInRange.day).getMonth();
    if (month === previous) return null;
    previous = month;
    return `${month + 1}月`;
  });
}

export default function ContributionHeatmap({
  events,
  range,
  selectedDay,
  onSelectDay,
}: {
  events: ContributionEvent[];
  range: ContributionRange;
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
}) {
  const weeks = useMemo(() => buildContributionWeeks(range, events), [events, range]);
  const labels = useMemo(() => monthLabels(weeks), [weeks]);
  const maximum = Math.max(0, ...weeks.flat().map((day) => day.count));

  return (
    <section
      aria-label="贡献日历"
      className="mx-auto w-fit max-w-full rounded-xl border border-line bg-surface-3 p-4"
    >
      <div className="max-w-full overflow-x-auto pb-2">
        <div className="mx-auto w-max">
          <div className="mb-1 ml-8 flex gap-1" aria-hidden="true">
            {labels.map((label, index) => (
              <span key={`${index}-${label ?? ''}`} className="w-3 whitespace-nowrap text-[10px] text-ink-3">
                {label}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="grid grid-rows-7 gap-1 pt-0.5 text-[10px] leading-3 text-ink-3" aria-hidden="true">
              <span />
              <span>一</span>
              <span />
              <span>三</span>
              <span />
              <span>五</span>
              <span />
            </div>
            <div className="flex gap-1">
              {weeks.map((week, weekIndex) => (
                <div key={week[0]?.day ?? weekIndex} className="grid grid-rows-7 gap-1">
                  {week.map((day) => {
                    if (!day.inRange) return <span key={day.day} className="h-3 w-3" aria-hidden="true" />;
                    const level = contributionLevel(day.count, maximum);
                    const label = `${new Intl.DateTimeFormat('zh-CN', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    }).format(parseLocalDay(day.day))}，${day.count} 项贡献`;
                    return (
                      <button
                        key={day.day}
                        type="button"
                        aria-label={label}
                        aria-pressed={selectedDay === day.day}
                        title={label}
                        onClick={() => onSelectDay(day.day)}
                        className={`h-3 w-3 rounded-[3px] border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                          selectedDay === day.day ? 'border-ink' : 'border-line/60'
                        }`}
                        style={{ background: LEVEL_COLORS[level] }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div
            aria-label="贡献强度图例"
            className="mt-3 flex items-center justify-end gap-1 text-[11px] text-ink-3"
          >
            <span className="mr-1">较少</span>
            {LEVEL_COLORS.map((color, index) => (
              <span
                key={color}
                aria-label={`贡献强度 ${index}`}
                className="h-3 w-3 rounded-[3px] border border-line/60"
                style={{ background: color }}
              />
            ))}
            <span className="ml-1">较多</span>
          </div>
        </div>
      </div>
    </section>
  );
}
