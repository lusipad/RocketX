import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useT, type MessageKey } from '../i18n';
import { todayKey, useTodos, type Todo } from '../stores/todos';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import Dialog from './Dialog';

/** 快捷截止日期：相对今天的天数 */
const QUICK: { labelKey: MessageKey; days: number }[] = [
  { labelKey: 'pages.todoDialog.quickToday', days: 0 },
  { labelKey: 'pages.todoDialog.quickTomorrow', days: 1 },
  { labelKey: 'pages.todoDialog.quickThisWeek', days: 7 },
];

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return todayKey(d);
}

/**
 * 标记待办 / 编辑待办 / 手动新建待办。
 * 消息原文只读展示——从消息标记的待办是「围绕这条消息要做的事」，改的是备注不是消息。
 * source 和 existing 都不传时是手动新建（issue #64），note 就是待办正文，必填。
 */
export default function TodoDialog({
  source,
  existing,
  initialNote,
  initialDue,
  onClose,
}: {
  /** 从消息新建时传消息快照 */
  source?: Omit<Todo, 'id' | 'done' | 'createdAt' | 'note' | 'due'>;
  /** 编辑时传已有待办 */
  existing?: Todo;
  initialNote?: string;
  initialDue?: string;
  onClose: () => void;
}) {
  const t = useT();
  const add = useTodos((s) => s.add);
  const update = useTodos((s) => s.update);
  const setModule = useUI((s) => s.setModule);

  const [note, setNote] = useState(existing?.note ?? initialNote ?? '');
  const [due, setDue] = useState(existing?.due ?? initialDue ?? '');
  const [committedTo, setCommittedTo] = useState(existing?.committedTo ?? '');
  const [waitingFor, setWaitingFor] = useState(existing?.waitingFor ?? '');

  const excerpt = existing?.excerpt ?? source?.excerpt ?? '';
  const roomName = existing?.roomName ?? source?.roomName ?? '';
  const author = existing?.author ?? source?.author ?? '';
  // 有来源消息（新建传 source / 编辑锚定过消息）才展示引用块
  const hasSource = !!(existing ? existing.mid : source?.mid);
  const manualCreate = !existing && !source;
  // 手动待办没有消息原文可退回，note 就是正文，新建和编辑都不能为空
  const noteRequired = manualCreate || (!!existing && !existing.mid);
  const canSubmit = !noteRequired || !!note.trim();

  const submit = () => {
    if (!canSubmit) return;
    const nextCommittedTo = committedTo.trim() || undefined;
    const nextWaitingFor = nextCommittedTo ? undefined : waitingFor.trim() || undefined;
    if (existing) {
      update(existing.id, {
        note: note.trim() || undefined,
        due: due || undefined,
        committedTo: nextCommittedTo,
        waitingFor: nextWaitingFor,
      });
      toast.success(t('pages.todoDialog.updated'));
    } else if (source) {
      add({
        ...source,
        note: note.trim() || undefined,
        due: due || undefined,
        committedTo: nextCommittedTo,
        waitingFor: nextWaitingFor,
      });
      toast.success(t('pages.todoDialog.added'), { label: t('pages.todoDialog.viewAction'), onClick: () => setModule('todos') });
    } else {
      add({
        note: note.trim(),
        due: due || undefined,
        committedTo: nextCommittedTo,
        waitingFor: nextWaitingFor,
      });
      toast.success(t('pages.todoDialog.added'));
    }
    onClose();
  };

  return (
    <Dialog
      title={t(existing ? 'pages.todoDialog.titleEdit' : manualCreate ? 'pages.todoDialog.titleNew' : 'pages.todoDialog.titleMark')}
      hint={
        t(manualCreate ? 'pages.todoDialog.hintManual' : 'pages.todoDialog.hintFromMessage')
      }
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {existing ? t('common.save') : t('pages.todoDialog.addSubmit')}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-5 pb-2">
        {/* 来源消息；手动新建的待办没有 */}
        {hasSource && (
          <div className="rounded-r-md border-l-2 border-primary/40 bg-fill-1 px-3 py-2">
            <div className="text-xs text-ink-3">
              {roomName} · {author}
            </div>
            <div className="mt-0.5 line-clamp-3 text-sm break-words text-ink-2">
              {excerpt || t('pages.todos.emptyContent')}
            </div>
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs text-ink-3">
            {t(noteRequired ? 'pages.todoDialog.noteLabelRequired' : 'pages.todoDialog.noteLabelOptional')}
          </label>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={t('pages.todoDialog.notePlaceholder')}
            className="w-full resize-none rounded-md border border-line px-2.5 py-1.5 text-sm outline-none transition focus:border-primary"
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-ink-3">{t('pages.todoDialog.committedToLabel')}</label>
            <input
              value={committedTo}
              onChange={(e) => {
                setCommittedTo(e.target.value);
                if (e.target.value.trim()) setWaitingFor('');
              }}
              placeholder={t('pages.todoDialog.committedToPlaceholder')}
              className="h-8 w-full rounded-md border border-line px-2.5 text-sm outline-none transition focus:border-primary"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-ink-3">{t('pages.todoDialog.waitingForLabel')}</label>
            <input
              value={waitingFor}
              onChange={(e) => {
                setWaitingFor(e.target.value);
                if (e.target.value.trim()) setCommittedTo('');
              }}
              placeholder={t('pages.todoDialog.waitingForPlaceholder')}
              className="h-8 w-full rounded-md border border-line px-2.5 text-sm outline-none transition focus:border-primary"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1 text-xs text-ink-3">
            <CalendarDays size={12} />
            {t('pages.todoDialog.dueDateLabel')}
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={due}
              min={todayKey()}
              onChange={(e) => setDue(e.target.value)}
              className="h-8 rounded-md border border-line px-2 text-sm text-ink outline-none transition focus:border-primary"
            />
            {QUICK.map((q) => (
              <button
                key={q.labelKey}
                onClick={() => setDue(shift(q.days))}
                className={`h-8 rounded-md border px-2.5 text-xs transition ${
                  due === shift(q.days)
                    ? 'border-primary bg-primary-light text-primary'
                    : 'border-line text-ink-2 hover:bg-fill-hover'
                }`}
              >
                {t(q.labelKey)}
              </button>
            ))}
            {due && (
              <button
                onClick={() => setDue('')}
                className="h-8 px-1.5 text-xs text-ink-3 hover:text-danger"
              >
                {t('pages.todoDialog.clearDue')}
              </button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
