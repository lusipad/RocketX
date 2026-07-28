import { Check, Clock3, ExternalLink, LoaderCircle } from 'lucide-react';
import type { ButlerTaskProjection } from '../lib/butlerWorkspace';

const GROUPS: Array<{
  states: ButlerTaskProjection['state'][];
  title: string;
  empty: string;
}> = [
  { states: ['needs-user'], title: '需要我', empty: '没有等待你决定的事项' },
  { states: ['active'], title: '正在办', empty: '管家现在没有正在执行的任务' },
  { states: ['waiting-external'], title: '等外部', empty: '没有等待别人或外部系统的事项' },
  { states: ['delivered', 'failed'], title: '已交付与异常', empty: '还没有最近结果' },
];

function TaskRow({
  task,
  onCompleteTodo,
}: {
  task: ButlerTaskProjection;
  onCompleteTodo: (id: string) => void;
}) {
  return (
    <article className="butler-task-row">
      <div className={`butler-task-state butler-task-state-${task.state}`} aria-hidden="true">
        {task.state === 'active'
          ? <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />
          : task.state === 'waiting-external'
            ? <Clock3 size={15} />
            : <span />}
      </div>
      <div className="butler-task-copy">
        <h3>{task.title}</h3>
        <p>
          <span>{task.statusLabel}</span>
          {task.nextAt ? <span> · {task.nextAt}</span> : null}
          {task.sourceLabel ? <span> · {task.sourceLabel}</span> : null}
        </p>
      </div>
      {task.todo ? (
        <button
          type="button"
          onClick={() => onCompleteTodo(task.todo!.id)}
          aria-label={`完成任务：${task.title}`}
          title="标记为完成"
          className="butler-icon-button"
        >
          <Check size={15} />
        </button>
      ) : (
        <span className="butler-icon-button butler-icon-button-static" title="执行详情在任务运行卡中">
          <ExternalLink size={14} />
        </span>
      )}
    </article>
  );
}

export default function ButlerTasksView({
  tasks,
  onCompleteTodo,
}: {
  tasks: ButlerTaskProjection[];
  onCompleteTodo: (id: string) => void;
}) {
  return (
    <section aria-label="管家任务" className="butler-tasks-view">
      <div className="butler-section-heading">
        <div>
          <span className="butler-eyebrow">已接住的工作</span>
          <h2>任务</h2>
          <p>这里是管家已经接住的责任，不是底层线程或工具运行列表。</p>
        </div>
        <strong>{tasks.length}</strong>
      </div>
      <div className="butler-task-groups">
        {GROUPS.map((group) => {
          const rows = tasks.filter((task) => group.states.includes(task.state));
          return (
            <section key={group.title} aria-label={group.title} className="butler-task-group">
              <header>
                <h3>{group.title}</h3>
                <span>{rows.length}</span>
              </header>
              {rows.length > 0 ? (
                <div>
                  {rows.map((task) => (
                    <TaskRow key={task.id} task={task} onCompleteTodo={onCompleteTodo} />
                  ))}
                </div>
              ) : (
                <p className="butler-task-empty">{group.empty}</p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
