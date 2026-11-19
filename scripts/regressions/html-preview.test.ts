import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHtmlPreview } from '../../apps/web/src/lib/htmlPreview';

test('HTML 字节序标记优先于错误的上传字符集', () => {
  const html = '<h1>会话报告</h1>';
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]);
  assert.equal(decodeHtmlPreview(bytes, 'text/html; charset=utf-8'), html);
});

test('旧式 http-equiv 声明在未知响应编码时生效，忽略注释里的声明', () => {
  const head = '<!-- <meta charset=utf-8> --><meta http-equiv="Content-Type" content="text/html; charset=gbk">';
  const bytes = Buffer.concat([Buffer.from(head), Buffer.from('b2e2cad4', 'hex')]);
  assert.equal(decodeHtmlPreview(bytes, 'text/html; charset=unknown-charset'), head + '测试');
});
