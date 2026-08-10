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

test('晨报只输出可扫读的行动清单，不复述分析过程', () => {
  const source = coreSkill('morning-brief');
  assert.match(source, /`## 早间简报 · 日期`/);
  assert.match(source, /`\*\*今天最重要：\*\* 动作/);
  assert.match(source, /总计不超过 7 条/);
  assert.match(source, /不得复述工具名、调用过程、Skill 规则/);
  assert.match(source, /没有已确认风险时省略/);
  assert.match(source, /正文不超过 280 个汉字/);
  assert.match(source, /一个来源失败时继续使用其余来源/);
  assert.match(source, /没有会改变今天安排的事项时/);
  assert.match(source, /禁止输出数据源排查、方法建议或优先级分析/);
  assert.match(source, /称呼只允许出现一次/);
  assert.match(source, /外部新闻、行业资讯和产品推荐默认不出现/);
  assert.match(source, /未配置 ADO 项目不算数据缺失/);
  assert.match(source, /不得仅凭 Codex Memory 中的历史项目名决定 ADO 范围/);
  assert.match(source, /不得写“我将|以下是|祝你/);
  assert.match(source, /未覆盖行不得附原因或解释/);
  assert.doesNotMatch(source, /输出四段/);
  assert.doesNotMatch(source, /可顺手处理/);
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
