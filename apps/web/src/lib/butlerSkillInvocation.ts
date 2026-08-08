export interface ButlerSkillOption {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
}

export interface ButlerSkillInvocation {
  name: string;
  prompt: string;
}

export function butlerSkillQuery(input: string): string | null {
  if (!input.startsWith('$')) return null;
  const query = input.slice(1);
  return /\s/.test(query) ? null : query;
}

function matchRank(skill: ButlerSkillOption, query: string): number {
  const name = skill.name.toLocaleLowerCase();
  const description = skill.description.toLocaleLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (description.includes(query)) return 2;
  return 3;
}

export function filterButlerSkillOptions<T extends ButlerSkillOption>(
  query: string,
  skills: readonly T[],
  limit = 8,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({ skill, rank: needle ? matchRank(skill, needle) : 0 }))
    .filter(({ rank }) => rank < 3)
    .sort((left, right) =>
      left.rank - right.rank || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit)
    .map(({ skill }) => skill);
}

export function parseButlerSkillInvocation(input: string): ButlerSkillInvocation | null {
  const match = /^\$([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  return {
    name: match[1],
    prompt: match[2]?.trim() ?? '',
  };
}
