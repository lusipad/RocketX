import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('插件页读取原生插件、Skill、App 目录，并通过 AppServerController 调用稳定协议', () => {
  const page = readFileSync('apps/web/src/components/ButlerPluginsPage.tsx', 'utf8');
  const workspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  const controller = readFileSync('apps/web/src/agent/AppServerController.ts', 'utf8');

  assert.match(page, /const \[activeTab, setActiveTab\] = useState<CatalogTab>\('plugins'\)/);
  assert.match(page, /\['plugins', '插件'\]/);
  assert.match(page, /\['skills', 'Skills'\]/);
  assert.match(page, /\['apps', 'Apps'\]/);
  assert.match(page, /type PluginDirectoryTab = 'public' \| 'workspace' \| 'personal'/);
  assert.match(page, /\['public', '公开'\]/);
  assert.match(page, /\['workspace', '工作区'\]/);
  assert.match(page, /\['personal', '个人'\]/);
  assert.match(page, /const installedPlugins =/);
  assert.match(page, />已安装</);
  assert.match(page, /正在读取 Codex 目录/);
  assert.match(page, /真实的插件、Skills 和 Apps 目录/);
  assert.match(page, /Apps 目录暂不可用/);
  assert.match(page, /对话、Skills 和已安排任务仍可正常使用/);
  assert.match(page, /togglePlugin/);
  assert.match(page, /toggleSkill/);
  assert.match(page, /aria-label=\{`查看 Skill \$\{title\}`\}/);
  assert.match(page, /aria-label=\{`查看 App \$\{app\.name\}`\}/);
  assert.match(page, /selectedItem\.kind === 'plugin'/);
  assert.match(page, /selectedItem\.kind === 'skill'/);
  assert.match(page, /kind: 'app', app/);
  assert.match(page, /convertFileSrc/);
  assert.match(page, /function CatalogIcon/);
  assert.match(page, /plugin\.interface\?\.composerIcon/);
  assert.match(page, /plugin\.interface\?\.composerIconUrl/);
  assert.match(page, /plugin\.interface\?\.logoDark/);
  assert.match(page, /plugin\.interface\?\.logoUrlDark/);
  assert.match(page, /selectedItem\.detailError/);
  assert.match(page, /更多详情暂不可用/);
  assert.match(page, />\s*重试\s*</);
  assert.doesNotMatch(page, /只使用稳定的 skills\/list|插件市场协议已禁用|Memory 由 Codex 自动维护/);

  const detailHandler = page.slice(page.indexOf('const openPluginDetail'), page.indexOf('\n\n  return ('));
  assert.match(detailHandler, /detailError: true/);
  assert.doesNotMatch(detailHandler, /toast\.error/);

  assert.match(workspace, /installPlugin: async \(marketplace, pluginName\) => \{/);
  assert.match(workspace, /uninstallPlugin: async \(pluginId\) => \{/);
  assert.match(workspace, /setSkillEnabled: async \(path, enabled\) => \{/);
  assert.match(workspace, /await get\(\)\.refreshCatalog\(\)/);

  assert.match(controller, /client\.request\('skills\/list', \{ cwds: \[workspaceRoot\], forceReload: true \}\)/);
  assert.match(controller, /const optional = <T>\(request: Promise<T>\)/);
  assert.match(controller, /await Promise\.all\(\[/);
  assert.match(controller, /optional\(client\.request\('app\/list'/);
  assert.match(controller, /optional\(client\.request\('plugin\/list'/);
  assert.match(controller, /client\.request\('app\/list', \{ threadId, forceRefetch: true \}\)/);
  assert.match(controller, /client\.request\('plugin\/list', \{ cwds: \[workspaceRoot\] \}\)/);
  assert.match(controller, /catalogErrors/);
  assert.match(controller, /request\('plugin\/install', \{ remoteMarketplaceName, pluginName \}\)/);
  assert.match(controller, /request\('plugin\/uninstall', \{ pluginId \}\)/);
  assert.match(controller, /request\('plugin\/read', \{ remoteMarketplaceName, pluginName \}\)/);
});
