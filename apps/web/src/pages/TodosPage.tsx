import { useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  ExternalLink,
  ListTodo,
  Pencil,
  Plus,
  Trash2,
  CornerUpRight,
  Kanban,
} from 'lucide-react';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { dueLabel, isOverdue, todayKey, useTodos, type Todo } from '../stores/todos';
import { toast } from '../stores/toast';
import { emojify } from '../lib/emoji';
import { useDayTick } from '../lib/format';
import TodoDialog from '../components/TodoDialog';
import { ConfirmDialog } from '../components/Dialog';
import { LinkifiedText } from '../lib/markdown';
import { adoWebBase } from '../lib/ado';
import { useI18n, useT, type MessageKey } from '../i18n';

// 统一看板矩阵与多会话流转已升级由 AI 管家原生看板承载 (WorkKanbanBoard)

type Tab = 'open' | 'today' | 'overdue' | 'done';

const TABS: { key: Tab; labelKey: MessageKey; icon: typeof ListTodo }[] = [
  { key: 'open', labelKey: 'pages.todos.tab.open', icon: ListTodo },
  { key: 'today', labelKey: 'pages.todos.tab.today', icon: CalendarClock },
  { key: 'overdue', labelKey: 'pages.todos.tab.overdue', icon: CalendarClock },
  { key: 'done', labelKey: 'pages.todos.tab.done', icon: CheckCircle2 },
];

