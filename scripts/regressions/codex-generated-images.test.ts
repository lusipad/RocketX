import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Codex 生成图片可预览原图并定位实际保存文件', () => {
  const picker = readFileSync('apps/web/src/components/CodexImagePicker.tsx', 'utf8');

  assert.match(picker, /const \[previewImage, setPreviewImage\] = useState<CodexGeneratedImage \| null>\(null\)/);
  assert.match(picker, /role="dialog"/);
  assert.match(picker, /查看原图/);
  assert.match(picker, /打开所在位置/);
  assert.match(picker, /revealItemInDir\(image\.savedPath\)/);
  assert.match(picker, /\{previewImage\.savedPath\}/);
  assert.match(picker, /toast\.error\(reason, '无法打开生成图片'\)/);
  assert.match(picker, /toast\.error\(reason, '无法定位生成图片'\)/);
});
