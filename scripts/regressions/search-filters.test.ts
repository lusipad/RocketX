import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import type { IndexedFileResult } from '../../apps/web/src/lib/fileIndex';
import {
  fileTypeOf,
  filterFileResults,
  filterMessageResults,
  type SearchResultFilters,
} from '../../apps/web/src/lib/searchFilters';

const NOW = new Date('2026-07-16T00:00:00Z').getTime();
const baseFilters: SearchResultFilters = { sender: '', timeRange: 'any', fileType: 'any' };

const message = (id: string, username: string, ts: string) => ({
  _id: id,
  u: { _id: username, username, name: username === 'zhangsan' ? '张三' : username },
  ts,
} as RcMessage);

const file = (id: string, name: string, username: string, uploadedAt: string, type?: string) => ({
  rid: 'r1',
  roomName: '项目群',
  indexedAt: NOW,
  file: { _id: id, name, type, uploadedAt, user: { _id: username, username } },
} as IndexedFileResult);

test('发送人筛选同时识别显示名和用户名', () => {
  const messages = [
    message('1', 'zhangsan', '2026-07-15T00:00:00Z'),
    message('2', 'lisi', '2026-07-15T00:00:00Z'),
  ];
  assert.deepEqual(
    filterMessageResults(messages, { ...baseFilters, sender: '张三' }, NOW).map((item) => item._id),
    ['1'],
  );
  assert.deepEqual(
    filterMessageResults(messages, { ...baseFilters, sender: 'LI' }, NOW).map((item) => item._id),
    ['2'],
  );
});

test('时间筛选排除范围外以及缺少时间的结果', () => {
  const messages = [
    message('recent', 'u', '2026-07-10T00:00:00Z'),
    message('old', 'u', '2026-07-01T00:00:00Z'),
    message('unknown', 'u', ''),
  ];
  assert.deepEqual(
    filterMessageResults(messages, { ...baseFilters, timeRange: '7d' }, NOW).map((item) => item._id),
    ['recent'],
  );
});

test('文件类型优先识别 MIME，并按扩展名识别文档与压缩包', () => {
  assert.equal(fileTypeOf('没有扩展名', 'image/png'), 'image');
  assert.equal(fileTypeOf('截图.PNG'), 'image');
  assert.equal(fileTypeOf('无扩展名', 'application/pdf'), 'document');
  assert.equal(fileTypeOf('方案.PDF'), 'document');
  assert.equal(fileTypeOf('源码.tar.gz'), 'archive');
  assert.equal(fileTypeOf('程序.exe'), 'other');
});

test('文件筛选组合发送人、时间和文件类型', () => {
  const files = [
    file('match', '方案.pdf', 'zhangsan', '2026-07-12T00:00:00Z'),
    file('wrong-user', '其他.pdf', 'lisi', '2026-07-12T00:00:00Z'),
    file('too-old', '旧方案.pdf', 'zhangsan', '2026-06-01T00:00:00Z'),
    file('wrong-type', '截图.png', 'zhangsan', '2026-07-12T00:00:00Z', 'image/png'),
  ];
  assert.deepEqual(
    filterFileResults(files, { sender: 'zhang', timeRange: '30d', fileType: 'document' }, NOW)
      .map((item) => item.file._id),
    ['match'],
  );
});
