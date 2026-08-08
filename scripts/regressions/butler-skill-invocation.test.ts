import assert from 'node:assert/strict';
import test from 'node:test';
import {
  butlerSkillQuery,
  filterButlerSkillOptions,
  parseButlerSkillInvocation,
} from '../../apps/web/src/lib/butlerSkillInvocation';

const SKILLS = [
  {
    name: 'room-digest',
    description: '汇总房间讨论',
    path: 'C:/skills/room-digest/SKILL.md',
    enabled: true,
  },
  {
    name: 'morning-brief',
    description: '安排今天优先级',
    path: 'C:/skills/morning-brief/SKILL.md',
    enabled: true,
  },
  {
    name: 'disabled-skill',
    description: '已停用',
    path: 'C:/skills/disabled-skill/SKILL.md',
    enabled: false,
  },
];

test('$skill 查询只在首个未完成 token 中打开', () => {
  assert.equal(butlerSkillQuery('$'), '');
  assert.equal(butlerSkillQuery('$room'), 'room');
  assert.equal(butlerSkillQuery('$room-digest '), null);
  assert.equal(butlerSkillQuery('请用 $room-digest'), null);
  assert.equal(butlerSkillQuery('/room'), null);
});

test('Skill 候选只展示启用项，并支持名称和描述检索', () => {
  assert.deepEqual(
    filterButlerSkillOptions('room', SKILLS).map((skill) => skill.name),
    ['room-digest'],
  );
  assert.deepEqual(
    filterButlerSkillOptions('今天', SKILLS).map((skill) => skill.name),
    ['morning-brief'],
  );
  assert.ok(!filterButlerSkillOptions('', SKILLS).some((skill) => skill.name === 'disabled-skill'));
});

test('手写 $skill 解析出名称和参数正文', () => {
  assert.deepEqual(parseButlerSkillInvocation('$room-digest 发布群'), {
    name: 'room-digest',
    prompt: '发布群',
  });
  assert.deepEqual(parseButlerSkillInvocation('$room-digest\n发布群\n研发群'), {
    name: 'room-digest',
    prompt: '发布群\n研发群',
  });
  assert.deepEqual(parseButlerSkillInvocation('$room-digest'), {
    name: 'room-digest',
    prompt: '',
  });
  assert.equal(parseButlerSkillInvocation('普通问题'), null);
});
