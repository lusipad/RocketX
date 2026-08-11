import { useState } from 'react';
import type { LocalAgentEnvironment } from '../stores/agentEnvironments';
import Dialog from './Dialog';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

export interface ButlerProjectConfigPatch {
  name: string;
  enabled: boolean;
  adoProjects: string[];
  defaultBaseBranch: string;
  branchPrefix: string;
}

export default function ButlerProjectConfigDialog({
  path,
  environment,
  busy,
  onClose,
  onSave,
}: {
  path: string;
  environment?: LocalAgentEnvironment;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: ButlerProjectConfigPatch) => void;
}) {
  const [name, setName] = useState(environment?.name ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? '本地环境');
  const [enabled, setEnabled] = useState(environment?.enabled ?? true);
  const [adoProjects, setAdoProjects] = useState(environment?.adoProjects.join(', ') ?? '');
  const [defaultBaseBranch, setDefaultBaseBranch] = useState(environment?.defaultBaseBranch ?? 'main');
  const [branchPrefix, setBranchPrefix] = useState(environment?.branchPrefix ?? 'ai/');

  return (
    <Dialog
      title="项目配置"
      hint={environment
        ? '这里只维护 AI 托管项目的元数据，不会改动磁盘目录或现有会话。'
        : '保存后会为这个目录创建默认项目配置，后续 AI 托管和工作项讨论都复用它。'}
      width={520}
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave({
              name,
              enabled,
              adoProjects: adoProjects.split(','),
              defaultBaseBranch,
              branchPrefix,
            })}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white"
          >
            保存
          </button>
        </>
      )}
    >
      <div className="space-y-4 px-5 pb-4 pt-2">
        <div className="rounded-lg bg-fill-1 px-3 py-2">
          <div className="text-xs text-ink-3">目录</div>
          <div className="mt-1 break-all text-sm text-ink">{path}</div>
        </div>
        <div className="flex items-end gap-3">
          <label className="min-w-0 flex-1 text-xs text-ink-3">
            项目名称
            <input
              aria-label="项目名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="flex h-9 shrink-0 items-center gap-1.5 text-xs text-ink-3">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            启用
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-ink-3 sm:col-span-1">
            ADO 项目
            <input
              aria-label="ADO 项目"
              value={adoProjects}
              onChange={(event) => setAdoProjects(event.target.value)}
              placeholder="RocketChatX"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="text-xs text-ink-3">
            基础分支
            <input
              aria-label="基础分支"
              value={defaultBaseBranch}
              onChange={(event) => setDefaultBaseBranch(event.target.value)}
              placeholder="main"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="text-xs text-ink-3">
            任务分支前缀
            <input
              aria-label="任务分支前缀"
              value={branchPrefix}
              onChange={(event) => setBranchPrefix(event.target.value)}
              placeholder="ai/"
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>
        {busy ? <div className="text-xs text-warning">当前有活动讨论占用这个项目，不能停用或删除。</div> : null}
      </div>
    </Dialog>
  );
}
