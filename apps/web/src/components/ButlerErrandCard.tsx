import { CheckCircle2, FolderGit2, Loader2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  dispatchWorkspaceLabel,
  resolveDispatchTargets,
} from '../lib/dispatchWorkspaces';
import { useAgentEnvironments } from '../stores/agentEnvironments';
import { useButler } from '../stores/butler';
import { useLocalCodex } from '../stores/localCodex';
import { toast } from '../stores/toast';

/**
 * 任务规格卡：管家拟好的活，用户在这里逐字过目、选工作区、一键送进执行间。
 * 这张卡就是派活的闸——规格上卡前经过白名单归一化，目标只能从已注册工作区里选。
 */
export default function ButlerErrandCard() {
  const errandDraft = useButler((state) => state.errandDraft);
  const confirmErrandDraft = useButler((state) => state.confirmErrandDraft);
  const dismissErrandDraft = useButler((state) => state.dismissErrandDraft);
  const environments = useAgentEnvironments((state) => state.environments);
  const lastDispatchEnvironmentId = useAgentEnvironments((state) => state.lastDispatchEnvironmentId);
  const localCodexRoot = useLocalCodex((state) => state.workspaceRoot);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [readOnly, setReadOnly] = useState(false);
  const [dispatching, setDispatching] = useState(false);

  const resolution = useMemo(
    () => resolveDispatchTargets(
      environments,
      localCodexRoot || undefined,
      lastDispatchEnvironmentId,
      errandDraft?.workspaceHint,
    ),
    [environments, localCodexRoot, lastDispatchEnvironmentId, errandDraft?.workspaceHint],
  );

  if (!errandDraft) return null;
  const { spec } = errandDraft;

  const keyOf = (target: (typeof resolution.options)[number]) => target.id ?? `pending:${target.path}`;
  const defaultTarget = resolution.options.find((target) => target.id === resolution.defaultId)
    ?? resolution.options[0];
  const activeKey = selectedKey ?? (defaultTarget ? keyOf(defaultTarget) : undefined);
  const activeTarget = resolution.options.find((target) => keyOf(target) === activeKey);

  const dispatchNow = async () => {
    if (!activeTarget || dispatching) return;
    setDispatching(true);
    try {
      // 不跳转：活开跑后你留在管家页，进度与结论由「派出去的活」卡片呈现
      await confirmErrandDraft(activeTarget, { readOnly });
    } catch (error) {
      toast.error(error, '派发失败');
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary-light/40 p-4">
      <div className="text-xs font-medium text-primary">任务规格</div>
      <div className="mt-2 font-medium text-ink">{spec.title}</div>
      {spec.goal ? (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-2">{spec.goal}</p>
      ) : null}
      {spec.acceptance.length ? (
        <ul className="mt-2 space-y-1">
          {spec.acceptance.map((item) => (
            <li key={item} className="flex items-start gap-1.5 text-sm text-ink-2">
              <CheckCircle2 size={15} className="mt-1 shrink-0 text-success" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {spec.boundaries.length ? (
        <ul className="mt-2 space-y-1">
          {spec.boundaries.map((item) => (
            <li key={item} className="flex items-start gap-1.5 text-sm text-ink-2">
              <XCircle size={15} className="mt-1 shrink-0 text-danger/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {resolution.options.length ? (
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-2">
          <FolderGit2 size={15} className="shrink-0 text-ink-3" />
          <span className="shrink-0">派到</span>
          <select
            aria-label="派活目标工作区"
            value={activeKey}
            onChange={(event) => setSelectedKey(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none transition focus:border-primary"
          >
            {resolution.options.map((target) => (
              <option key={keyOf(target)} value={keyOf(target)}>
                {dispatchWorkspaceLabel(target)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-ink-2">
          还没有可派的工作区：先去执行间选一个本地目录，或在设置里添加工作区。
        </p>
      )}

      {/* 默认允许改代码——给「修 bug」只读权限等于保证干不完 */}
      <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(event) => setReadOnly(event.target.checked)}
          className="h-3.5 w-3.5 accent-primary"
        />
        只调查，不改文件
      </label>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void dismissErrandDraft()}
          disabled={dispatching}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void dispatchNow()}
          disabled={!activeTarget || dispatching}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {dispatching ? <Loader2 size={14} className="animate-spin" /> : null}
          {dispatching ? '正在派发…' : '送进执行间开跑'}
        </button>
      </div>
    </div>
  );
}
