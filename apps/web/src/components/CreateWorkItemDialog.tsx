import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useWorkbench } from '../stores/workbench';
import { useWiTemplates, type WiTemplate } from '../stores/wiTemplates';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { rest } from '../lib/client';

const SINGLE_TYPES = ['Task', 'Bug', 'User Story', 'Feature', 'Epic', 'Issue'];

export default function CreateWorkItemDialog({
  defaultTitle,
  rid,
  onClose,
}: {
  defaultTitle: string;
  rid?: string;
  onClose: () => void;
}) {
  const config = useWorkbench((s) => s.config);
  const templates = useWiTemplates((s) => s.templates);
  const defaultProject = useWiTemplates((s) => s.defaultProject);

  const [tplIdx, setTplIdx] = useState(0);
  const [title, setTitle] = useState(defaultTitle);
  const [type, setType] = useState('Task');
  const [tags, setTags] = useState('');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [createDiscussion, setCreateDiscussion] = useState(!!rid);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tpl = templates[tplIdx] as WiTemplate | undefined;
  const isSingle = tpl?.items.length === 1 && tpl.items[0].type === '{type}';

  useEffect(() => {
    if (!config?.adoBase || config.mode !== 'direct') return;
    void (async () => {
      try {
        const { directGetProjects } = await import('../lib/adoDirect');
        const cfg = { adoBase: config.adoBase!, pat: config.pat ?? '', auth: config.auth };
        const names = await directGetProjects(cfg);
        setProjects(names);
        const def = defaultProject && names.includes(defaultProject) ? defaultProject : names[0];
        if (def && !project) setProject(def);
      } catch { /* ignore */ }
    })();
  }, [config]);

  const doCreate = async () => {
    if (!title.trim() || !project || !config?.adoBase || !tpl) return;
    setLoading(true);
    setError(null);

    try {
      const { directCreateCascade, directGetCurrentIteration, directCreateWorkItem } =
        await import('../lib/adoDirect');
      const cfg = { adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth };

      setProgress('获取当前迭代…');
      const iterationPath = await directGetCurrentIteration(cfg, project);

      let created: { id: number; type: string; title: string; webUrl: string }[];

      if (isSingle) {
        setProgress(`创建 ${type}…`);
        const wi = await directCreateWorkItem(cfg, project, type, title.trim(), {
          tags: tags || undefined,
          iterationPath: iterationPath ?? undefined,
        });
        created = [{ id: wi.id, type: wi.type, title: wi.title, webUrl: wi.webUrl }];
      } else {
        setProgress(`创建级联工作项（共 ${tpl.items.length} 项）…`);
        created = await directCreateCascade(cfg, project, tpl.items, {
          title: title.trim(),
          type,
          tags,
        }, {
          tags: tags || undefined,
          iterationPath: iterationPath ?? undefined,
        });
      }

      const top = created[0];

      if (createDiscussion && rid) {
        setProgress('创建讨论组…');
        const discName = `#${top.id} ${top.title}`.slice(0, 100);
        const room = await rest.createDiscussion(rid, discName);

        const lines = created.map((w) => `- **${w.type}** [#${w.id} ${w.title}](${w.webUrl})`);
        const summary = `**工作项已创建**\n${lines.join('\n')}`;
        await rest.sendMessage(room._id, summary);

        const chat = useChat.getState();
        await chat.openRoom(room._id);
      } else {
        window.open(top.webUrl, '_blank');
      }

      const summary = created.length === 1
        ? `已创建 ${top.type} #${top.id}`
        : `已创建 ${created.length} 个工作项（#${created.map((w) => w.id).join(', #')}）`;
      toast.success(summary);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setProgress('');
    }
  };

  if (!config?.adoBase || config.mode !== 'direct') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="w-96 rounded-xl bg-surface-4 p-5 shadow-2xl">
          <div className="text-[15px] font-semibold text-ink">创建工作项</div>
          <div className="mt-2 text-sm text-ink-2">请先在设置中配置 ADO 直连</div>
          <div className="mt-4 flex justify-end">
            <button onClick={onClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover">关闭</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[460px] rounded-xl bg-surface-4 p-5 shadow-2xl">
        <div className="text-[15px] font-semibold text-ink">创建工作项</div>

        <div className="mt-3 space-y-3">
          {/* 模板选择 */}
          <div className="flex flex-wrap gap-1.5">
            {templates.map((t, i) => (
              <button
                key={t.name}
                onClick={() => setTplIdx(i)}
                className={`h-7 rounded-full px-3 text-xs transition ${
                  i === tplIdx
                    ? 'bg-primary text-white'
                    : 'bg-fill-1 text-ink-2 hover:bg-fill-hover'
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>

          {/* 项目 + 类型（单个模式显示类型选择） */}
          <div className="flex gap-2">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="h-8 flex-1 rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none"
            >
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {isSingle && (
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-8 w-28 rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none"
              >
                {SINGLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </div>

          {/* 标题 */}
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题"
            className="h-8 w-full rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
          />

          {/* 标签（级联模式给顶层打标签） */}
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="标签（用分号分隔多个）"
            className="h-8 w-full rounded-md border border-line bg-surface-4 px-3 text-sm text-ink-2 outline-none focus:border-primary"
          />

          {/* 级联预览 */}
          {!isSingle && tpl && (
            <div className="rounded-md bg-fill-1 px-3 py-2 text-xs text-ink-2">
              <div className="mb-1 font-medium text-ink-3">将创建：</div>
              {tpl.items.map((item, i) => {
                const indent = item.parent != null ? (tpl.items[item.parent]?.parent != null ? '　　　' : '　　') : '';
                const arrow = item.parent != null ? '└ ' : '';
                const resolvedTitle = item.title.replace('{title}', title || '…');
                return (
                  <div key={i}>
                    {indent}{arrow}{item.type === '{type}' ? type : item.type}：{resolvedTitle}
                  </div>
                );
              })}
            </div>
          )}

          {/* 创建讨论组 */}
          {rid && (
            <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
              <input
                type="checkbox"
                checked={createDiscussion}
                onChange={(e) => setCreateDiscussion(e.target.checked)}
                className="accent-primary"
              />
              同时创建讨论组（以工作项 ID 命名）
            </label>
          )}

          {error && <div className="text-xs text-danger">{error}</div>}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-ink-3">
            {loading && progress ? (
              <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" />{progress}</span>
            ) : (
              '迭代自动取当前迭代'
            )}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover">
              取消
            </button>
            <button
              onClick={() => void doCreate()}
              disabled={loading || !title.trim() || !project}
              className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
            >
              {loading ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
