import { parseSkillMarkdown } from './butlerSkillImport';
import type { ButlerSkill } from './butlerSkill';

export type ButlerBundledSkillCategory = 'core' | 'host';

const SKILL_ORDER: Readonly<Record<ButlerBundledSkillCategory, readonly string[]>> = {
  core: [
    'morning-brief',
    'evening-review',
    'room-digest',
    'weekly-report',
    'pr-comparison',
    'commitment-extraction',
    'butler-memory',
    'butler-reply-guardian',
  ],
  host: ['azure-devops-server'],
};

interface NodeDirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

interface NodeFileSystem {
  readdirSync(path: URL, options: { withFileTypes: true }): NodeDirectoryEntry[];
  readFileSync(path: URL, encoding: 'utf8'): string;
}

function nodeSkillSources(): Record<string, string> {
  const runtime = (
    globalThis as typeof globalThis & {
      process?: {
        getBuiltinModule?(name: string): unknown;
      };
    }
  ).process;
  const fs = runtime?.getBuiltinModule?.('node:fs') as NodeFileSystem | undefined;
  if (!fs) throw new Error('当前环境不能读取内置 Butler SKILL.md');

  const root = new URL(['..', 'butler', 'skills', ''].join('/'), import.meta.url);
  const sources: Record<string, string> = {};
  for (const category of Object.keys(SKILL_ORDER) as ButlerBundledSkillCategory[]) {
    const categoryRoot = new URL(`${category}/`, root);
    for (const skill of fs.readdirSync(categoryRoot, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const path = new URL(`${skill.name}/SKILL.md`, categoryRoot);
      sources[`../butler/skills/${category}/${skill.name}/SKILL.md`] =
        fs.readFileSync(path, 'utf8');
    }
  }
  return sources;
}

function sourceModules(): Record<string, string> {
  const runtime = (
    globalThis as typeof globalThis & {
      process?: {
        getBuiltinModule?(name: string): unknown;
      };
    }
  ).process;
  if (typeof runtime?.getBuiltinModule === 'function') return nodeSkillSources();

  return import.meta.glob('../butler/skills/*/*/SKILL.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
}

function normalizedSource(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n').trimEnd();
  return `${normalized}\n`;
}

function parseBundledSkill(path: string, source: string): {
  category: ButlerBundledSkillCategory;
  skill: ButlerSkill;
} {
  const match = /\/skills\/(core|host)\/([^/]+)\/SKILL\.md$/.exec(
    path.replaceAll('\\', '/'),
  );
  if (!match) throw new Error(`无效的 Butler Skill 路径：${path}`);
  const category = match[1] as ButlerBundledSkillCategory;
  const directoryName = match[2];
  const markdown = normalizedSource(source);
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!frontmatter) throw new Error(`${path} 必须使用 YAML frontmatter`);
  const keys = frontmatter[1]
    .split('\n')
    .map((line) => /^([A-Za-z][\w-]*)\s*:/.exec(line.trim())?.[1]?.toLocaleLowerCase())
    .filter((key): key is string => Boolean(key));
  if (
    keys.length !== 2
    || keys[0] !== 'name'
    || keys[1] !== 'description'
  ) {
    throw new Error(`${path} 的 frontmatter 只能依次包含 name 和 description`);
  }
  const parsed = parseSkillMarkdown(markdown);
  if (!parsed.ok) throw new Error(`${path}：${parsed.error}`);
  if (parsed.skill.name !== directoryName) {
    throw new Error(`${path} 的 name 必须与目录名一致`);
  }
  return {
    category,
    skill: {
      ...parsed.skill,
      source: markdown,
    },
  };
}

const catalog = new Map<ButlerBundledSkillCategory, Map<string, ButlerSkill>>([
  ['core', new Map()],
  ['host', new Map()],
]);

for (const [path, source] of Object.entries(sourceModules())) {
  const { category, skill } = parseBundledSkill(path, source);
  const categorySkills = catalog.get(category)!;
  if (categorySkills.has(skill.name)) throw new Error(`重复的 Butler Skill：${skill.name}`);
  categorySkills.set(skill.name, skill);
}

for (const category of Object.keys(SKILL_ORDER) as ButlerBundledSkillCategory[]) {
  const expectedNames = SKILL_ORDER[category];
  const skills = catalog.get(category)!;
  for (const name of skills.keys()) {
    if (!expectedNames.includes(name)) {
      throw new Error(`未登记的内置 Butler Skill：${category}/${name}`);
    }
  }
}

export function bundledButlerSkills(category: ButlerBundledSkillCategory): ButlerSkill[] {
  const skills = catalog.get(category)!;
  return SKILL_ORDER[category].map((name) => {
    const skill = skills.get(name);
    if (!skill) throw new Error(`缺少内置 Butler Skill：${category}/${name}`);
    return { ...skill };
  });
}
