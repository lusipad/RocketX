import { BookOpenText, Plus, Trash2 } from 'lucide-react';
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
  BUILT_IN_BUTLER_SKILLS,
  listSkills,
  readButlerActiveMemoryV2RawJson,
  removeSkill,
  saveSkill,
  writeButlerActiveMemoryV2RawJson,
  type ButlerSkill,
} from '../lib/butlerProfile';
import { parseSkillMarkdown } from '../lib/butlerSkillImport';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';

const KIND_LABELS: Record<ButlerMemoryKind, string> = {
  alias: '称呼',
  preference: '偏好',
  commitment: '承诺',
};

function activeMemories(): ButlerMemoryRecord[] {
  const state = parseButlerMemoryState(readButlerActiveMemoryV2RawJson() ?? '');
  return state.records.filter((record) => record.status === 'active');
}

function builtInSkillNames(): Set<string> {
  return new Set(BUILT_IN_BUTLER_SKILLS.map((skill) => skill.name));
}

/**
 * 「管家学到的」：记忆与技能的可见入口（原则 3 透明可控 / 原则 4 记忆可看可改）。
 * 每条记忆可撤销，撤销给 6 秒后悔窗口；自装技能可删，内置技能只读。
 */
export default function ButlerLearnedPanel() {
  const [memories, setMemories] = useState<ButlerMemoryRecord[]>([]);
  const [skills, setSkills] = useState<ButlerSkill[]>([]);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
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
      toast.success(`已卸掉技能「${skill.name}」`);
    } catch (error) {
      toast.error(error, '卸载技能失败');
    }
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

  if (memories.length === 0 && skills.length === 0) return null;

  const builtIn = builtInSkillNames();

  return (
    <div className="space-y-8">
      {memories.length > 0 ? (
        <section aria-label="记住的">
          <h2 className="text-sm font-medium text-ink-3">记住的</h2>
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
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink-3">
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
          <div className="mt-2 divide-y divide-line/70">
            {skills.map((skill) => (
              <div key={skill.name} className="flex min-w-0 items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink">{skill.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-3">{skill.description}</div>
                </div>
                {builtIn.has(skill.name) ? (
                  <span className="shrink-0 text-[10px] text-ink-3">内置</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => dropSkill(skill)}
                    aria-label={`卸载技能 ${skill.name}`}
                    title="卸载技能"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>

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
    </div>
  );
}
