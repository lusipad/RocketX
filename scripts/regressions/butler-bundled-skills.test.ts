import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CORE_SKILLS = [
  'morning-brief',
  'evening-review',
  'room-digest',
  'weekly-report',
  'pr-comparison',
  'commitment-extraction',
  'message-action-extraction',
  'butler-reply-guardian',
] as const;

function coreSkill(name: typeof CORE_SKILLS[number]): string {
  return readFileSync(`apps/web/src/butler/skills/core/${name}/SKILL.md`, 'utf8').replace(/\r\n/g, '\n');
}

test('RocketX 核心 Skills 直接作为 Codex 资源打包，不再经过 Butler 解析器', () => {
  for (const name of CORE_SKILLS) {
    const source = coreSkill(name);
    assert.match(source, new RegExp(`^---\\nname: ${name}\\n`, 'u'), name);
    assert.match(source, /\ndescription: .+\n---\n/u, name);
  }

  const tauri = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(
    tauri.bundle.resources['../../web/src/butler/skills/core/'],
    'rocketx-core-skills/',
  );
  const controller = readFileSync('apps/web/src/agent/AppServerController.ts', 'utf8');
  assert.match(controller, /skills\/extraRoots\/set/);
  assert.match(controller, /process\.managedSkillRoots/);
});

test('message-action-extraction 是严格 JSON Skill，不允许自由文本输出', () => {
  const source = coreSkill('message-action-extraction');
  assert.match(source, /只输出严格 JSON/);
  assert.match(source, /最终答复只能是一个 JSON 对象/);
  assert.match(source, /不要 Markdown 代码块、解释或前后缀/);
  assert.match(source, /"title":"简洁动作标题"/);
});

test('高风险 Skills 只绑定业务 MCP，不回退到旧 Butler 工具', () => {
  const roomDigest = coreSkill('room-digest');
  const commitments = coreSkill('commitment-extraction');
  const weekly = coreSkill('weekly-report');
  const comparison = coreSkill('pr-comparison');
  const host = readFileSync(
    'apps/desktop/src-tauri/resources/codex-skills/azure-devops-server/SKILL.md',
    'utf8',
  );

  assert.match(roomDigest, /list_room_messages/);
  assert.match(roomDigest, /coverage\.complete=false/);
  assert.match(commitments, /覆盖不完整/);
  assert.match(weekly, /rocketx_azure_devops_server_read/);
  assert.match(comparison, /rocketx_azure_devops_server_read/);
  assert.match(host, /只调用 `rocketx_azure_devops_server_read`/);
  assert.doesNotMatch(`${roomDigest}\n${commitments}\n${weekly}\n${comparison}\n${host}`, /run_azure_devops_server_cli/);
});
