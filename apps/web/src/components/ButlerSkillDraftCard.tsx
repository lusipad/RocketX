import { BookOpenText, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { butlerEfficiency } from '../butler/extensions/learning/runtime';
import type { ButlerSkillDraft } from '../butler/extensions/learning/skillDraft';
import { toast } from '../stores/toast';
import Dialog from './Dialog';

type EditableListKey =
  | 'whenToUse'
  | 'procedure'
  | 'reads'
  | 'produces'
  | 'confirmations'
  | 'pitfalls'
  | 'verification';

const LIST_FIELDS: Array<{
  key: EditableListKey;
  label: string;
  hint: string;
}> = [
  { key: 'whenToUse', label: '何时使用', hint: '哪些请求适合触发这项 Skill' },
  { key: 'procedure', label: '做法步骤', hint: '每行一步，保持可执行、可核对' },
  { key: 'reads', label: '会读取什么', hint: '只写确实需要的来源和范围' },
  { key: 'produces', label: '会产生什么', hint: '说明结果，同时保留只读或草稿边界' },
  { key: 'confirmations', label: '需要确认', hint: '发送、修改、启用等动作必须明确列出' },
  { key: 'pitfalls', label: '易错点', hint: '最容易误判、越权或漏证据的地方' },
  { key: 'verification', label: '如何验证', hint: '完成后怎样确认结果可信' },
];

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function DraftDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: ButlerSkillDraft;
  onClose: () => void;
  onSaved?: (name: string) => void;
}) {
  const [edited, setEdited] = useState(draft);
  const [error, setError] = useState('');

  useEffect(() => {
    setEdited(draft);
    setError('');
  }, [draft]);

  const save = (): void => {
    const normalized: ButlerSkillDraft = {
      ...edited,
      name: edited.name.trim(),
      title: edited.title.trim(),
      description: edited.description.trim(),
      ...Object.fromEntries(
        LIST_FIELDS.map(({ key }) => [key, lines(edited[key].join('\n'))]),
      ) as Pick<ButlerSkillDraft, EditableListKey>,
    };
    if (!normalized.name || !normalized.title || !normalized.description) {
      setError('名称、标题和简介都不能为空。');
      return;
    }
    if (LIST_FIELDS.some(({ key }) => normalized[key].length === 0)) {
      setError('每个部分至少保留一条可核对的内容。');
      return;
    }
    try {
      butlerEfficiency.saveDraft(normalized);
      toast.success(`已保存到技能中心：「${normalized.title}」`);
      onSaved?.(normalized.name);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <Dialog
      title={`Skill 草稿 · ${edited.title}`}
      hint="先检查触发条件、读取范围和确认边界；确认后才会写入你的私人技能中心。"
      width={720}
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            继续修改以后再说
          </button>
          <button
            type="button"
            onClick={save}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
          >
            保存到技能中心
          </button>
        </>
      )}
    >
      <div className="space-y-5 px-5 pb-5">
        <div className="flex items-start gap-2 rounded-lg bg-primary-light px-3 py-2 text-xs leading-5 text-primary">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            默认仅当前用户可用；这份 Skill
            {edited.effect === 'draft' ? '只生成待确认草稿' : '只读取和整理信息'}，不会自动获得新的写入权限。
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-ink-3">Skill 名称</span>
            <input
              value={edited.name}
              onChange={(event) => setEdited((current) => ({ ...current, name: event.target.value }))}
              className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-3">显示标题</span>
            <input
              value={edited.title}
              onChange={(event) => setEdited((current) => ({ ...current, title: event.target.value }))}
              className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-ink-3">一句话简介</span>
          <input
            value={edited.description}
            onChange={(event) => setEdited((current) => ({ ...current, description: event.target.value }))}
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
        </label>

        {LIST_FIELDS.map((field) => (
          <label key={field.key} className="block">
            <span className="text-xs font-medium text-ink-3">{field.label}</span>
            <span className="ml-2 text-[11px] text-ink-3">{field.hint}</span>
            <textarea
              aria-label={field.label}
              value={edited[field.key].join('\n')}
              rows={Math.min(6, Math.max(2, edited[field.key].length + 1))}
              onChange={(event) => setEdited((current) => ({
                ...current,
                [field.key]: event.target.value.split(/\r?\n/),
              }))}
              className="mt-1.5 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-xs leading-5 text-ink outline-none focus:border-primary"
            />
          </label>
        ))}

        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

export default function ButlerSkillDraftCard({
  draft,
  location = 'conversation',
  onSaved,
  onHidden,
}: {
  draft: ButlerSkillDraft;
  location?: 'conversation' | 'skill-center';
  onSaved?: (name: string) => void;
  onHidden?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const hideSuggestion = (): void => {
    if (draft.proposalId) butlerEfficiency.dismiss(draft.proposalId);
    butlerEfficiency.upsertDraft({ ...draft, conversationHidden: true });
    setHidden(true);
    toast.success('已收起；草稿仍保留在技能中心。');
    onHidden?.();
  };

  const discard = (): void => {
    butlerEfficiency.discardDraft(draft.id);
    setHidden(true);
    toast.undo(`已移除 Skill 草稿「${draft.title}」`, () => {
      butlerEfficiency.upsertDraft(draft);
    });
    onHidden?.();
  };

  if (hidden) return null;

  return (
    <>
      <div
        className={`mt-2 rounded-lg border border-primary/25 bg-primary-light/45 p-3 ${
          location === 'skill-center' ? 'mt-0' : 'max-w-full'
        }`}
        aria-label={`Skill 草稿 ${draft.title}`}
      >
        <div className="flex items-start gap-2">
          <Sparkles size={15} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">{draft.title}</div>
            <p className="mt-1 text-xs leading-5 text-ink-2">
              {location === 'skill-center'
                ? draft.description
                : draft.mode === 'auto'
                  ? '这套做法已经稳定出现了几次。要把它保存为可复用的 Skill 吗？'
                  : '草稿已经整理好；你确认前不会写入或启用任何 Skill。'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2.5 text-xs text-white hover:bg-primary-hover"
              >
                <BookOpenText size={12} aria-hidden="true" />
                查看草稿
              </button>
              {location === 'conversation' ? (
                <button
                  type="button"
                  onClick={hideSuggestion}
                  className="h-7 rounded px-2.5 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
                >
                  先不用
                </button>
              ) : (
                <button
                  type="button"
                  onClick={discard}
                  className="inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs text-ink-3 hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  不再保留
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {open ? (
        <DraftDialog
          draft={draft}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      ) : null}
    </>
  );
}
