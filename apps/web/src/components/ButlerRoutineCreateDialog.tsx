import { useMemo, useState, type FormEvent } from 'react';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useRoutines } from '../stores/routines';
import { toast } from '../stores/toast';
import Dialog from './Dialog';

const WEEKDAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
] as const;

export default function ButlerRoutineCreateDialog({ onClose }: { onClose: () => void }) {
  const addRoutine = useRoutines((state) => state.addRoutine);
  const skills = useCodexWorkspace((state) => state.skills).filter((skill) => skill.enabled);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const runtimeStatus = useCodexWorkspace((state) => state.status);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [skillName, setSkillName] = useState('');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState(() => new Set(WEEKDAYS.map((day) => day.value)));

  const canSubmit = useMemo(
    () => !!workspaceRoot && !!name.trim() && !!time && days.size > 0 && (!!skillName || !!prompt.trim()),
    [days.size, name, prompt, skillName, time, workspaceRoot],
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const now = Date.now();
    addRoutine({
      id: crypto.randomUUID(),
      name: name.trim(),
      trigger: {
        kind: 'daily',
        time,
        ...(days.size === 7 ? {} : { days: [...days] }),
      },
      ...(skillName ? { skillName } : { prompt: prompt.trim() }),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      runs: [],
    });
    toast.success('已创建并启用安排');
    onClose();
  };

  return (
    <Dialog
      title="新建安排"
      hint="保存后由当前 Codex 工作区按计划运行；首次创建后建议立即运行一次。"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="h-8 rounded-md px-4 text-sm text-ink-2 hover:bg-fill-hover">
            取消
          </button>
          <button
            type="submit"
            form="butler-routine-create"
            disabled={!canSubmit}
            className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-45"
          >
            创建并启用
          </button>
        </>
      }
    >
      <form id="butler-routine-create" onSubmit={submit} className="space-y-5 px-5 py-3">
        <label className="block text-sm text-ink-2">
          <span className="mb-1.5 block font-medium text-ink">任务名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            placeholder="例如：每天整理发布风险"
          />
        </label>

        <label className="block text-sm text-ink-2">
          <span className="mb-1.5 block font-medium text-ink">执行 Skill（可选）</span>
          <select
            aria-label="执行 Skill"
            value={skillName}
            onChange={(event) => setSkillName(event.target.value)}
            className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
          >
            <option value="">使用下面的任务说明</option>
            {skills.map((skill) => (
              <option key={skill.path} value={skill.name}>{skill.name}</option>
            ))}
          </select>
          {!workspaceRoot ? <span className="mt-1 block text-xs text-danger">请先在“任务”中选择工作区。</span> : null}
          {workspaceRoot && runtimeStatus === 'connecting' ? <span className="mt-1 block text-xs text-ink-3">正在读取 Codex Skills…</span> : null}
        </label>

        <label className="block text-sm text-ink-2">
          <span className="mb-1.5 block font-medium text-ink">任务说明</span>
          <textarea
            rows={4}
            value={prompt}
            disabled={!!skillName}
            onChange={(event) => setPrompt(event.target.value)}
            className="w-full resize-none rounded-md border border-line bg-surface-3 px-3 py-2 text-sm leading-6 text-ink outline-none focus:border-primary disabled:opacity-45"
            placeholder="说明每次运行要完成什么，以及怎样算完成。"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
          <label className="block text-sm text-ink-2">
            <span className="mb-1.5 block font-medium text-ink">运行时间</span>
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </label>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">重复日期</legend>
            <div className="flex gap-1.5">
              {WEEKDAYS.map((day) => {
                const selected = days.has(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-label={`周${day.label}`}
                    aria-pressed={selected}
                    onClick={() => setDays((current) => {
                      const next = new Set(current);
                      if (selected) next.delete(day.value);
                      else next.add(day.value);
                      return next;
                    })}
                    className={`h-8 w-8 rounded-full text-xs transition ${
                      selected ? 'bg-primary text-white' : 'bg-fill-1 text-ink-2 hover:bg-fill-hover'
                    }`}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
      </form>
    </Dialog>
  );
}
