import { useState } from 'react';
import { X } from 'lucide-react';
import {
  useCalendar,
  randomColor,
  REPEAT_LABELS,
  DAY_NAMES,
  type CalendarEvent,
  type RepeatRule,
} from '../stores/calendar';
import { toast } from '../stores/toast';

const COLORS = [
  '#3370ff', '#00b96b', '#7f3bf5', '#f54a45', '#ff8800',
  '#14b8a6', '#f472b6', '#8b5cf6', '#06b6d4', '#84cc16',
];


/** '14:00' → '15:00' */
function plusHour(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default function CalendarEventDialog({
  existing,
  defaultDate,
  defaultStart,
  onClose,
}: {
  existing?: CalendarEvent;
  defaultDate?: string;
  /** 在时间轴上点某个小时新建时带进来（如 '14:00'） */
  defaultStart?: string;
  onClose: () => void;
}) {
  const add = useCalendar((s) => s.add);
  const update = useCalendar((s) => s.update);
  const remove = useCalendar((s) => s.remove);

  const [title, setTitle] = useState(existing?.title ?? '');
  const [desc, setDesc] = useState(existing?.description ?? '');
  const [date, setDate] = useState(existing?.date ?? defaultDate ?? '');
  const [startTime, setStartTime] = useState(existing?.startTime ?? defaultStart ?? '');
  // 从时间轴点进来时默认排一小时，省得每次都填结束时间
  const [endTime, setEndTime] = useState(
    existing?.endTime ?? (defaultStart ? plusHour(defaultStart) : ''),
  );
  // 日历里绝大多数日程是有时间的（会议、1v1），全天事件（生日、假期）是少数。
  // 默认全天等于逼每个人都多点一下。
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [color, setColor] = useState(existing?.color ?? randomColor());
  const [repeatEnabled, setRepeatEnabled] = useState(!!existing?.repeat);
  const [repeatType, setRepeatType] = useState<RepeatRule['type']>(existing?.repeat?.type ?? 'weekly');
  const [repeatInterval, setRepeatInterval] = useState(existing?.repeat?.interval ?? 1);
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>(existing?.repeat?.weekdays ?? []);
  const [repeatEndDate, setRepeatEndDate] = useState(existing?.repeat?.endDate ?? '');
  const [repeatEndAfter, setRepeatEndAfter] = useState<number | undefined>(existing?.repeat?.endAfter);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isEdit = !!existing;
  /**
   * 保存校验。
   * 之前只查了「标题和日期非空」，于是：取消全天却不填时间照样存（排序时被当成全天事件），
   * 选了「自定义重复」却一个星期几都不勾也照样存（保存成功、提示已创建、实际不重复）。
   */
  const timeInvalid = !allDay && (!startTime || (!!endTime && endTime <= startTime));
  const repeatInvalid = repeatEnabled && repeatType === 'custom' && repeatWeekdays.length === 0;
  const canSave = !!title.trim() && !!date && !timeInvalid && !repeatInvalid;

  const handleSave = () => {
    if (!canSave) return;
    const repeat: RepeatRule | undefined = repeatEnabled
      ? {
          type: repeatType,
          interval: repeatInterval,
          weekdays: repeatType === 'custom' ? repeatWeekdays : undefined,
          endDate: repeatEndDate || undefined,
          endAfter: repeatEndAfter,
        }
      : undefined;

    const data = {
      title: title.trim(),
      description: desc.trim() || undefined,
      date,
      startTime: allDay ? undefined : startTime || undefined,
      endTime: allDay ? undefined : endTime || undefined,
      allDay,
      color,
      repeat,
      source: 'manual' as const,
    };

    if (isEdit) {
      update(existing.id, data);
      toast.success('日程已更新');
    } else {
      add(data);
      toast.success('日程已创建');
    }
    onClose();
  };

  const handleDelete = () => {
    if (existing) {
      remove(existing.id);
      toast.success('日程已删除');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[480px] max-h-[85vh] overflow-y-auto rounded-xl border border-line bg-surface-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <span className="text-[15px] font-semibold text-ink">
            {isEdit ? '编辑日程' : '新建日程'}
          </span>
          <button onClick={onClose} className="text-ink-3 transition hover:text-ink">
            <X size={18} />
          </button>
        </header>

        <div className="space-y-4 p-5">
          {/* 标题 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入日程标题"
              autoFocus
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none transition focus:border-primary"
            />
          </div>

          {/* 日期 */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-ink-2">日期</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none transition focus:border-primary"
              />
            </div>
            <div className="flex items-end">
              <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-ink-2">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                  className="accent-primary"
                />
                全天
              </label>
            </div>
          </div>

          {/* 时间 */}
          {!allDay && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-ink-2">开始时间</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none transition focus:border-primary"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-ink-2">结束时间</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none transition focus:border-primary"
                />
              </div>
            </div>
          )}

          {/* 颜色 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-2">颜色</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-primary' : 'hover:scale-110'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>

          {/* 描述 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">描述</label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="可选"
              rows={2}
              className="w-full rounded-md border border-line bg-surface-3 px-3 py-2 text-sm text-ink outline-none transition focus:border-primary resize-none"
            />
          </div>

          {/* 重复 */}
          <div className="space-y-3 rounded-lg border border-line p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={repeatEnabled}
                onChange={(e) => setRepeatEnabled(e.target.checked)}
                className="accent-primary"
              />
              <span className="font-medium">重复</span>
            </label>

            {repeatEnabled && (
              <div className="space-y-3 pl-1">
                <div className="flex gap-3">
                  <select
                    value={repeatType}
                    onChange={(e) => setRepeatType(e.target.value as RepeatRule['type'])}
                    className="h-8 flex-1 rounded-md border border-line bg-surface-3 px-2 text-sm text-ink outline-none"
                  >
                    {Object.entries(REPEAT_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  {repeatType !== 'weekday' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-ink-3">每</span>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={repeatInterval}
                        onChange={(e) => setRepeatInterval(Math.max(1, Number(e.target.value)))}
                        className="h-8 w-14 rounded-md border border-line bg-surface-3 px-2 text-center text-sm text-ink outline-none"
                      />
                      <span className="text-xs text-ink-3">
                        {repeatType === 'daily' ? '天' : repeatType === 'weekly' ? '周' : repeatType === 'monthly' ? '月' : repeatType === 'yearly' ? '年' : ''}
                      </span>
                    </div>
                  )}
                </div>

                {repeatType === 'custom' && (
                  <div className="flex gap-1.5">
                    {DAY_NAMES.map((name, i) => (
                      <button
                        key={i}
                        onClick={() =>
                          setRepeatWeekdays((ws) =>
                            ws.includes(i) ? ws.filter((w) => w !== i) : [...ws, i],
                          )
                        }
                        className={`h-7 w-7 rounded-full text-xs transition ${
                          repeatWeekdays.includes(i)
                            ? 'bg-primary text-white'
                            : 'bg-fill-1 text-ink-3 hover:bg-fill-hover'
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="mb-1 block text-2xs text-ink-3">结束日期（可选）</label>
                    <input
                      type="date"
                      value={repeatEndDate}
                      onChange={(e) => setRepeatEndDate(e.target.value)}
                      className="h-8 w-full rounded-md border border-line bg-surface-3 px-2 text-sm text-ink outline-none"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-1 block text-2xs text-ink-3">重复次数（可选）</label>
                    <input
                      type="number"
                      min={1}
                      value={repeatEndAfter ?? ''}
                      onChange={(e) => {
                        // 小于 1(含 0、空)一律当「不限」——之前填 0 会存成 endAfter:0，
                        // 匹配逻辑里每一天都不成立，日程创建后凭空消失（P1-12）
                        const n = Number(e.target.value);
                        setRepeatEndAfter(Number.isFinite(n) && n >= 1 ? n : undefined);
                      }}
                      placeholder="不限"
                      className="h-8 w-full rounded-md border border-line bg-surface-3 px-2 text-sm text-ink outline-none"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底栏 */}
        <footer className="flex items-center justify-between border-t border-line px-5 py-3">
          <div>
            {isEdit && existing.source === 'manual' && (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-danger">确认删除？</span>
                  <button
                    onClick={handleDelete}
                    className="h-7 rounded bg-danger px-3 text-xs text-white"
                  >
                    删除
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="h-7 rounded border border-line px-3 text-xs text-ink-2"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs text-ink-3 transition hover:text-danger"
                >
                  删除日程
                </button>
              )
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
            >
              {isEdit ? '保存' : '创建'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
