import { useEffect, useMemo, useState } from 'react';
import type { SkillMetadata } from '../agent/protocol/generated/v2';
import {
  butlerSkillQuery,
  filterButlerSkillOptions,
} from '../lib/butlerSkillInvocation';
import { listButlerCodexSkills } from '../stores/butlerCodex';
import { useSlashMenu } from './ButlerSlashMenu';

function scopeLabel(scope: SkillMetadata['scope']): string {
  if (scope === 'repo') return '项目';
  if (scope === 'user') return '我的';
  if (scope === 'admin') return '管理员';
  return '系统';
}

export default function ButlerSkillMenu({
  options,
  activeIndex,
  onPick,
  onHover,
}: {
  options: readonly SkillMetadata[];
  activeIndex: number;
  onPick: (skill: SkillMetadata) => void;
  onHover: (index: number) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="可用 Skills"
      className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-20 rounded-lg bg-surface p-1.5 shadow-[var(--shadow-pop)]"
    >
      {options.map((skill, index) => (
        <button
          key={skill.path}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(skill);
          }}
          onMouseEnter={() => onHover(index)}
          className={`flex w-full items-baseline gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
            index === activeIndex ? 'bg-fill-hover' : ''
          }`}
        >
          <span className="shrink-0 text-xs font-medium text-ink">${skill.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3">
            {skill.shortDescription || skill.description}
          </span>
          <span className="shrink-0 text-[10px] text-ink-3">{scopeLabel(skill.scope)}</span>
        </button>
      ))}
    </div>
  );
}

export function useButlerSkillMenu(
  input: string,
  setInput: (value: string) => void,
) {
  const query = butlerSkillQuery(input);
  const querying = query !== null;
  const [skills, setSkills] = useState<SkillMetadata[]>([]);

  useEffect(() => {
    if (!querying) return undefined;
    let cancelled = false;
    void listButlerCodexSkills()
      .then((listed) => {
        if (!cancelled) setSkills(listed);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [querying]);

  const options = useMemo(
    () => (query === null ? [] : filterButlerSkillOptions(query, skills)),
    [query, skills],
  );
  const menu = useSlashMenu(options);
  const pick = (skill: SkillMetadata): void => {
    setInput(`$${skill.name} `);
    menu.dismiss();
  };

  return {
    ...menu,
    options,
    pick,
  };
}
