import { useMemo, useState, type FormEvent } from 'react';
import { BUTLER_ABILITY_TEMPLATES } from '../lib/butlerAbilityTemplates';
import { listEnabledSkills } from '../lib/butlerProfile';
import { useRoutines } from '../stores/routines';
import { toast } from '../stores/toast';
import Dialog from './Dialog';

const RUN_DAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
] as const;

const DEFAULT_RUN_DAYS = RUN_DAYS.map(({ value }) => value);
const PARAMETERIZED_SKILL_NAMES = new Set(
  BUTLER_ABILITY_TEMPLATES
    .filter((template) => template.params)
    .map((template) => template.skillName),
);

export default function ButlerRoutineCreateDialog({ onClose }: { onClose: () => void }) {
  const addRoutine = useRoutines((state) => state.addRoutine);
  const enabledSkills = useMemo(() => listEnabledSkills(), []);
  const skills = useMemo(
    () => enabledSkills.filter((skill) => !PARAMETERIZED_SKILL_NAMES.has(skill.name)),
    [enabledSkills],
  );
  const [name, setName] = useState('');
  const [skillName, setSkillName] = useState('');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>(DEFAULT_RUN_DAYS);
  const [error, setError] = useState('');
  const selectedSkill = skills.find((skill) => skill.name === skillName);

  const toggleDay = (day: number): void => {
    setDays((current) => (
      current.includes(day)
        ? current.filter((candidate) => candidate !== day)
        : [...current, day]
    ));
    setError('');
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError('请填写任务名称。');
      return;
    }
    if (!skills.some((skill) => skill.name === skillName)) {
      setError('请选择这个任务要执行的 Skill。');
      return;
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setError('请选择有效的运行时间。');
      return;
    }
    if (days.length === 0) {
      setError('至少选择一个运行日。');
      return;
    }

    const createdAt = Date.now();
    addRoutine({
      id: `routine-user-${crypto.randomUUID()}`,
      name: normalizedName,
      trigger: {
        kind: 'daily',
        time,
        ...(days.length === RUN_DAYS.length
          ? {}
          : { days: [...days].sort((left, right) => left - right) }),
      },
      skillName,
      delivery: 'today',
      enabled: true,
      createdAt,
      updatedAt: createdAt,
      runs: [],
    });
    toast.success(`已创建定时任务“${normalizedName}”`);
    onClose();
  };

  return (
    <Dialog
      title="新建定时任务"
      hint="任务会留在这里管理；到点后只触发你选择的 Skill，运行记录也回到这里。"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded border border-line px-4 text-sm text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            取消
          </button>
          <button
            type="submit"
            form="butler-routine-create-form"
            disabled={skills.length === 0}
            className="h-9 rounded bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            创建并启用
          </button>
        </>
      }
    >
      <form id="butler-routine-create-form" onSubmit={submit} className="space-y-5 px-5 py-4">
        <label className="block">
          <span className="text-sm font-medium text-ink">任务名称</span>
          <input
            type="text"
            aria-label="任务名称"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
            placeholder="例如：生成候选版本周报"
            className="mt-2 h-10 w-full rounded border border-line-strong bg-surface px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-primary"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-ink">执行 Skill</span>
          <select
            aria-label="执行 Skill"
            value={skillName}
            disabled={skills.length === 0}
            onChange={(event) => {
              setSkillName(event.target.value);
              setError('');
            }}
            className="mt-2 h-10 w-full rounded border border-line-strong bg-surface px-3 text-sm text-ink outline-none transition-colors focus:border-primary disabled:opacity-60"
          >
            <option value="">选择一个已启用的 Skill</option>
            {skills.map((skill) => (
              <option key={skill.name} value={skill.name}>{skill.name}</option>
            ))}
          </select>
          {selectedSkill ? (
            <p className="mt-1.5 text-xs leading-5 text-ink-3">{selectedSkill.description}</p>
          ) : skills.length === 0 ? (
            <p className="mt-1.5 text-xs leading-5 text-warning">
              {enabledSkills.length === 0
                ? '没有可用的 Skill，请先到技能中心启用或安装。'
                : '可用的 Skill 都需要先配置范围，请从“管理例行事务”创建。'}
            </p>
          ) : (
            <p className="mt-1.5 text-xs leading-5 text-ink-3">
              定时器只负责触发，具体做法始终由 Skill 定义。需要选择房间的 Skill 请从“管理例行事务”创建。
            </p>
          )}
        </label>

        <div className="grid gap-5 sm:grid-cols-[132px_1fr]">
          <label className="block">
            <span className="text-sm font-medium text-ink">运行时间</span>
            <input
              type="time"
              aria-label="运行时间"
              value={time}
              required
              onChange={(event) => {
                setTime(event.target.value);
                setError('');
              }}
              className="mt-2 h-10 w-full rounded border border-line-strong bg-surface px-3 text-sm text-ink outline-none transition-colors focus:border-primary"
            />
          </label>

          <fieldset>
            <legend className="text-sm font-medium text-ink">运行日</legend>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {RUN_DAYS.map(({ value, label }) => {
                const selected = days.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`周${label}`}
                    aria-pressed={selected}
                    onClick={() => toggleDay(value)}
                    className={`flex h-10 w-10 items-center justify-center rounded border text-sm font-medium transition-colors ${selected
                      ? 'border-primary bg-primary-light text-primary'
                      : 'border-line-strong bg-surface text-ink-3 hover:bg-fill-hover hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="rounded border border-line bg-surface-2 px-3 py-2.5 text-xs leading-5 text-ink-3">
          定时任务会无人值守运行，并沿用管家的默认权限；需要你决定的外部动作仍会停在确认处。
        </div>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      </form>
    </Dialog>
  );
}
