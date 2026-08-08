import { open } from '@tauri-apps/plugin-dialog';
import { ChevronDown, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { isTauri } from '../lib/client';
import { environmentIsBusy, useAgentEnvironments } from '../stores/agentEnvironments';
import { toast } from '../stores/toast';

const inputCls =
  'h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs outline-none transition focus:border-primary';

export default function LocalAgentEnvironmentsSettings() {
  const environments = useAgentEnvironments((state) => state.environments);
  const bindings = useAgentEnvironments((state) => state.bindings);
  const addEnvironment = useAgentEnvironments((state) => state.addEnvironment);
  const updateEnvironment = useAgentEnvironments((state) => state.updateEnvironment);
  const removeEnvironment = useAgentEnvironments((state) => state.removeEnvironment);
  const [adding, setAdding] = useState(false);

  const chooseAndAdd = async () => {
    if (!isTauri) return;
    setAdding(true);
    try {
      const path = await open({ directory: true, multiple: false, title: '选择本地工作区' });
      if (typeof path !== 'string') return;
      addEnvironment({
        name: path.split(/[\\/]/).filter(Boolean).at(-1) || '本地环境',
        path,
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
      });
      toast.success('本地工作区已添加');
    } catch (error) {
      toast.error(error, '添加本地工作区失败');
    } finally {
      setAdding(false);
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">本地工作区</h2>
          <p className="mt-0.5 max-w-xl text-xs leading-5 text-ink-3">
            添加允许管家派活和 AI 托管访问的代码目录。目录只保存在本机，模型不能自行添加。
          </p>
        </div>
        <button
          onClick={() => void chooseAndAdd()}
          disabled={!isTauri || adding}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          <Plus size={14} /> 添加本地工作区
        </button>
      </div>

      <div className="space-y-3">
        {environments.map((environment) => {
          const busy = environmentIsBusy(environment.id, bindings);
          return (
            <div key={environment.id} className="overflow-hidden rounded-lg bg-surface shadow-raise">
              <div className="flex items-center gap-3 p-4">
                <div className="rounded-md bg-primary-light p-2 text-primary"><FolderOpen size={16} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-sm font-medium text-ink">{environment.name}</div>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${busy ? 'bg-warning-light text-warning' : 'bg-success-light text-success'}`}>
                      {busy ? '使用中' : environment.enabled ? '可用' : '已停用'}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs text-ink-3" title={environment.path}>
                    {environment.path}
                  </div>
                </div>
                <button
                  title={busy ? '活动讨论结束后才能删除' : '删除环境'}
                  disabled={busy}
                  onClick={() => {
                    try {
                      removeEnvironment(environment.id);
                    } catch (error) {
                      toast.error(error, '删除环境失败');
                    }
                  }}
                  className="rounded p-1.5 text-ink-3 hover:bg-fill-hover hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <details className="group border-t border-line">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-ink-2">
                  高级设置
                  <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 px-4 pb-4 pt-2">
                  <div className="flex items-end gap-3">
                    <label className="min-w-0 flex-1 text-xs text-ink-3">
                      目录名称
                      <input
                        aria-label="环境名称"
                        value={environment.name}
                        onChange={(event) => updateEnvironment(environment.id, { name: event.target.value })}
                        className={`mt-1 ${inputCls} max-w-xs font-medium`}
                      />
                    </label>
                    <label className="flex h-8 shrink-0 items-center gap-1.5 text-xs text-ink-3">
                      <input
                        type="checkbox"
                        checked={environment.enabled}
                        disabled={busy}
                        onChange={(event) => updateEnvironment(environment.id, { enabled: event.target.checked })}
                      />
                      启用
                    </label>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className="text-xs text-ink-3 sm:col-span-1">
                      ADO 项目（逗号分隔）
                      <input
                        value={environment.adoProjects.join(', ')}
                        onChange={(event) => updateEnvironment(environment.id, { adoProjects: event.target.value.split(',') })}
                        placeholder="RocketChatX"
                        className={`mt-1 ${inputCls}`}
                      />
                    </label>
                    <label className="text-xs text-ink-3">
                      基础分支
                      <input
                        value={environment.defaultBaseBranch}
                        onChange={(event) => updateEnvironment(environment.id, { defaultBaseBranch: event.target.value })}
                        placeholder="main"
                        className={`mt-1 ${inputCls}`}
                      />
                    </label>
                    <label className="text-xs text-ink-3">
                      任务分支前缀
                      <input
                        value={environment.branchPrefix}
                        onChange={(event) => updateEnvironment(environment.id, { branchPrefix: event.target.value })}
                        placeholder="ai/"
                        className={`mt-1 ${inputCls}`}
                      />
                    </label>
                  </div>
                </div>
              </details>
            </div>
          );
        })}
        {environments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface px-4 py-8 text-center text-sm text-ink-3">
            还没有本地工作区。添加一个代码目录后，管家就能把独立工作派到这里。
          </div>
        ) : null}
      </div>
    </section>
  );
}
