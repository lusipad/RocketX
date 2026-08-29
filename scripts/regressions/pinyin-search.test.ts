import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { matchesBuildKeyword } from '../../apps/web/src/components/AdoLists';
import { searchIndexedFiles } from '../../apps/web/src/lib/fileIndex';
import { preloadPinyin } from '../../apps/web/src/lib/pinyin';
import { filterMessageResults } from '../../apps/web/src/lib/searchFilters';
import { searchStickerEntries } from '../../apps/web/src/lib/stickerLoader';
import { searchWork } from '../../apps/web/src/lib/workSearch';

preloadPinyin();
const pinyinReady = new Promise((resolve) => setTimeout(resolve, 500));

test('工作台工作项搜索支持中文标题拼音', async () => {
  await pinyinReady;
  const todo = { id: 'todo-1', note: '季度汇报', done: false, createdAt: 1 } as any;
  assert.equal(searchWork('jd', [todo], [], []).length, 1);
});

test('构建和文件索引搜索支持中文名称拼音', async () => {
  await pinyinReady;
  assert.equal(
    matchesBuildKeyword({ definition: '发布流水线', buildNumber: '42', project: '核心项目' } as any, 'fblsx'),
    true,
  );
  const index = {
    version: 1 as const,
    rooms: [{
      rid: 'r1',
      roomName: '项目组',
      indexedAt: 1,
      files: [{ _id: 'f1', name: '会议纪要.docx', uploadedAt: 1 } as any],
    }],
  };
  assert.equal(searchIndexedFiles(index, 'hyjy').length, 1);
});

test('全局搜索的发送人筛选支持中文姓名拼音', async () => {
  await pinyinReady;
  const message = { _id: 'm1', ts: 1, msg: '内容', u: { name: '张三', username: 'zhangsan' } } as any;
  assert.equal(filterMessageResults([message], { sender: 'zs', timeRange: 'any', fileType: 'any' }).length, 1);
});

test('贴纸标题和分组搜索支持中文拼音', async () => {
  await pinyinReady;
  const catalog = {
    groups: [],
    entries: [{
      id: 'meeting',
      title: '会议',
      packageId: 'local',
      packageTitle: '工作贴纸',
      groupId: 'work',
      groupTitle: '工作',
      src: '/meeting.png',
      fileName: 'meeting.png',
      tags: [],
    }],
  } as any;
  assert.equal(searchStickerEntries(catalog, 'hy')?.length, 1);
});

test('人名搜索入口统一接入拼音匹配', () => {
  const checks: [string, RegExp][] = [
    ['apps/web/src/components/ForwardDialog.tsx', /pinyinMatch/],
    ['apps/web/src/components/MembersPanel.tsx', /pinyinMatch/],
    ['apps/web/src/components/QuickSwitcher.tsx', /pinyinMatch/],
    ['apps/web/src/components/NewChatDialogs.tsx', /mergeUserSearchResults/],
    ['apps/web/src/components/Composer.tsx', /pinyinMatch/],
  ];
  for (const [path, pattern] of checks) assert.match(readFileSync(path, 'utf8'), pattern);
});
