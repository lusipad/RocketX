import assert from 'node:assert/strict';
import test from 'node:test';
import { extractUncPaths, uncHostOf } from '../../apps/web/src/lib/uncPath';

test('识别消息里的 UNC 共享路径', () => {
  assert.deepEqual(extractUncPaths('看下 \\\\nas\\share\\x.pdf 这个文件'), [
    '\\\\nas\\share\\x.pdf',
  ]);
  assert.deepEqual(extractUncPaths('\\\\fileserver\\部门共享\\2026\\报表.xlsx'), [
    '\\\\fileserver\\部门共享\\2026\\报表.xlsx',
  ]);
});

test('去掉路径后紧跟的中英文标点', () => {
  assert.deepEqual(extractUncPaths('路径是 \\\\nas\\share\\x.pdf。'), ['\\\\nas\\share\\x.pdf']);
  assert.deepEqual(extractUncPaths('(\\\\nas\\share\\x.pdf)'), ['\\\\nas\\share\\x.pdf']);
});

test('普通文本、本地盘符和单反斜杠不误判', () => {
  assert.deepEqual(extractUncPaths('没有路径'), []);
  assert.deepEqual(extractUncPaths('C:\\Users\\foo\\a.txt'), []);
  assert.deepEqual(extractUncPaths('\\\\只有主机名'), []);
});

test('同一路径去重，多条路径都保留', () => {
  assert.deepEqual(extractUncPaths('\\\\a\\b\\1.txt 和 \\\\a\\b\\1.txt 以及 \\\\c\\d\\2.txt'), [
    '\\\\a\\b\\1.txt',
    '\\\\c\\d\\2.txt',
  ]);
});

test('段内空格截断：路径到空格为止，不吞后文', () => {
  assert.deepEqual(extractUncPaths('\\\\nas\\share\\my file.pdf 请看'), ['\\\\nas\\share\\my']);
});

test('uncHostOf 取主机名', () => {
  assert.equal(uncHostOf('\\\\nas\\share\\x.pdf'), 'nas');
  assert.equal(uncHostOf('\\\\192.168.1.10\\share'), '192.168.1.10');
});
