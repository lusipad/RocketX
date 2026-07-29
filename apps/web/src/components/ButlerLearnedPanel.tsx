import { BookOpenText, ChevronRight, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  parseButlerMemoryState,
  restoreButlerMemory,
  revokeButlerMemory,
  serializeButlerMemoryState,
  type ButlerMemoryKind,
  type ButlerMemoryRecord,
} from '../lib/butlerMemory';
import {
  isButlerBuiltInSkill,
  isButlerSkillEnabled,
  listSkills,
  readButlerActiveMemoryV2RawJson,
  removeSkill,
  saveSkill,
  setSkillEnabled,
  writeButlerActiveMemoryV2RawJson,
  type ButlerSkill,
} from '../lib/butlerProfile';
import { parseSkillMarkdown } from '../lib/butlerSkillImport';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import Dialog, { ConfirmDialog } from './Dialog';
import { Toggle } from './SettingControls';

const KIND_LABELS: Record<ButlerMemoryKind, string> = {
  alias: '称呼',
  preference: '偏好',
  commitment: '承诺',
};

function activeMemories(): ButlerMemoryRecord[] {
  const state = parseButlerMemoryState(readButlerActiveMemoryV2RawJson() ?? '');
  return state.records.filter((record) => record.status === 'active');
}

type SkillDialogMode = 'view' | 'edit' | 'clone';

interface SkillDialogState {
  name: string;
  mode: SkillDialogMode;
}

const SECONDARY_BUTTON =
  'h-8 rounded-md border border-line px-3 text-sm text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink';
const PRIMARY_BUTTON =
  'h-8 rounded-md bg-primary px-3 text-sm text-white transition-colors hover:bg-primary-hover';

