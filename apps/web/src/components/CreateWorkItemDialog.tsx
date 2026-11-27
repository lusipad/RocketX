import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { useWorkbench } from '../stores/workbench';
import {
  hierarchyLayoutOptionsForTypes,
  hierarchyPreview,
  isHierarchyTemplate,
  loadHierarchyLayout,
  loadLastWorkItemProject,
  preferredWorkItemProject,
  preferredWorkItemType,
  saveHierarchyLayout,
  saveLastWorkItemProject,
  workItemTemplatesForTypes,
  useWiTemplates,
  type HierarchyLayout,
} from '../stores/wiTemplates';
import { normalizeDiscussionName, useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { rest } from '../lib/client';
import { useDialogBehavior } from './Dialog';

export default function CreateWorkItemDialog({
  defaultTitle,
  defaultDescription,
  defaultType,
  defaultTags,
  rid,
  onCreated,
  onClose,
}: {
  defaultTitle: string;
  defaultDescription?: string;
  defaultType?: string;
  defaultTags?: string;
  rid?: string;
  onCreated?: (created: { id: number; type: string; title: string; webUrl: string }[]) => void;
  onClose: () => void;
}) {
  const { t, tp, locale } = useI18n();
  const config = useWorkbench((s) => s.config);
  const templates = useWiTemplates((s) => s.templates);
  const defaultProject = useWiTemplates((s) => s.defaultProject);

  const [tplIdx, setTplIdx] = useState(0);
  const [hierarchyLayout, setHierarchyLayout] = useState<HierarchyLayout>(() => loadHierarchyLayout());
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [type, setType] = useState(defaultType ?? 'Task');
  const [tags, setTags] = useState(defaultTags ?? '');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [workItemTypes, setWorkItemTypes] = useState<string[]>([]);
  const [workItemHierarchy, setWorkItemHierarchy] = useState<string[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [createDiscussion, setCreateDiscussion] = useState(!!rid);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const requestClose = useCallback(() => {
    if (!loading) onClose();
  }, [loading, onClose]);
  const dialogRef = useDialogBehavior(requestClose);

  const compatibleTemplates = useMemo(
    () => workItemTemplatesForTypes(templates, workItemTypes, workItemHierarchy, hierarchyLayout),
    [templates, workItemTypes, workItemHierarchy, hierarchyLayout, locale],
  );
  const hierarchyLayoutOptions = useMemo(
    () => hierarchyLayoutOptionsForTypes(workItemTypes, workItemHierarchy),
    [workItemTypes, workItemHierarchy, locale],
  );
  const tpl = compatibleTemplates[tplIdx];
  const isSingle = tpl?.items.length === 1 && tpl.items[0].type === '{type}';
  const isHierarchy = isHierarchyTemplate(tpl);

  useEffect(() => {
    if (!config?.adoBase) return;
    void (async () => {
      try {
        const { directGetProjects } = await import('../lib/adoDirect');
        const cfg = { adoBase: config.adoBase!, pat: config.pat ?? '', auth: config.auth };
        const names = await directGetProjects(cfg);
        setProjects(names);
        const preferred = preferredWorkItemProject(
          names,
          loadLastWorkItemProject(config.adoBase!),
          defaultProject,
        );
        setProject((current) => current && names.includes(current) ? current : preferred);
      } catch { /* ignore */ }
    })();
  }, [config, defaultProject]);

  useEffect(() => {
    if (!config?.adoBase || !project) return;
    let cancelled = false;
    setTypesLoading(true);
    setWorkItemTypes([]);
    setWorkItemHierarchy([]);
    setType('');
    setError(null);
    void (async () => {
      try {
        const { directGetWorkItemHierarchy, directGetWorkItemTypes } = await import('../lib/adoDirect');
        const cfg = { adoBase: config.adoBase!, pat: config.pat ?? '', auth: config.auth };
        const [names, hierarchy] = await Promise.all([
          directGetWorkItemTypes(cfg, project),
          directGetWorkItemHierarchy(cfg, project).catch(() => []),
        ]);
        if (cancelled) return;
        setWorkItemTypes(names);
        setWorkItemHierarchy(hierarchy);
        setType((current) => names.includes(current)
          ? current
          : defaultType && names.includes(defaultType)
            ? defaultType
            : preferredWorkItemType(names));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setTypesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [config, defaultType, project]);

  useEffect(() => {
    setTplIdx((current) => current < compatibleTemplates.length ? current : 0);
  }, [compatibleTemplates.length]);

  const doCreate = async () => {
    if (!title.trim() || !project || !config?.adoBase || !tpl || !workItemTypes.length || !type) return;
    setLoading(true);
    setError(null);

    try {
      const { directCreateCascade, directGetCurrentIteration, directCreateWorkItem } =
        await import('../lib/adoDirect');
      const cfg = { adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth };

      setProgress(t('workbench.createDialog.progressIteration'));
      const iterationPath = await directGetCurrentIteration(cfg, project);

      let created: { id: number; type: string; title: string; webUrl: string }[];

      if (isSingle) {
        setProgress(t('workbench.createDialog.progressSingle', { type }));
        const wi = await directCreateWorkItem(cfg, project, type, title.trim(), {
          description: description.trim() || undefined,
          tags: tags || undefined,
          iterationPath: iterationPath ?? undefined,
        });
        created = [{ id: wi.id, type: wi.type, title: wi.title, webUrl: wi.webUrl }];
      } else {
        setProgress(tp(
          tpl.items.length,
          'workbench.createDialog.progressCascadeOne',
          'workbench.createDialog.progressCascadeOther',
          { count: tpl.items.length },
        ));
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
        setProgress(t('workbench.createDialog.progressDiscussion'));
        // 讨论使用展示名，保留工作项编号与中文标题。
        const discName = normalizeDiscussionName(`#${top.id} ${top.title}`, `work-item-${top.id}`);
        const room = await rest.createDiscussion(rid, discName);

        const lines = created.map((w) => `- **${w.type}** [#${w.id} ${w.title}](${w.webUrl})`);
        const summary = `${t('workbench.createDialog.discussionCreatedHeader')}\n${lines.join('\n')}`;
        await rest.sendMessage(room._id, summary);

        const chat = useChat.getState();
        await chat.openRoom(room._id);
      } else {
        window.open(top.webUrl, '_blank');
      }

      const summary = created.length === 1
        ? t('workbench.createDialog.createdSingleToast', { type: top.type, id: top.id })
        : t('workbench.createDialog.createdMultiToast', {
            count: created.length,
            ids: created.map((w) => `#${w.id}`).join(', '),
          });
      toast.success(summary);
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setProgress('');
    }
  };

  if (!config?.adoBase) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('workbench.createDialog.title')}
          tabIndex={-1}
          className="w-96 rounded-xl bg-surface-4 p-5 shadow-2xl"
        >
          <div className="text-base font-semibold text-ink">{t('workbench.createDialog.title')}</div>
          <div className="mt-2 text-sm text-ink-2">{t('workbench.createDialog.configureAdoFirst')}</div>
          <div className="mt-4 flex justify-end">
            <button onClick={requestClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover">{t('common.close')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.createDialog.title')}
        tabIndex={-1}
        className="w-[460px] rounded-xl bg-surface-4 p-5 shadow-2xl"
      >
        <div className="text-base font-semibold text-ink">{t('workbench.createDialog.title')}</div>

        <div className="mt-3 space-y-3">
          {/* 模板选择 */}
          <div className="flex flex-wrap gap-1.5">
            {compatibleTemplates.map((tplItem, i) => (
              <button
                key={tplItem.name}
                onClick={() => setTplIdx(i)}
                className={`h-7 rounded-full px-3 text-xs transition ${
                  i === tplIdx
                    ? 'bg-primary text-white'
                    : 'bg-fill-1 text-ink-2 hover:bg-fill-hover'
                }`}
              >
                {tplItem.name}
              </button>
            ))}
            {!typesLoading && workItemTypes.length > 0 && compatibleTemplates.length === 0 && (
              <span className="text-xs text-danger">{t('workbench.createDialog.noCompatibleTemplates')}</span>
            )}
          </div>

          {/* 层级形态六选一(选择即记住,下次默认) + 结构预览 */}
          {isHierarchy && hierarchyLayoutOptions.length > 0 && (
            <div className="flex flex-col gap-1">
              <select
                value={hierarchyLayout}
                onChange={(e) => {
                  const next = e.target.value as HierarchyLayout;
                  setHierarchyLayout(next);
                  saveHierarchyLayout(next);
                }}
                className="h-8 rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none"
              >
                {hierarchyLayoutOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              {tpl && (
                <div className="text-xs text-ink-3">{hierarchyPreview(tpl)}</div>
              )}
            </div>
          )}

          {/* 项目 + 类型（单个模式显示类型选择） */}
          <div className="flex gap-2">
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                saveLastWorkItemProject(config.adoBase!, e.target.value);
              }}
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
                {workItemTypes.map((workType) => <option key={workType} value={workType}>{workType}</option>)}
              </select>
            )}
          </div>

          {/* 标题 */}
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('workbench.createDialog.titlePlaceholder')}
            className="h-8 w-full rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder={t('workbench.createDialog.descriptionPlaceholder')}
            className="w-full resize-none rounded-md border border-line bg-surface-4 px-3 py-2 text-sm text-ink-2 outline-none focus:border-primary"
          />

          {/* 标签（级联模式给顶层打标签） */}
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('workbench.createDialog.tagsPlaceholder')}
            className="h-8 w-full rounded-md border border-line bg-surface-4 px-3 text-sm text-ink-2 outline-none focus:border-primary"
          />

          {/* 级联预览 */}
          {!isSingle && tpl && (
            <div className="rounded-md bg-fill-1 px-3 py-2 text-xs text-ink-2">
              <div className="mb-1 font-medium text-ink-3">{t('workbench.createDialog.willCreate')}</div>
              {tpl.items.map((item, i) => {
                const indent = item.parent != null ? (tpl.items[item.parent]?.parent != null ? '　　　' : '　　') : '';
                const arrow = item.parent != null ? '└ ' : '';
                const resolvedTitle = item.title.replace('{title}', title || '…');
                return (
                  <div key={i}>
                    {indent}{arrow}{t('workbench.createDialog.cascadeItem', {
                      type: item.type === '{type}' ? type : item.type,
                      title: resolvedTitle,
                    })}
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
              {t('workbench.createDialog.alsoCreateDiscussion')}
            </label>
          )}

          {error && <div className="text-xs text-danger">{error}</div>}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-ink-3">
            {loading && progress ? (
              <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" />{progress}</span>
            ) : (
              t('workbench.createDialog.iterationAutoHint')
            )}
          </span>
          <div className="flex gap-2">
            <button
              onClick={requestClose}
              disabled={loading}
              className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-40"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void doCreate()}
              disabled={loading || typesLoading || !workItemTypes.length || !tpl || !type || !title.trim() || !project}
              className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
            >
              {loading ? t('workbench.createDialog.creating') : t('workbench.createDialog.createAction')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
