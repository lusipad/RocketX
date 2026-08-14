import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('图片下载：title_link 为空时用 image_url 填充灯箱下载路径（issue #324）', () => {
  const messageItem = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const lightbox = readFileSync('apps/web/src/components/ImageLightbox.tsx', 'utf8');

  assert.match(messageItem, /fullPath=\{att\.title_link \|\| att\.image_url\}/);
  assert.match(
    lightbox,
    /const onDownload = async \(\) => \{\s*if \(!path\.trim\(\)\) \{\s*toast\.error\('下载链接缺失', '下载失败'\);\s*return;\s*\}/,
  );
  assert.match(lightbox, /onClick=\{\(\) => void onDownload\(\)\}/);
});