function copyName(skill: ButlerSkill, skills: readonly ButlerSkill[]): string {
  const names = new Set(skills.map((item) => item.name));
  const base = `${skill.name}-custom`;
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function SkillDetailDialog({
  skill,
  builtIn,
  enabled,
  onToggle,
  onEdit,
  onClone,
  onDelete,
  onClose,
}: {
  skill: ButlerSkill;
  builtIn: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={skill.name}
      hint={`${builtIn ? '内置技能' : '自装技能'} · ${enabled ? '正在使用' : '已停用'}`}
      width={640}
      onClose={onClose}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div>
            {!builtIn ? (
              <button
                type="button"
                onClick={onDelete}
                className="h-8 rounded-md px-3 text-sm text-danger transition-colors hover:bg-danger/10"
              >
                卸载技能
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>关闭</button>
            {builtIn ? (
              <button type="button" onClick={onClone} className={PRIMARY_BUTTON}>
                <Copy size={14} className="mr-1.5 inline" aria-hidden="true" />
                复制并定制
              </button>
            ) : (
              <button type="button" onClick={onEdit} className={PRIMARY_BUTTON}>
                <Pencil size={14} className="mr-1.5 inline" aria-hidden="true" />
                编辑技能
              </button>
            )}
          </div>
        </div>
      )}
    >
      <div className="space-y-5 px-5 pb-5">
        <div className="flex items-center justify-between gap-6 rounded-lg border border-line/80 bg-fill-1/50 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">允许管家使用</div>
            <p className="mt-0.5 text-xs leading-5 text-ink-3">
              {enabled
                ? '会出现在可用技能中，也可被例行照看调用。'
                : '保留技能内容和引用关系，但不会再被管家执行。'}
            </p>
          </div>
          <Toggle
            checked={enabled}
            onChange={onToggle}
            label={`${enabled ? '停用' : '启用'}技能 ${skill.name}`}
          />
        </div>

        <section>
          <h3 className="text-xs font-medium text-ink-3">它能做什么</h3>
          <p className="mt-1.5 text-sm leading-6 text-ink">{skill.description}</p>
        </section>

        <section>
          <h3 className="text-xs font-medium text-ink-3">方法论正文</h3>
          <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line/80 bg-fill-2/45 p-4 font-mono text-xs leading-6 text-ink-2">
            {skill.body}
          </pre>
        </section>

        {builtIn ? (
          <p className="rounded-lg bg-primary-light px-3 py-2 text-xs leading-5 text-primary">
            内置原件会随 RocketX 更新，因此保持只读；需要修改时请复制为自己的技能。
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function SkillEditorDialog({
  skill,
  mode,
  skills,
  onSaved,
  onClose,
}: {
  skill: ButlerSkill;
  mode: 'edit' | 'clone';
  skills: readonly ButlerSkill[];
  onSaved: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(mode === 'clone' ? copyName(skill, skills) : skill.name);
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);
  const [error, setError] = useState('');

  const submit = () => {
    const next = {
      name: name.trim(),
      description: description.trim(),
      body: body.trim(),
    };
    if (!next.name || !next.description || !next.body) {
      setError('名称、简介和方法论正文都不能为空。');
      return;
    }
    if (mode === 'clone' && skills.some((item) => item.name === next.name)) {
      setError('这个技能名称已经存在，请换一个名称。');
      return;
    }
    try {
      saveSkill(next);
      onSaved(next.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <Dialog
      title={mode === 'clone' ? '复制并定制技能' : '编辑技能'}
      hint={mode === 'clone'
        ? `从 ${skill.name} 创建独立副本，后续更新互不覆盖。`
        : '名称保持不变，避免打断已经引用这个技能的例行照看。'}
      width={640}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>取消</button>
          <button type="button" onClick={submit} className={PRIMARY_BUTTON}>
            {mode === 'clone' ? '保存副本' : '保存修改'}
          </button>
        </>
      )}
    >
      <div className="space-y-4 px-5 pb-5">
        <label className="block">
          <span className="text-xs font-medium text-ink-3">技能名称</span>
          <input
            value={name}
            disabled={mode === 'edit'}
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition-colors focus:border-primary disabled:bg-fill-2 disabled:text-ink-3"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-3">一句话简介</span>
          <input
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setError('');
            }}
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition-colors focus:border-primary"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-3">方法论正文</span>
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setError('');
            }}
            rows={12}
            className="mt-1.5 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-6 text-ink outline-none transition-colors focus:border-primary"
          />
        </label>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

/**
 * 「管家学到的」：记忆与技能的可见入口（原则 3 透明可控 / 原则 4 记忆可看可改）。
 * 每条记忆可撤销，撤销给 6 秒后悔窗口；技能可查看和停用，内置原件保持只读。
 */
export default function ButlerLearnedPanel() {
  const [memories, setMemories] = useState<ButlerMemoryRecord[]>([]);
  const [skills, setSkills] = useState<ButlerSkill[]>([]);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [skillDialog, setSkillDialog] = useState<SkillDialogState | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<ButlerSkill | null>(null);
  const rooms = useChat((state) => state.rooms);
  const parsed = useMemo(
    () => (importText.trim() ? parseSkillMarkdown(importText) : null),
    [importText],
  );

  const refresh = useCallback((): void => {
    setMemories(activeMemories());
    setSkills(listSkills());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const scopeLabel = (record: ButlerMemoryRecord): string | null => {
    if (record.scope.room) {
      const room = rooms[record.scope.room];
      return `仅 ${room?.fname || room?.name || '这个房间'}`;
    }
    if (record.scope.project) return `仅项目 ${record.scope.project}`;
    return null;
  };

  const forget = (record: ButlerMemoryRecord): void => {
    const raw = readButlerActiveMemoryV2RawJson() ?? '';
    const revoked = revokeButlerMemory(parseButlerMemoryState(raw), record.id);
    if (!revoked) return;
    writeButlerActiveMemoryV2RawJson(serializeButlerMemoryState(revoked.state));
    refresh();
    toast.undo(`已忘掉「${record.subject}」`, () => {
      const current = parseButlerMemoryState(readButlerActiveMemoryV2RawJson() ?? '');
      const restored = restoreButlerMemory(current, record.id);
      writeButlerActiveMemoryV2RawJson(serializeButlerMemoryState(restored.state));
      refresh();
    });
  };

  const dropSkill = (skill: ButlerSkill): void => {
    try {
      removeSkill(skill.name);
      refresh();
      setSkillDialog(null);
      setDeletingSkill(null);
      toast.success(`已卸掉技能「${skill.name}」`);
    } catch (error) {
      toast.error(error, '卸载技能失败');
    }
  };

  const toggleSkill = (skill: ButlerSkill, enabled: boolean): void => {
    try {
      setSkillEnabled(skill.name, enabled);
      refresh();
      toast.success(`已${enabled ? '启用' : '停用'}技能「${skill.name}」`);
    } catch (error) {
      toast.error(error, `${enabled ? '启用' : '停用'}技能失败`);
    }
  };

  const finishEditingSkill = (name: string): void => {
    refresh();
    setSkillDialog({ name, mode: 'view' });
    toast.success(`已保存技能「${name}」`);
  };

  const installSkill = (): void => {
    if (!parsed?.ok) return;
    try {
      saveSkill(parsed.skill);
      refresh();
      setImporting(false);
      setImportText('');
      toast.success(`已装上技能「${parsed.skill.name}」，对话里让我用它就行`);
    } catch (error) {
      toast.error(error, '安装技能失败');
    }
  };

  const selectedSkill = skillDialog
    ? skills.find((skill) => skill.name === skillDialog.name)
    : undefined;

  if (memories.length === 0 && skills.length === 0) return null;

  return (
    <div className="space-y-8">
      {memories.length > 0 ? (
        <section aria-label="记住的">
          <h2 className="text-base font-semibold text-ink">记住的</h2>
          <div className="mt-2 divide-y divide-line/70">
            {memories.map((record) => (
              <div key={record.id} className="flex min-w-0 items-center gap-2 py-2.5">
                <span className="shrink-0 text-[11px] text-ink-3">{KIND_LABELS[record.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {record.subject}
                  <span className="text-ink-3"> = </span>
                  {record.value}
                  {record.due ? <span className="text-ink-3">（{record.due}）</span> : null}
                </span>
                {scopeLabel(record) ? (
                  <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">{scopeLabel(record)}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => forget(record)}
                  aria-label={`忘掉${record.subject}`}
                  title="让管家忘掉"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {skills.length > 0 ? (
        <section aria-label="会的本事">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-ink">
              <BookOpenText size={14} aria-hidden="true" />
              会的本事
            </h2>
            <button
              type="button"
              onClick={() => setImporting((open) => !open)}
              aria-expanded={importing}
              aria-label={importing ? '收起技能安装' : '安装新技能'}
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-ink-3 transition-colors hover:bg-fill-hover hover:text-primary"
            >
              <Plus size={12} aria-hidden="true" />
              装新技能
            </button>
          </div>
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {skills.map((skill) => {
              const builtIn = isButlerBuiltInSkill(skill.name);
              const enabled = isButlerSkillEnabled(skill.name);
              return (
                <li
                  key={skill.name}
                  className={`min-w-0 rounded-lg border p-4 transition-colors ${
                    enabled
                      ? 'border-line/80 bg-fill-1/40 hover:border-ink-3/50 hover:bg-fill-hover/50'
                      : 'border-line/70 bg-fill-2/45'
                  }`}
                >
                  <div className="flex min-w-0 items-start gap-4">
                    <button
                      type="button"
                      onClick={() => setSkillDialog({ name: skill.name, mode: 'view' })}
                      aria-label={`查看技能 ${skill.name}`}
                      className="group min-w-0 flex-1 text-left"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words text-sm font-medium leading-5 text-ink">
                          {skill.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-fill-2 px-2 py-0.5 text-[10px] font-medium text-ink-2">
                          {builtIn ? '内置' : '自装'}
                        </span>
                        {!enabled ? (
                          <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                            已停用
                          </span>
                        ) : null}
                      </span>
                      <span className={`mt-2 block text-xs leading-5 ${enabled ? 'text-ink-2' : 'text-ink-3'}`}>
                        {skill.description}
                      </span>
                      <span className="mt-3 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors group-hover:text-primary">
                        查看方法论
                        <ChevronRight size={12} aria-hidden="true" />
                      </span>
                    </button>
                    <Toggle
                      checked={enabled}
                      onChange={(next) => toggleSkill(skill, next)}
                      label={`${enabled ? '停用' : '启用'}技能 ${skill.name}`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          {importing ? (
            <div className="mt-3 border-l border-primary/40 pl-4">
              <textarea
                aria-label="粘贴 SKILL.md 内容"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'粘贴一份 SKILL.md：\n---\nname: 技能名\ndescription: 一句话描述\n---\n方法论正文…\n\n（或首行 # 技能名，其后第一段当描述）'}
                rows={6}
                className="w-full resize-y border-b border-line bg-transparent px-0 py-2 font-mono text-xs leading-5 text-ink outline-none transition-colors focus:border-primary"
              />
              {parsed && !parsed.ok ? <p className="mt-2 text-xs text-danger">{parsed.error}</p> : null}
              {parsed?.ok ? (
                <div className="mt-3">
                  <div className="text-xs font-medium text-ink">
                    {parsed.skill.name}
                    <span className="ml-2 font-normal text-ink-2">{parsed.skill.description}</span>
                  </div>
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-ink-2">
                    {parsed.skill.body}
                  </pre>
                  <p className="mt-2 text-[11px] text-ink-3">
                    技能正文会成为管家执行时的指示，只装你读过并信任的内容。
                  </p>
                </div>
              ) : null}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setImporting(false);
                    setImportText('');
                  }}
                  className="h-7 rounded px-2 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={installSkill}
                  disabled={!parsed?.ok}
                  className="h-7 rounded bg-primary px-2.5 text-xs text-white hover:bg-primary-hover disabled:opacity-40"
                >
                  确认安装
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {selectedSkill && skillDialog?.mode === 'view' ? (
        <SkillDetailDialog
          skill={selectedSkill}
          builtIn={isButlerBuiltInSkill(selectedSkill.name)}
          enabled={isButlerSkillEnabled(selectedSkill.name)}
          onToggle={(enabled) => toggleSkill(selectedSkill, enabled)}
          onEdit={() => setSkillDialog({ name: selectedSkill.name, mode: 'edit' })}
          onClone={() => setSkillDialog({ name: selectedSkill.name, mode: 'clone' })}
          onDelete={() => setDeletingSkill(selectedSkill)}
          onClose={() => setSkillDialog(null)}
        />
      ) : null}

      {selectedSkill && (skillDialog?.mode === 'edit' || skillDialog?.mode === 'clone') ? (
        <SkillEditorDialog
          key={`${selectedSkill.name}:${skillDialog.mode}`}
          skill={selectedSkill}
          mode={skillDialog.mode}
          skills={skills}
          onSaved={finishEditingSkill}
          onClose={() => setSkillDialog({ name: selectedSkill.name, mode: 'view' })}
        />
      ) : null}

      {deletingSkill ? (
        <ConfirmDialog
          title="卸载技能"
          message={`确定卸载“${deletingSkill.name}”吗？引用它的例行照看会保留，但在重新安装前无法运行。`}
          confirmLabel="卸载"
          onConfirm={() => dropSkill(deletingSkill)}
          onClose={() => setDeletingSkill(null)}
        />
      ) : null}
    </div>
  );
}
