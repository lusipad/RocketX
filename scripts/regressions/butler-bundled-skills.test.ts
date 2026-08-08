import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  bundledButlerSkills,
  type ButlerBundledSkillCategory,
} from '../../apps/web/src/lib/butlerBundledSkills';
import { renderButlerSkillFile } from '../../apps/web/src/lib/butlerArchive';

const EXPECTED_SKILLS: Readonly<Record<ButlerBundledSkillCategory, readonly string[]>> = {
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

test('所有托管 Butler Skill 都以独立 SKILL.md 作为唯一正文来源', () => {
  for (const category of Object.keys(EXPECTED_SKILLS) as ButlerBundledSkillCategory[]) {
    const skills = bundledButlerSkills(category);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      EXPECTED_SKILLS[category],
    );
    for (const skill of skills) {
      const path = `apps/web/src/butler/skills/${category}/${skill.name}/SKILL.md`;
      const markdown = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(skill.source, markdown);
      assert.equal(renderButlerSkillFile(skill), markdown);
    }
  }
});

test('TypeScript 只装载 Markdown Skill，不再保存托管 Skill 正文', () => {
  const profile = readFileSync('apps/web/src/lib/butlerProfile.ts', 'utf8');
  assert.doesNotMatch(profile, /\bbody:\s*`/);
  assert.doesNotMatch(profile, /目标是回答“今天先处理什么”|Profile 整理/);
  assert.match(profile, /bundledButlerSkills\('core'\)/);
  assert.doesNotMatch(profile, /registerButlerSkillProvider|skillProviders/);
});

test('高风险 Skill 明确绑定覆盖合同，ADO 统一复用 azure-devops-server Skill 与业务 MCP', () => {
  const skills = new Map(bundledButlerSkills('core').map((skill) => [skill.name, skill.body]));

  assert.match(skills.get('room-digest') ?? '', /list_room_messages/);
  assert.match(skills.get('room-digest') ?? '', /coverage\.complete=false/);
  assert.match(skills.get('commitment-extraction') ?? '', /list_room_messages/);
  assert.match(skills.get('commitment-extraction') ?? '', /覆盖不完整/);
  assert.match(skills.get('butler-reply-guardian') ?? '', /since/);
  assert.match(skills.get('butler-reply-guardian') ?? '', /unprocessedOnly: true/);
  assert.match(skills.get('weekly-report') ?? '', /azure-devops-server/);
  assert.match(skills.get('weekly-report') ?? '', /rocketx_azure_devops_server_read/);
  assert.doesNotMatch(skills.get('weekly-report') ?? '', /list_work_items|list_pull_requests|list_builds|工作台.*快照/);
  assert.match(skills.get('weekly-report') ?? '', /暂无可验证计划，待确认/);
  assert.match(skills.get('pr-comparison') ?? '', /azure-devops-server/);
  assert.match(skills.get('pr-comparison') ?? '', /rocketx_azure_devops_server_read/);
  assert.doesNotMatch(skills.get('pr-comparison') ?? '', /list_pull_requests/);
});
