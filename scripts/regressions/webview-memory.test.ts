import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('WebView2 在隐藏或最小化时使用正式低内存目标，显示时恢复（issue #306）', () => {
  const main = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  const config = readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8');

  assert.match(main, /SetMemoryUsageTargetLevel/);
  assert.match(main, /WebviewMemoryUsage::Low/);
  assert.match(main, /WebviewMemoryUsage::Normal/);
  assert.match(main, /WindowEvent::CloseRequested[\s\S]*window\.hide\(\)[\s\S]*WebviewMemoryUsage::Low/);
  assert.match(main, /WindowEvent::Resized[\s\S]*window\.is_minimized/);
  assert.match(main, /WindowEvent::Focused\(false\)[\s\S]*WebviewMemoryUsage::Low/);
  assert.match(main, /WindowEvent::Focused\(true\)[\s\S]*WebviewMemoryUsage::Normal/);
  assert.doesNotMatch(config, /disable-gpu/);
  assert.doesNotMatch(config, /additionalBrowserArgs/);
});
