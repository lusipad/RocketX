import { useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  ListTodo,
  Pencil,
  Plus,
  Trash2,
  CornerUpRight,
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

type Tab = 'open' | 'today' | 'overdue' | 'done';

const TABS: { key: Tab; label: string; icon: typeof ListTodo }[] = [
  { key: 'open', label: '待办', icon: ListTodo },
  { key: 'today', label: '今天', icon: CalendarClock },
  { key: 'overdue', label: '已逾期', icon: CalendarClock },
  { key: 'done', label: '已完成', icon: CheckCircle2 },
];

function TodoRow({ todo, onEdit }: { todo: Todo; onEdit: (t: Todo) => void }) {
  const toggle = useTodos((s) => s.toggle);
  const remove = useTodos((s) => s.remove);
  const openRoom = useChat((s) => s.openRoom);
  const jumpToMessage = useChat((s) => s.jumpToMessage);
  const setModule = useUI((s) => s.setModule);
  const overdue = isOverdue(todo);
  // 手动新建的待办没有来源消息，跳转和来源行都不展示
  const hasSource = !!(todo.rid && todo.mid);

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
        title={todo.done ? '标记为未完成' : '标记为完成'}
      >
        {todo.done ? (
          <CheckCircle2 size={17} className="text-primary" />
        ) : (
          <Circle size={17} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        {/* 自己写的说明是主角；没写就退回消息原文 */}
        <div
          className={`text-sm break-words ${
            todo.done ? 'text-ink-3 line-through' : 'font-medium text-ink'
          }`}
        >
          <LinkifiedText text={todo.note || todo.excerpt || todo.title || '（无文字内容）'} renderPlain={emojify} />
        </div>

        {todo.note && hasSource && (
          <div className="mt-1 line-clamp-2 rounded-r border-l-2 border-line bg-fill-1 px-2 py-1 text-xs break-words text-ink-3">
            <LinkifiedText text={todo.excerpt ?? '（无文字内容）'} renderPlain={emojify} />
          </div>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {hasSource && (
            <span className="truncate">
              {todo.roomName} · {todo.author}
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
            title="跳到原消息"
          >
            <CornerUpRight size={14} />
          </button>
        )}
        <button
          onClick={() => onEdit(todo)}
          className="flex h-7 w-7 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
          title="编辑"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={() => {
            remove(todo.id);
            toast.success('待办已删除');
          }}
          className="flex h-7 w-7 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-danger"
          title="删除"
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
      <aside className="w-[200px] shrink-0 border-r border-line bg-fill-2 p-3">
        <div className="px-2 py-1.5 text-[15px] font-semibold text-ink">待办</div>
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
              tab === key ? 'bg-primary-light text-primary' : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            <Icon size={16} />
            {label}
            {counts[key] > 0 && (
              <span
                className={`ml-auto text-xs ${
                  key === 'overdue' ? 'font-medium text-danger' : 'text-ink-3'
                }`}
              >
                {counts[key]}
              </span>
            )}
          </button>
        ))}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-surface-3 p-5">
        <div className="flex items-center justify-between pb-3">
          <span className="text-sm text-ink-2">
            {TABS.find((t) => t.key === tab)?.label} · {list.length} 项
          </span>
          <div className="flex items-center gap-3">
            {tab === 'done' && list.length > 0 && (
              <button
                onClick={() => setConfirmClear(true)}
                className="text-xs text-ink-3 transition hover:text-danger"
              >
                清空已完成
              </button>
            )}
            <button
              onClick={() => setCreating(true)}
              className="flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover"
            >
              <Plus size={15} />
              新建待办
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto rounded-lg border border-line bg-surface-4">
          {list.map((t) => (
            <TodoRow key={t.id} todo={t} onEdit={setEditing} />
          ))}
          {list.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <ListTodo size={32} className="text-ink-3" />
              <div className="text-sm text-ink-3">
                {tab === 'done' ? '还没有完成的待办' : '这里是空的'}
              </div>
              <div className="max-w-xs text-xs leading-relaxed text-ink-3">
                在任意聊天消息上点右键，选「标记为待办」，就能把它捞到这里，
                还能补充说明和截止日期。点待办可以跳回原消息。
                也可以点右上角「新建待办」直接记一条。
              </div>
            </div>
          )}
        </div>
      </main>

      {editing && <TodoDialog existing={editing} onClose={() => setEditing(null)} />}
      {creating && <TodoDialog onClose={() => setCreating(false)} />}
      {confirmClear && (
        <ConfirmDialog
          title="清空已完成"
          message={`将删除 ${counts.done} 条已完成的待办，原消息不受影响。`}
          confirmLabel="清空"
          onConfirm={() => {
            clearDone();
            toast.success('已清空');
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