function TodoRow({ todo, onEdit }: { todo: Todo; onEdit: (t: Todo) => void }) {
  const t = useT();
  const toggle = useTodos((s) => s.toggle);
  const remove = useTodos((s) => s.remove);
  const openRoom = useChat((s) => s.openRoom);
  const jumpToMessage = useChat((s) => s.jumpToMessage);
  const setModule = useUI((s) => s.setModule);
  const setButlerView = useUI((s) => s.setButlerView);
  const overdue = isOverdue(todo);
  // 手动新建的待办没有来源消息，跳转和来源行都不展示
  const hasSource = !!(todo.rid && todo.mid);
  /**
   * 从 Azure DevOps 工作项转来的待办。字段（adoWorkItemId / adoProject）一直有，
   * 只是从来没有人用它开过一个入口——「这条待办是哪来的」于是无从回溯。
   */
  const adoWebBaseUrl = adoWebBase();
  const workItemUrl = todo.adoWorkItemId && adoWebBaseUrl
    ? `${adoWebBaseUrl}${todo.adoProject ? `/${encodeURIComponent(todo.adoProject)}` : ''}/_workitems/edit/${todo.adoWorkItemId}`
    : null;

  const jump = async () => {
    if (!todo.rid || !todo.mid) return;
    setModule('messages');
    await openRoom(todo.rid);
    await jumpToMessage(todo.mid, todo.rid);
  };

  return (
    <div className="group flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-fill-2">
      <button
        onClick={() => toggle(todo.id)}
        className="mt-0.5 shrink-0 text-ink-3 transition hover:text-primary"
        title={t(todo.done ? 'pages.todos.markUndone' : 'pages.todos.markDone')}
      >
        {todo.done ? (
          <CheckCircle2 size={16} className="text-primary" />
        ) : (
          <Circle size={16} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        {/* 自己写的说明是主角；没写就退回消息原文 */}
        <div
          className={`text-sm break-words ${
            todo.done ? 'text-ink-3 line-through' : 'font-medium text-ink'
          }`}
        >
          <LinkifiedText text={todo.note || todo.excerpt || todo.title || t('pages.todos.emptyContent')} renderPlain={emojify} />
        </div>

        {todo.note && hasSource && (
          <div className="mt-1 line-clamp-2 rounded-r border-l-2 border-line bg-fill-1 px-2 py-1 text-xs break-words text-ink-3">
            <LinkifiedText text={todo.excerpt ?? t('pages.todos.emptyContent')} renderPlain={emojify} />
          </div>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {hasSource && (
            <span className="truncate">
              {todo.roomName} · {todo.author}
            </span>
          )}
          {todo.adoWorkItemId && (
            <span className="truncate">
              {t('pages.todos.workItemLabel', { id: todo.adoWorkItemId })}
              {todo.adoProject ? ` · ${todo.adoProject}` : ''}
            </span>
          )}
          {todo.due && (
            <span
              className={`rounded px-1.5 py-0.5 ${
                overdue
                  ? 'bg-danger/10 font-medium text-danger'
                  : todo.due === todayKey()
                    ? 'bg-warning/10 text-warning'
                    : 'bg-fill-2'
              }`}
            >
              {dueLabel(todo.due)}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        {hasSource && (
          <button
            onClick={() => void jump()}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
            title={t('pages.todos.jumpToMessage')}
          >
            <CornerUpRight size={14} />
          </button>
        )}
        {workItemUrl && todo.adoWorkItemId && (
          <a
            href={workItemUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
            title={t('pages.todos.openWorkItem', { id: todo.adoWorkItemId })}
          >
            <ExternalLink size={14} />
          </a>
        )}
        <button
          onClick={() => {
            setModule('butler-view');
            setButlerView('kanban');
          }}
          className="flex h-7 items-center gap-1 rounded px-1.5 text-ink-3 transition hover:bg-fill-hover hover:text-primary"
          title={t('pages.todos.advanceInKanbanTitle')}
        >
          <Kanban size={13} />
          <span className="text-xs">{t('pages.todos.advanceAction')}</span>
        </button>
        <button
          onClick={() => onEdit(todo)}
          className="flex h-7 w-7 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
          title={t('common.edit')}
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={() => {
            remove(todo.id);
            toast.success(t('pages.todos.deleted'));
          }}
          className="flex h-7 w-7 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-danger"
          title={t('common.delete')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/** 待办模块：从聊天里捞出来的事，点回原消息就能看上下文 */
export default function TodosPage() {
  // 跨过零点后「今天到期 / 已逾期」要跟着变
  useDayTick();
  const { t, tp } = useI18n();
  const todos = useTodos((s) => s.todos);
  const clearDone = useTodos((s) => s.clearDone);
  const [tab, setTab] = useState<Tab>('open');
  const [editing, setEditing] = useState<Todo | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const counts = useMemo(() => {
    const today = todayKey();
    return {
      open: todos.filter((t) => !t.done).length,
      today: todos.filter((t) => !t.done && t.due === today).length,
      overdue: todos.filter((t) => isOverdue(t, today)).length,
      done: todos.filter((t) => t.done).length,
    } as Record<Tab, number>;
  }, [todos]);

  const list = useMemo(() => {
    const today = todayKey();
    const pick =
      tab === 'open'
        ? todos.filter((t) => !t.done)
        : tab === 'today'
          ? todos.filter((t) => !t.done && t.due === today)
          : tab === 'overdue'
            ? todos.filter((t) => isOverdue(t, today))
            : todos.filter((t) => t.done);
    // 有截止日的排前面，越紧急越靠上；都没截止日就按创建时间倒序
    return [...pick].sort((a, b) => {
      if (tab === 'done') return (b.doneAt ?? 0) - (a.doneAt ?? 0);
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return b.createdAt - a.createdAt;
    });
  }, [todos, tab]);

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-line bg-surface-2 p-3">
        <div className="px-2.5 py-2 text-base font-semibold text-ink">{t('pages.todos.title')}</div>
        <div className="flex flex-col gap-0.5">
          {TABS.map(({ key, labelKey, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition ${
                tab === key
                  ? 'bg-surface-4 font-medium text-ink shadow-raise ring-1 ring-line/80'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <Icon size={16} className={tab === key ? 'text-primary' : ''} />
              <span>{t(labelKey)}</span>
              {counts[key] > 0 && (
                <span
                  className={`ml-auto rounded-full px-1.5 py-0.5 text-2xs font-medium ${
                    key === 'overdue'
                      ? 'bg-danger/10 text-danger'
                      : 'bg-fill-1 text-ink-3'
                  }`}
                >
                  {counts[key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-auto border-t border-line-soft pt-3">
          <button
            type="button"
            onClick={() => {
              useUI.getState().setModule('butler-view');
              useUI.getState().setButlerView('kanban');
            }}
            className="group flex w-full items-center justify-between rounded-xl border border-line bg-surface-4 p-3 text-left text-xs shadow-raise transition hover:border-primary/50 hover:shadow-card"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
                <Kanban size={15} />
              </span>
              <div>
                <div className="font-medium text-ink group-hover:text-primary">{t('pages.todos.butlerKanbanTitle')}</div>
                <div className="mt-0.5 text-xs text-ink-3">{t('pages.todos.butlerKanbanSubtitle')}</div>
              </div>
            </div>
            <CornerUpRight size={13} className="text-ink-3 transition group-hover:text-primary" />
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
        <header className="rcx-glass-header flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-ink">
              {t(TABS.find((item) => item.key === tab)!.labelKey)}
            </h1>
            <span className="rounded-full border border-line-soft bg-surface-2 px-2 py-0.5 text-xs text-ink-3">
              {tp(list.length, 'pages.todos.countOne', 'pages.todos.countOther')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {tab === 'done' && list.length > 0 && (
              <button
                onClick={() => setConfirmClear(true)}
                className="rounded-lg px-2.5 py-1 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-danger"
              >
                {t('pages.todos.clearDone')}
              </button>
            )}
            <button
              onClick={() => setCreating(true)}
              className="flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
            >
              <Plus size={14} />
              {t('pages.todos.newTodo')}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="overflow-hidden rounded-2xl border border-line bg-surface-4 shadow-card">
            {list.map((todo) => (
              <TodoRow key={todo.id} todo={todo} onEdit={setEditing} />
            ))}
            {list.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line-soft bg-surface-2 text-ink-3">
                  <ListTodo size={24} />
                </span>
                <div className="text-sm font-medium text-ink-2">
                  {t(tab === 'done' ? 'pages.todos.emptyDone' : 'pages.todos.emptyOpen')}
                </div>
                <div className="max-w-xs text-xs leading-relaxed text-ink-3">
                  {t('pages.todos.emptyHint')}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {editing && <TodoDialog existing={editing} onClose={() => setEditing(null)} />}
      {creating && <TodoDialog onClose={() => setCreating(false)} />}
      {confirmClear && (
        <ConfirmDialog
          title={t('pages.todos.clearDone')}
          message={tp(counts.done, 'pages.todos.clearDoneConfirmOne', 'pages.todos.clearDoneConfirmOther')}
          confirmLabel={t('pages.todos.clearAction')}
          onConfirm={() => {
            clearDone();
            toast.success(t('pages.todos.cleared'));
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
