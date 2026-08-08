import type { ButlerSkill } from './butlerSkill';

/**
 * 「npm 式装技能」的解析层：把一份 SKILL.md 文本解析成管家技能。
 *
 * 支持两种常见写法：
 * 1. YAML frontmatter：`---\nname: x\ndescription: y\n---` + 正文
 * 2. 朴素 markdown：首行 `# 标题` 当名字，其后第一段当描述，全文当正文
 *
 * 安全边界：技能正文会进入管家的提示词——导入 UI 必须完整展示全文、
 * 由用户确认后才落库；这里只负责解析与硬性校验，不做任何持久化。
 */

/** 与档案层 assertNativeSkillName 同口径：技能会落成 Codex 原生技能文件 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_LIMIT = 64;
const DESCRIPTION_LIMIT = 120;
const BODY_LIMIT = 8000;

export type ButlerSkillParseResult =
  | { ok: true; skill: ButlerSkill }
  | { ok: false; error: string };

function fail(error: string): ButlerSkillParseResult {
  return { ok: false, error };
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, '-');
}

function validate(skill: ButlerSkill): ButlerSkillParseResult {
  if (!skill.name) return fail('缺少技能名字：加一行 frontmatter `name:` 或以 `# 标题` 开头。');
  if (skill.name.length > NAME_LIMIT || !NAME_PATTERN.test(skill.name)) {
    return fail('技能名字要用小写英文/数字与连字符（如 release-check）——它会落成技能文件名；中文放描述里。');
  }
  if (!skill.description) return fail('缺少描述：frontmatter 加 `description:`，或在标题后写一段简介。');
  if (skill.description.length > DESCRIPTION_LIMIT) {
    return fail(`描述太长（>${DESCRIPTION_LIMIT} 字符），描述是给列表看的一句话。`);
  }
  if (!skill.body.trim()) return fail('正文为空：技能正文是管家执行时的方法论，不能省。');
  if (skill.body.length > BODY_LIMIT) return fail(`正文太长（>${BODY_LIMIT} 字符），拆小一点再装。`);
  return { ok: true, skill };
}

function parseFrontmatter(text: string): ButlerSkillParseResult | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  if (!match) return undefined;
  const meta = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (pair) meta.set(pair[1].toLocaleLowerCase(), pair[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  return validate({
    name: normalizeName(meta.get('name') ?? ''),
    description: meta.get('description') ?? '',
    body: match[2].trim(),
  });
}

function parseHeadline(text: string): ButlerSkillParseResult {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/);
  const headline = /^#\s+(.+)$/.exec(lines[0]?.trim() ?? '');
  if (!headline) {
    return fail('认不出格式：用 `---` frontmatter（name/description），或首行写 `# 技能名`。');
  }
  const rest = lines.slice(1);
  const firstParagraph = rest.find((line) => line.trim())?.trim() ?? '';
  return validate({
    name: normalizeName(headline[1]),
    description: firstParagraph,
    body: trimmed,
  });
}

export function parseSkillMarkdown(text: string): ButlerSkillParseResult {
  if (!text.trim()) return fail('先把 SKILL.md 的内容粘进来。');
  return parseFrontmatter(text) ?? parseHeadline(text);
}
