import {
  BrainCircuit,
  CalendarDays,
  ListTodo,
  MessageSquareText,
  MoreHorizontal,
  PlugZap,
  Repeat2,
} from 'lucide-react';
import { useRef } from 'react';
import type { ButlerWorkspaceView } from '../lib/butlerWorkspace';
import { useButlerIdentity } from '../stores/butlerIdentity';
import ButlerAvatar from './ButlerAvatar';

const PRIMARY_ITEMS: Array<{
  id: ButlerWorkspaceView;
  label: string;
  Icon: typeof MessageSquareText;
}> = [
  { id: 'conversation', label: '对话', Icon: MessageSquareText },
  { id: 'tasks', label: '委托', Icon: ListTodo },
  { id: 'routines', label: '定时任务', Icon: Repeat2 },
];

const SECONDARY_ITEMS: Array<{
  id: ButlerWorkspaceView;
  label: string;
  Icon: typeof BrainCircuit;
}> = [
  { id: 'now', label: '今日纸', Icon: CalendarDays },
  { id: 'memory', label: '技能中心', Icon: BrainCircuit },
  { id: 'connections', label: '连接与权限', Icon: PlugZap },
];

export default function ButlerWorkspaceNav({
  active,
  delegationAttention,
  routineFailures,
  onSelect,
}: {
  active: ButlerWorkspaceView;
  delegationAttention: number;
  routineFailures: number;
  onSelect: (view: ButlerWorkspaceView) => void;
}) {
  const identity = useButlerIdentity((state) => state.identity);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const selectSecondary = (view: ButlerWorkspaceView): void => {
    moreRef.current?.removeAttribute('open');
    onSelect(view);
  };

  return (
    <nav aria-label="管家工作视图" className="butler-workspace-nav">
      <div className="butler-workspace-brand">
        <ButlerAvatar avatar={identity.avatar} name={identity.displayName} size="small" />
        <span>
          <strong>{identity.displayName}</strong>
          <small>私人工作代理</small>
        </span>
      </div>
      <label className="butler-workspace-mobile-select">
        <span>管家视图</span>
        <select
          aria-label="切换管家视图"
          value={active}
          onChange={(event) => onSelect(event.target.value as ButlerWorkspaceView)}
        >
          <optgroup label="工作">
            {PRIMARY_ITEMS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </optgroup>
          <optgroup label="更多">
            {SECONDARY_ITEMS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <div className="butler-workspace-nav-items">
        {PRIMARY_ITEMS.map(({ id, label, Icon }) => {
          const count = id === 'tasks'
            ? delegationAttention
            : id === 'routines'
              ? routineFailures
              : 0;
          return (
            <button
              key={id}
              type="button"
              aria-current={active === id ? 'page' : undefined}
              aria-label={count > 0 ? `${label}，${count} 项需要注意` : label}
              title={label}
              onClick={() => onSelect(id)}
              className="butler-workspace-nav-item"
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
              {count > 0 ? <b>{count > 99 ? '99+' : count}</b> : null}
            </button>
          );
        })}
      </div>
      <details ref={moreRef} className="butler-workspace-more">
        <summary aria-label="更多管家视图">
          <MoreHorizontal size={17} aria-hidden="true" />
          <span>更多</span>
        </summary>
        <div role="menu" aria-label="更多管家视图菜单">
          {SECONDARY_ITEMS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              aria-current={active === id ? 'page' : undefined}
              onClick={() => selectSecondary(id)}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </details>
    </nav>
  );
}
