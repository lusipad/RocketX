import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillMarkdown } from '../../apps/web/src/lib/butlerSkillImport';
import {
  listSkills,
  removeSkill,
  saveSkill,
  setButlerProfileStorage,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerProfile';

class MemoryStorage implements ButlerProfileStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('frontmatter 形式：name/description 提取，正文不含头部', () => {
  const result = parseSkillMarkdown([
    '---',
    'name: release-check',
    "description: '发版前把该看的都看一遍'",
    '---',
    '发布检查',
    '',
    '1. 查构建。',
    '2. 查未合 PR。',
  ].join('\n'));

  assert.ok(result.ok);
  assert.equal(result.skill.name, 'release-check');
  assert.equal(result.skill.description, '发版前把该看的都看一遍');
  assert.match(result.skill.body, /^发布检查/);
  assert.doesNotMatch(result.skill.body, /^---/);
});

test('朴素 markdown 形式：# 标题当名字、第一段当描述、全文当正文', () => {
  const result = parseSkillMarkdown([
    '# Meeting-Notes',
    '',
    '把散乱的讨论收敛成决定与行动项。',
    '',
    '1. 找出决定。',
  ].join('\n'));

  assert.ok(result.ok);
  assert.equal(result.skill.name, 'meeting-notes');
  assert.equal(result.skill.description, '把散乱的讨论收敛成决定与行动项。');
  assert.match(result.skill.body, /^# Meeting-Notes/);
});

test('名字折叠为小写 kebab-case；中文与路径字符被拒并提示口径', () => {
  const spaced = parseSkillMarkdown('---\nname: Release  Check\ndescription: d\n---\nbody');
  assert.ok(spaced.ok);
  assert.equal(spaced.skill.name, 'release-check');

  const chinese = parseSkillMarkdown('---\nname: 发布检查\ndescription: d\n---\nbody');
  assert.equal(chinese.ok, false);
  assert.match(chinese.ok ? '' : chinese.error, /kebab|小写英文/);

  const evil = parseSkillMarkdown('---\nname: ../escape\ndescription: d\n---\nbody');
  assert.equal(evil.ok, false);
});

test('畸形输入给出可行动的错误：空文本/没有标题/缺描述/正文过长', () => {
  assert.equal(parseSkillMarkdown('   ').ok, false);
  const noHead = parseSkillMarkdown('随便一段文字，没有标题');
  assert.equal(noHead.ok, false);
  assert.match(noHead.ok ? '' : noHead.error, /frontmatter|# 技能名/);

  const noDesc = parseSkillMarkdown('# 只有标题\n\n');
  assert.equal(noDesc.ok, false);

  const tooLong = parseSkillMarkdown(`# long-skill\n\n描述。\n\n${'字'.repeat(9000)}`);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok ? '' : tooLong.error, /正文太长/);
});

test('解析结果可直接 saveSkill；与内置同名被拒不落库', () => {
  const restore = setButlerProfileStorage(new MemoryStorage());
  try {
    const parsed = parseSkillMarkdown('---\nname: release-check\ndescription: 发版前检查\n---\n步骤正文');
    assert.ok(parsed.ok);
    saveSkill(parsed.skill);
    assert.equal(listSkills().some((skill) => skill.name === 'release-check'), true);
    removeSkill('release-check');
    assert.equal(listSkills().some((skill) => skill.name === 'release-check'), false);

    const builtin = parseSkillMarkdown('---\nname: morning-brief\ndescription: 冒充内置\n---\n正文');
    assert.ok(builtin.ok);
    assert.throws(() => saveSkill(builtin.skill), /内置技能不可修改/);
  } finally {
    restore();
  }
});
