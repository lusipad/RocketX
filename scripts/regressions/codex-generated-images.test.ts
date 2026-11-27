import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';

test('Codex 生成图片可预览原图并定位实际保存文件', () => {
  const picker = readFileSync('apps/web/src/components/CodexImagePicker.tsx', 'utf8');

  assert.match(picker, /const \[previewImage, setPreviewImage\] = useState<CodexGeneratedImage \| null>\(null\)/);
  assert.match(picker, /role="dialog"/);
  assert.match(picker, /t\('agent\.imagePicker\.viewOriginal'\)/);
  assert.match(zhCN['agent.imagePicker.viewOriginal'], /^查看原图$/);
  assert.ok(enUS['agent.imagePicker.viewOriginal'].trim());
  assert.match(picker, /t\('agent\.imagePicker\.revealInFolder'\)/);
  assert.match(zhCN['agent.imagePicker.revealInFolder'], /^打开所在位置$/);
  assert.ok(enUS['agent.imagePicker.revealInFolder'].trim());
  assert.match(picker, /revealDesktopPath\(image\.savedPath\)/);
  assert.match(picker, /\{previewImage\.savedPath\}/);
  assert.match(picker, /toast\.error\(reason, rawT\('agent\.imagePicker\.openError'\)\)/);
  assert.match(zhCN['agent.imagePicker.openError'], /^无法打开生成图片$/);
  assert.ok(enUS['agent.imagePicker.openError'].trim());
  assert.match(picker, /toast\.error\(reason, rawT\('agent\.imagePicker\.revealError'\)\)/);
  assert.match(zhCN['agent.imagePicker.revealError'], /^无法定位生成图片$/);
  assert.ok(enUS['agent.imagePicker.revealError'].trim());
});
