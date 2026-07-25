import { BookOpenText, GraduationCap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
  writeButlerActiveMemoryV2RawJson,
  type ButlerSkill,
} from '../lib/butlerProfile';
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
  const rooms = useChat((state) => state.rooms);

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

  if (memories.length === 0 && skills.length === 0) return null;

  const builtIn = builtInSkillNames();

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <GraduationCap size={16} className="text-primary" />
        管家学到的
      </h2>

      {memories.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {memories.map((record) => (
            <div key={record.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
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
                忘掉
              </button>
            </div>
          ))}
        </div>
      )}

      {skills.length > 0 && (
        <div className="mt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <BookOpenText size={13} />
            会的技能
          </h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
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
          </div>
        </div>
      )}
    </section>
  );
}
