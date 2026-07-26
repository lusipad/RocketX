import { BookOpenText, GraduationCap, Plus } from 'lucide-react';
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
    <section className="rounded-xl bg-surface p-5 shadow-raise">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <GraduationCap size={16} className="text-primary" />
        管家学到的
      </h2>

      {memories.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {memories.map((record) => (
            <div key={record.id} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
              <span className="shrink-0 rounded bg-fill px-1.5 py-0.5 text-[11px] text-ink-2">
                {KIND_LABELS[record.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {record.subject}
                <span className="text-ink-3"> = </span>
                {record.value}
                {record.due ? <span className="text-ink-3">（{record.due}）</span> : null}
              </span>
              {scopeLabel(record) ? (
                <span className="shrink-0 text-[11px] text-ink-3">{scopeLabel(record)}</span>
              ) : null}
              <button
                type="button"
                onClick={() => forget(record)}
                className="shrink-0 px-1.5 py-1 text-xs text-ink-3 hover:text-danger"
              >
                让它忘掉
              </button>
            </div>
          ))}
        </div>
      )}

      {skills.length > 0 && (
        <div className="mt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <BookOpenText size={14} />
            会的技能
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {skills.map((skill) => (
              <span
                key={skill.name}
                title={skill.description}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink-2"
              >
                {skill.name}
                {builtIn.has(skill.name) ? (
                  <span className="text-[10px] text-ink-3">内置</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => dropSkill(skill)}
                    aria-label={`卸载技能 ${skill.name}`}
                    className="ml-0.5 text-ink-3 hover:text-danger"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            <button
              type="button"
              onClick={() => setImporting((open) => !open)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-ink-3 hover:border-primary/40 hover:text-primary"
            >
              <Plus size={12} />
              装新技能
            </button>
          </div>

          {importing && (
            <div className="mt-3 rounded-lg bg-surface-2 p-3">
              <textarea
                aria-label="粘贴 SKILL.md 内容"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'粘贴一份 SKILL.md：\n---\nname: 技能名\ndescription: 一句话描述\n---\n方法论正文…\n\n（或首行 # 技能名，其后第一段当描述）'}
                rows={6}
                className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-5 text-ink outline-none transition focus:border-primary"
              />
              {parsed && !parsed.ok ? (
                <p className="mt-2 text-xs text-danger">{parsed.error}</p>
              ) : null}
              {parsed?.ok ? (
                <div className="mt-2 rounded-md border border-line bg-surface px-3 py-2">
                  <div className="text-xs font-medium text-ink">
                    {parsed.skill.name}
                    <span className="ml-2 font-normal text-ink-2">{parsed.skill.description}</span>
                  </div>
                  {/* 技能正文会进入管家的提示词——全文强制可见，确认是唯一的闸 */}
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-ink-2">
                    {parsed.skill.body}
                  </pre>
                  <p className="mt-2 text-[11px] text-ink-3">
                    技能正文会成为管家执行时的指示，只装你读过并信任的内容。
                  </p>
                </div>
              ) : null}
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setImporting(false);
                    setImportText('');
                  }}
                  className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink hover:bg-fill-hover"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={installSkill}
                  disabled={!parsed?.ok}
                  className="rounded-md bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  确认安装
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
