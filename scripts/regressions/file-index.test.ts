import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcRoomFile } from '../../packages/rc-client/src/index';
import {
  MAX_FILES_PER_ROOM,
  MAX_INDEXED_ROOMS,
  canSearchIndexedRoom,
  emptyFileIndex,
  fileIndexStorageKey,
  indexRoomFiles,
  parseFileIndex,
  searchIndexedFiles,
} from '../../apps/web/src/lib/fileIndex';

const file = (id: string, name = `${id}.pdf`, uploadedAt?: string): RcRoomFile => ({
  _id: id,
  name,
  uploadedAt,
  url: `/secret/${id}`,
});

test('文件索引只保存元数据并限制每个房间的文件数', () => {
  const files = Array.from({ length: MAX_FILES_PER_ROOM + 5 }, (_, i) => file(String(i)));
  const index = indexRoomFiles(emptyFileIndex(), 'r1', '项目群', files, 10);

  assert.equal(index.rooms[0].files.length, MAX_FILES_PER_ROOM);
  assert.equal(index.rooms[0].files[0].url, undefined);
});

test('文件索引按最近访问保留有限房间并更新同一房间', () => {
  let index = emptyFileIndex();
  for (let i = 0; i < MAX_INDEXED_ROOMS + 2; i++) {
    index = indexRoomFiles(index, `r${i}`, `房间${i}`, [file(String(i))], i);
  }
  assert.equal(index.rooms.length, MAX_INDEXED_ROOMS);
  assert.equal(index.rooms[0].rid, `r${MAX_INDEXED_ROOMS + 1}`);
  assert.equal(index.rooms.some((room) => room.rid === 'r0'), false);

  index = indexRoomFiles(index, 'r5', '重命名房间', [file('new')], 99);
  assert.equal(index.rooms[0].roomName, '重命名房间');
  assert.equal(index.rooms.filter((room) => room.rid === 'r5').length, 1);
});

test('文件搜索按上传时间排序且只匹配文件名', () => {
  let index = indexRoomFiles(emptyFileIndex(), 'r1', '一群', [file('a', '发布清单.pdf', '2026-07-01')], 1);
  index = indexRoomFiles(index, 'r2', '发布讨论', [file('b', '发布说明.docx', '2026-07-02')], 2);
  index = indexRoomFiles(index, 'r3', '三群', [file('c', '普通文件.txt', '2026-07-03')], 3);

  assert.deepEqual(searchIndexedFiles(index, '发布').map((item) => item.file._id), ['b', 'a']);
  assert.deepEqual(searchIndexedFiles(index, '讨论'), []);
});

test('文件索引存储键隔离服务器和用户，损坏版本安全回退', () => {
  assert.notEqual(fileIndexStorageKey('https://a.example/', 'u1'), fileIndexStorageKey('https://a.example', 'u2'));
  assert.notEqual(fileIndexStorageKey('https://a.example', 'u1'), fileIndexStorageKey('https://b.example', 'u1'));
  assert.deepEqual(parseFileIndex('{bad'), emptyFileIndex());
  assert.deepEqual(parseFileIndex('{"version":2,"rooms":[]}'), emptyFileIndex());
});

test('旧索引不会让已离开的私有房间继续出现在搜索中', () => {
  assert.equal(canSearchIndexedRoom(false, 'p'), false);
  assert.equal(canSearchIndexedRoom(false, 'd'), false);
  assert.equal(canSearchIndexedRoom(false, 'c'), true);
  assert.equal(canSearchIndexedRoom(true, 'p'), true);
});
