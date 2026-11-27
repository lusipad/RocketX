import {
  BookmarkPlus,
  Check,
  Copy,
  Download,
  Loader2,
  Pin,
  PinOff,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import {
  buildSkillExecutionPrompt,
  STARTER_SKILL_TEMPLATES,
  useButlerSkills,
  type ButlerSkillApprovalPolicy,
  type ButlerSkillEntry,
} from '../stores/butlerSkills';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ShareToRoomButton from './ShareToRoomButton';

export interface ButlerSkillDraftSeed {
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  instructionsMd?: string;
}

interface ButlerSkillsStudioProps {
  workspaceRoot?: string;
  initialDraft?: ButlerSkillDraftSeed | null;
  onClearInitialDraft?: () => void;
}

const SKILL_CATEGORIES: ReadonlyArray<{ id: string; labelKey: MessageKey }> = [
  { id: 'all', labelKey: 'butler.skills.categoryAll' },
  { id: 'code', labelKey: 'butler.skills.categoryCode' },
  { id: 'briefing', labelKey: 'butler.skills.categoryBriefing' },
  { id: 'ops', labelKey: 'butler.skills.categoryOps' },
  { id: 'general', labelKey: 'butler.skills.categoryGeneral' },
];

export default function ButlerSkillsStudio({
  workspaceRoot,
  initialDraft,
  onClearInitialDraft,
}: ButlerSkillsStudioProps) {
  const { t, tp } = useI18n();
  const skills = useButlerSkills((state) => state.skills);
  const loading = useButlerSkills((state) => state.loading);
  const hydrate = useButlerSkills((state) => state.hydrate);
  const upsertSkill = useButlerSkills((state) => state.upsertSkill);
  const deleteSkill = useButlerSkills((state) => state.deleteSkill);
  const toggleSkillEnabled = useButlerSkills((state) => state.toggleSkillEnabled);
  const toggleSkillPinned = useButlerSkills((state) => state.toggleSkillPinned);
  const recordSkillRun = useButlerSkills((state) => state.recordSkillRun);
  const importMarkdown = useButlerSkills((state) => state.importMarkdown);
  const exportMarkdown = useButlerSkills((state) => state.exportMarkdown);
  const seedStarterTemplate = useButlerSkills((state) => state.seedStarterTemplate);
  const setButlerView = useUI((state) => state.setButlerView);

  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [approvalPolicy, setApprovalPolicy] = useState<ButlerSkillApprovalPolicy>('confirm_write');
  const [triggersText, setTriggersText] = useState('');
  const [toolsText, setToolsText] = useState('');
  const [instructionsMd, setInstructionsMd] = useState('');
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [exportPreview, setExportPreview] = useState<{ title: string; markdown: string } | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!editorOpen && !importOpen && !exportPreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (exportPreview) setExportPreview(null);
      else if (importOpen) setImportOpen(false);
      else if (editorOpen) setEditorOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editorOpen, exportPreview, importOpen]);

  useEffect(() => {
    if (!initialDraft) return;
    setEditingId(undefined);
    setName(initialDraft.name ?? '');
    setSlug(initialDraft.slug ?? '');
    setDescription(initialDraft.description ?? '');
    setCategory(initialDraft.category ?? 'general');
    setApprovalPolicy('confirm_write');
    setTriggersText('');
    setToolsText('');
    setInstructionsMd(initialDraft.instructionsMd ?? '');
    setPinned(false);
    setEditorOpen(true);
    onClearInitialDraft?.();
  }, [initialDraft, onClearInitialDraft]);

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((item) => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.slug.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.instructionsMd.toLowerCase().includes(q) ||
        item.triggers.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [categoryFilter, query, skills]);

  const unseededStarters = useMemo(
    () => STARTER_SKILL_TEMPLATES.filter((tpl) => !skills.some((item) => item.slug === tpl.slug)),
    [skills],
  );

  const openNewEditor = () => {
    setEditingId(undefined);
    setName('');
    setSlug('');
    setDescription('');
    setCategory('general');
    setApprovalPolicy('confirm_write');
    setTriggersText('');
    setToolsText('');
    setInstructionsMd('');
    setPinned(false);
    setEditorOpen(true);
  };

  const openEditEditor = (skill: ButlerSkillEntry) => {
    setEditingId(skill.id);
    setName(skill.name);
    setSlug(skill.slug);
    setDescription(skill.description);
    setCategory(skill.category || 'general');
    setApprovalPolicy(
      skill.approvalPolicy === 'auto' || skill.approvalPolicy === 'confirm_all'
        ? skill.approvalPolicy
        : 'confirm_write',
    );
    setTriggersText(skill.triggers.join(', '));
    setToolsText(skill.allowedTools.join(', '));
    setInstructionsMd(skill.instructionsMd);
    setPinned(skill.pinned);
    setEditorOpen(true);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !instructionsMd.trim()) {
      toast.error(t('butler.skills.validationRequired'));
      return;
    }
    setSaving(true);
    try {
      const triggers = triggersText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
      const allowedTools = toolsText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
      await upsertSkill({
        id: editingId,
        slug: slug.trim() || undefined,
        name: name.trim(),
        description: description.trim(),
        category,
        approvalPolicy,
        triggers,
        allowedTools,
        instructionsMd: instructionsMd.trim(),
        workspaceRoot: workspaceRoot?.trim() || null,
        pinned,
        enabled: true,
      });
      setEditorOpen(false);
      toast.success(t('butler.skills.savedToast'));
    } catch (error) {
      toast.error(error, t('butler.skills.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRunSkill = async (skill: ButlerSkillEntry) => {
    try {
      await recordSkillRun(skill.id);
      const prompt = buildSkillExecutionPrompt(skill);
      const ws = useCodexWorkspace.getState();
      if (isTauriRuntime() && ws.status === 'ready') {
        await ws.startTask(prompt, skill.name);
        setButlerView('conversation');
        toast.success(t('butler.skills.runStartedToast', { name: skill.name }));
      } else {
        ws.setComposerDraft(prompt);
        setButlerView('conversation');
        toast.info(t('butler.skills.runDraftedToast', { name: skill.name }));
      }
    } catch (error) {
      toast.error(error, t('butler.skills.runFailed'));
    }
  };

  const handleExport = async (skill: ButlerSkillEntry) => {
    try {
      const markdown = await exportMarkdown(skill.id);
      setExportPreview({ title: `${skill.slug}.md`, markdown });
    } catch (error) {
      toast.error(error, t('butler.skills.exportFailed'));
    }
  };

  const handleImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!importText.trim()) return;
    setImporting(true);
    try {
      await importMarkdown(importText, workspaceRoot?.trim() || null);
      setImportText('');
      setImportOpen(false);
      toast.success(t('butler.skills.importedToast'));
    } catch (error) {
      toast.error(error, t('butler.skills.importFailed'));
    } finally {
      setImporting(false);
    }
  };

  const policyLabel = (policy: string): string => {
    if (policy === 'auto') return t('butler.skills.policyAuto');
    if (policy === 'confirm_all') return t('butler.skills.policyConfirmAll');
    return t('butler.skills.policyConfirmWrite');
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-3 p-3 shadow-raise">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex items-center">
            <Search size={13} className="pointer-events-none absolute left-3 text-ink-3" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('butler.skills.searchPlaceholder')}
              aria-label={t('butler.skills.searchPlaceholder')}
              className="h-8 w-64 rounded-xl border border-line bg-surface-4 pl-8 pr-3 text-xs text-ink outline-none focus:border-primary"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {SKILL_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategoryFilter(cat.id)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  categoryFilter === cat.id
                    ? 'bg-primary text-white'
                    : 'bg-fill-2 text-ink-2 hover:bg-fill-hover'
                }`}
              >
                {t(cat.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink"
          >
            <Upload size={12} />
            <span>{t('butler.skills.importMd')}</span>
          </button>
          <button
            type="button"
            onClick={openNewEditor}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
          >
            <Plus size={13} />
            <span>{t('butler.skills.newSkill')}</span>
          </button>
        </div>
      </div>

      {/* Quick Starter Templates */}
      {unseededStarters.length > 0 && (
        <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Sparkles size={14} className="text-primary" />
              <span>{t('butler.skills.starterTitle')}</span>
            </h2>
            <span className="text-xs text-ink-3">{t('butler.skills.starterHint')}</span>
          </div>
          <div className="grid gap-2.5 md:grid-cols-2 lg:grid-cols-4">
            {unseededStarters.map((tpl) => (
              <div
                key={tpl.id}
                className="flex flex-col justify-between rounded-xl border border-line-soft bg-surface-4 p-3 text-xs"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{t(tpl.nameKey)}</span>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-mono text-primary">
                      /{tpl.slug}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-ink-3">{t(tpl.descriptionKey)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void seedStarterTemplate(tpl.id, t, workspaceRoot?.trim() || null)
                      .then(() => toast.success(t('butler.skills.starterInstalledToast', { name: t(tpl.nameKey) })))
                      .catch((error) => toast.error(error, t('butler.skills.saveFailed')));
                  }}
                  className="mt-2.5 inline-flex items-center justify-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/20"
                >
                  <Plus size={12} />
                  <span>{t('butler.skills.installStarter')}</span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Markdown Import Panel */}
      {importOpen && (
        <form
          onSubmit={(e) => void handleImport(e)}
          className="space-y-3 rounded-2xl border border-primary/40 bg-surface-4 p-4 shadow-card"
        >
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Upload size={14} className="text-primary" />
              <span>{t('butler.skills.importTitle')}</span>
            </h2>
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
          <textarea
            rows={7}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={t('butler.skills.importPlaceholder')}
            className="w-full rounded-xl border border-line bg-surface-3 p-3 font-mono text-xs text-ink outline-none focus:border-primary"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="rounded-xl border border-line bg-surface-3 px-3 py-1.5 text-xs text-ink-2 hover:text-ink"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={importing || !importText.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {importing ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              <span>{t('butler.skills.importSubmit')}</span>
            </button>
          </div>
        </form>
      )}

      {/* Export Preview Panel */}
      {exportPreview && (
        <div className="space-y-2 rounded-2xl border border-line bg-surface-4 p-4 shadow-card">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <Download size={13} className="text-primary" />
              <span>{exportPreview.title}</span>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const writer = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(exportPreview.markdown) : undefined;
                  if (writer) {
                    void writer.then(() => toast.success(t('butler.skills.copiedMdToast'))).catch(() => {});
                  }
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-3 px-2.5 py-1 text-xs text-ink-2 hover:text-ink"
              >
                <Copy size={12} />
                <span>{t('common.copy')}</span>
              </button>
              <button
                type="button"
                onClick={() => setExportPreview(null)}
                className="rounded p-1 text-ink-3 hover:text-ink"
                aria-label={t('common.close')}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <pre className="max-h-60 overflow-auto rounded-xl border border-line-soft bg-surface-3 p-3 text-xs text-ink-2">
            {exportPreview.markdown}
          </pre>
        </div>
      )}

      {/* Editor + List Grid */}
      <div className={`grid gap-4 ${editorOpen ? 'lg:grid-cols-3' : 'grid-cols-1'}`}>
        <div className={editorOpen ? 'lg:col-span-2' : ''}>
          {loading && skills.length === 0 ? (
            <div className="flex h-40 items-center justify-center rounded-2xl border border-line bg-surface-3 text-xs text-ink-3">
              <Loader2 size={15} className="mr-2 animate-spin" />
              <span>{t('common.loading')}</span>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center">
              <Wand2 size={24} className="mb-2 text-ink-3 opacity-50" />
              <div className="text-xs font-medium text-ink">{t('butler.skills.emptyTitle')}</div>
              <p className="mt-1 max-w-md text-xs text-ink-3">{t('butler.skills.emptyDesc')}</p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredSkills.map((skill) => (
                <article
                  key={skill.id}
                  className={`flex flex-col justify-between rounded-2xl border p-4 shadow-card transition ${
                    skill.enabled
                      ? 'border-line bg-surface-3'
                      : 'border-line-soft bg-surface-2 opacity-75'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="truncate text-sm font-semibold text-ink">{skill.name}</h3>
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-mono text-primary">
                            /{skill.slug}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-ink-3">
                          {skill.description || t('butler.skills.noDescription')}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void toggleSkillPinned(skill.id)}
                          title={skill.pinned ? t('butler.skills.unpin') : t('butler.skills.pin')}
                          aria-label={skill.pinned ? t('butler.skills.unpin') : t('butler.skills.pin')}
                          className={`rounded-lg p-1.5 transition ${
                            skill.pinned
                              ? 'bg-warning/15 text-warning'
                              : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
                          }`}
                        >
                          {skill.pinned ? <Pin size={12} /> : <PinOff size={12} />}
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={skill.enabled}
                          aria-label={skill.name}
                          onClick={() => void toggleSkillEnabled(skill.id)}
                          className={`inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium transition ${
                            skill.enabled
                              ? 'border-success/40 bg-success/15 text-success'
                              : 'border-line bg-surface-4 text-ink-3'
                          }`}
                        >
                          {skill.enabled ? t('common.enabled') : t('common.disabled')}
                        </button>
                      </div>
                    </div>

                    <pre className="mt-2.5 line-clamp-3 whitespace-pre-wrap rounded-xl border border-line-soft bg-surface-4 p-2.5 text-xs text-ink-2">
                      {skill.instructionsMd}
                    </pre>

                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-fill-1 px-2 py-0.5 text-2xs text-ink-2">
                        <ShieldCheck size={10} />
                        {policyLabel(skill.approvalPolicy)}
                      </span>
                      <span className="rounded-full bg-fill-1 px-2 py-0.5 text-2xs text-ink-2">
                        {tp(skill.runCount, 'butler.skills.runCountOne', 'butler.skills.runCountOther')}
                      </span>
                      {skill.triggers.slice(0, 3).map((trig) => (
                        <span key={trig} className="rounded-md bg-fill-1 px-1.5 py-0.5 text-xs text-ink-3">
                          #{trig}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2.5">
                    <button
                      type="button"
                      disabled={!skill.enabled}
                      onClick={() => void handleRunSkill(skill)}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white transition hover:bg-primary-hover disabled:opacity-40"
                    >
                      <Play size={11} />
                      <span>{t('butler.skills.runInButler')}</span>
                    </button>

                    <div className="flex items-center gap-1">
                      <ShareToRoomButton
                        compact
                        payload={{
                          kind: 'skill',
                          skillId: skill.id,
                          slug: skill.slug,
                          name: skill.name,
                          description: skill.description,
                          category: skill.category,
                          approvalPolicy: skill.approvalPolicy,
                          triggers: skill.triggers,
                          allowedTools: skill.allowedTools,
                          instructionsMd: skill.instructionsMd,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void handleExport(skill)}
                        className="rounded-lg border border-line bg-surface-4 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover hover:text-ink"
                      >
                        {t('butler.skills.exportMd')}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditEditor(skill)}
                        className="rounded-lg border border-line bg-surface-4 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover hover:text-ink"
                      >
                        {t('common.edit')}
                      </button>
                      {confirmDeleteId === skill.id ? (
                        <button
                          type="button"
                          onClick={() => {
                            void deleteSkill(skill.id).then(() => {
                              setConfirmDeleteId(null);
                              toast.info(t('butler.skills.deletedToast'));
                            });
                          }}
                          className="rounded-lg bg-danger px-2 py-1 text-xs font-medium text-white"
                        >
                          {t('common.confirm')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(skill.id)}
                          aria-label={t('common.delete')}
                          className="rounded-lg p-1 text-ink-3 hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        {editorOpen && (
          <form
            onSubmit={(e) => void handleSave(e)}
            className="space-y-3 rounded-2xl border border-line bg-surface-4 p-4 shadow-card"
          >
            <div className="flex items-center justify-between border-b border-line-soft pb-2.5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <BookmarkPlus size={14} className="text-primary" />
                <span>{t(editingId ? 'butler.skills.editTitle' : 'butler.skills.createTitle')}</span>
              </h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="rounded p-1 text-ink-3 hover:text-ink"
                aria-label={t('common.close')}
              >
                <X size={14} />
              </button>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.skills.fieldName')}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-ink-2">{t('butler.skills.fieldSlug')}</span>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder={t('butler.skills.placeholderSlug')}
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
                />
              </label>

              <label className="block space-y-1 text-xs">
                <span className="font-medium text-ink-2">{t('butler.skills.fieldCategory')}</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary"
                >
                  <option value="code">{t('butler.skills.categoryCode')}</option>
                  <option value="briefing">{t('butler.skills.categoryBriefing')}</option>
                  <option value="ops">{t('butler.skills.categoryOps')}</option>
                  <option value="general">{t('butler.skills.categoryGeneral')}</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.skills.fieldPolicy')}</span>
              <select
                value={approvalPolicy}
                onChange={(e) => setApprovalPolicy(e.target.value as ButlerSkillApprovalPolicy)}
                className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="auto">{t('butler.skills.policyAuto')}</option>
                <option value="confirm_write">{t('butler.skills.policyConfirmWrite')}</option>
                <option value="confirm_all">{t('butler.skills.policyConfirmAll')}</option>
              </select>
            </label>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.skills.fieldDescription')}</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-ink-2">{t('butler.skills.fieldTriggers')}</span>
                <input
                  type="text"
                  value={triggersText}
                  onChange={(e) => setTriggersText(e.target.value)}
                  placeholder={t('butler.skills.placeholderTriggers')}
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-ink-2">{t('butler.skills.fieldAllowedTools')}</span>
                <input
                  type="text"
                  value={toolsText}
                  onChange={(e) => setToolsText(e.target.value)}
                  placeholder={t('butler.skills.placeholderTools')}
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
              </label>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.skills.fieldInstructions')}</span>
              <textarea
                rows={7}
                required
                value={instructionsMd}
                onChange={(e) => setInstructionsMd(e.target.value)}
                className="w-full rounded-xl border border-line bg-surface-3 p-2.5 text-xs text-ink outline-none focus:border-primary"
              />
            </label>

            <label className="inline-flex items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
              />
              <span>{t('butler.skills.fieldPinned')}</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="rounded-xl border border-line bg-surface-3 px-3 py-1.5 text-xs text-ink-2 hover:text-ink"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                <span>{t('common.save')}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
