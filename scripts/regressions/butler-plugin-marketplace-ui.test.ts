import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Skill 管理以 Codex Plugin 市场为主入口，本地 Markdown 仅作兼容导入', () => {
  const market = readFileSync('apps/web/src/components/ButlerPluginMarketplace.tsx', 'utf8');
  const learned = readFileSync('apps/web/src/components/ButlerLearnedPanel.tsx', 'utf8');

  assert.match(market, /listButlerCodexPlugins/);
  assert.match(market, /listButlerInstalledCodexPlugins/);
  assert.match(market, /withButlerMarketplaceDeadline/);
  assert.match(market, /window\.addEventListener\('offline'/);
  assert.match(market, /addButlerCodexMarketplace/);
  assert.match(market, /removeButlerCodexMarketplace/);
  assert.match(market, /installButlerCodexPlugin/);
  assert.match(market, /uninstallButlerCodexPlugin/);
  assert.match(market, /Skill 市场/);
  assert.match(market, /已配置市场/);
  assert.match(market, /当前离线，仅显示已安装 Plugin 和本地市场/);
  assert.match(market, />\s*重试\s*</);
  assert.match(market, /安装后，其 Skills 会自动出现在 \$ 菜单/);

  assert.match(learned, /<ButlerPluginMarketplace/);
  assert.match(learned, /Codex Skills/);
  assert.match(learned, /导入本地 SKILL\.md/);
  assert.doesNotMatch(learned, />装新技能</);
});
