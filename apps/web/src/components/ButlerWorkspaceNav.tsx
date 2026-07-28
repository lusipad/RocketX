import {
  CircleGauge,
  ListTodo,
  MessageSquareText,
  PlugZap,
  Repeat2,
  UserRound,
} from 'lucide-react';
import type { ButlerWorkspaceView } from '../lib/butlerWorkspace';
import { useButlerIdentity } from '../stores/butlerIdentity';
import ButlerAvatar from './ButlerAvatar';

const ITEMS: Array<{
  id: ButlerWorkspaceView;
  label: string;
  Icon: typeof CircleGauge;
}> = [
  { id: 'now', label: '现在', Icon: CircleGauge },
  { id: 'tasks', label: '任务', Icon: ListTodo },
  { id: 'routines', label: '例行照看', Icon: Repeat2 },
  { id: 'conversation', label: '对话', Icon: MessageSquareText },
  { id: 'memory', label: '我的管家', Icon: UserRound },
  { id: 'connections', label: '连接与权限', Icon: PlugZap },
];

export default function ButlerWorkspaceNav({
  active,
  needsAttention,
  routineFailures,
  onSelect,
}: {
  active: ButlerWorkspaceView;
  needsAttention: number;
  routineFailures: number;
  onSelect: (view: ButlerWorkspaceView) => void;
}) {
  const identity = useButlerIdentity((state) => state.identity);
  return (
    <nav aria-label="管家工作视图" className="butler-workspace-nav">
      <div className="butler-workspace-brand">
        <ButlerAvatar avatar={identity.avatar} name={identity.displayName} size="small" />
        <span>
          <strong>{identity.displayName}</strong>
          <small>持续工作中</small>
        </span>
      </div>
      <label className="butler-workspace-mobile-select">
        <span>管家视图</span>
        <select
          aria-label="切换管家视图"
          value={active}
          onChange={(event) => onSelect(event.target.value as ButlerWorkspaceView)}
        >
          {ITEMS.map(({ id, label }) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </label>
      <div className="butler-workspace-nav-items">
        {ITEMS.map(({ id, label, Icon }) => {
          const count = id === 'now'
            ? needsAttention
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
      <p className="butler-workspace-nav-foot">
        一直在，持续接住你的工作。
      </p>
    </nav>
  );
}
