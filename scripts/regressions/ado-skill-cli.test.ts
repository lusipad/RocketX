import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('ADO Skill 以业务 MCP 为唯一读取入口，不依赖旧 Butler CLI', () => {
  const source = readFileSync(
    'apps/desktop/src-tauri/resources/codex-skills/azure-devops-server/SKILL.md',
    'utf8',
  );
  assert.match(source, /rocketx_azure_devops_server_read/);
  assert.match(source, /只调用 `rocketx_azure_devops_server_read`/);
  assert.match(source, /不要直接执行 PowerShell、命令行或网络请求/);
  assert.doesNotMatch(source, /run_azure_devops_server_cli|butler_azure_devops_server_read/);
});

test('涉及 ADO 的核心 Skills 组合调用原生 azure-devops-server Skill', () => {
  for (const name of ['morning-brief', 'evening-review', 'weekly-report', 'pr-comparison']) {
    const source = readFileSync(`apps/web/src/butler/skills/core/${name}/SKILL.md`, 'utf8');
    assert.match(source, /azure-devops-server/, name);
    assert.match(source, /rocketx_azure_devops_server_read/, name);
  }
});
