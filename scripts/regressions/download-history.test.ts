import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DOWNLOAD_HISTORY,
  addDownloadRecord,
  downloadHistoryStorageKey,
  emptyDownloadHistory,
  fileNameOfDownloadPath,
  isAbsoluteLocalPath,
  parseDownloadHistory,
  type DownloadRecordV1,
} from '../../apps/web/src/lib/downloadHistory';

const record = (id: string, completedAt: number): DownloadRecordV1 => ({
  id,
  fileName: `${id}.pdf`,
  path: `C:\\Downloads\\${id}.pdf`,
  completedAt,
});

test('下载历史按完成时间倒序保存，并限制本地记录总数', () => {
  let history = emptyDownloadHistory();
  for (let i = 0; i < MAX_DOWNLOAD_HISTORY + 3; i++) {
    history = addDownloadRecord(history, record(String(i), i));
  }

  assert.equal(history.records.length, MAX_DOWNLOAD_HISTORY);
  assert.equal(history.records[0].id, String(MAX_DOWNLOAD_HISTORY + 2));
  assert.equal(history.records.at(-1)?.id, '3');
});

test('重复记录 id 只保留最新一次，并规范损坏或乱序的持久化数据', () => {
  let history = addDownloadRecord(emptyDownloadHistory(), record('same', 1));
  history = addDownloadRecord(history, { ...record('same', 2), path: 'D:\\新位置.pdf' });
  assert.deepEqual(history.records, [{ ...record('same', 2), path: 'D:\\新位置.pdf' }]);

  const parsed = parseDownloadHistory(JSON.stringify({
    version: 1,
    records: [record('old', 10), null, record('new', 20), { id: 'bad' }],
  }));
  assert.deepEqual(parsed.records.map((item) => item.id), ['new', 'old']);
  assert.deepEqual(parseDownloadHistory('{bad'), emptyDownloadHistory());
  assert.deepEqual(parseDownloadHistory('{"version":2,"records":[]}'), emptyDownloadHistory());
});

test('旧下载记录保持兼容，消息下载来源会完整保留（issue #191）', () => {
  const source = {
    rid: 'room-general',
    roomName: 'General',
    messageId: 'message-1',
  };
  const parsed = parseDownloadHistory(JSON.stringify({
    version: 1,
    records: [
      record('legacy', 1),
      { ...record('with-source', 2), source },
      { ...record('broken-source', 3), source: { rid: 'room-general' } },
    ],
  }));

  assert.deepEqual(parsed.records, [
    { ...record('with-source', 2), source },
    record('legacy', 1),
  ]);
});

test('下载历史存储键隔离服务器和账号，并统一服务器尾部斜杠与大小写', () => {
  assert.equal(
    downloadHistoryStorageKey('HTTPS://CHAT.EXAMPLE/', 'u1'),
    downloadHistoryStorageKey('https://chat.example', 'u1'),
  );
  assert.notEqual(
    downloadHistoryStorageKey('https://chat.example', 'u1'),
    downloadHistoryStorageKey('https://chat.example', 'u2'),
  );
  assert.notEqual(
    downloadHistoryStorageKey('https://chat.example', 'u1'),
    downloadHistoryStorageKey('https://other.example', 'u1'),
  );
});

test('用户在保存对话框重命名时记录实际落盘文件名', () => {
  assert.equal(fileNameOfDownloadPath('C:\\Downloads\\最终报告.pdf', '原名.pdf'), '最终报告.pdf');
  assert.equal(fileNameOfDownloadPath('/home/user/最终报告.pdf', '原名.pdf'), '最终报告.pdf');
  assert.equal(fileNameOfDownloadPath('', '原名.pdf'), '原名.pdf');
});

test('只接受绝对文件系统路径，拒绝 URL、file URI 和相对路径', () => {
  assert.equal(isAbsoluteLocalPath('C:\\Downloads\\报告.pdf'), true);
  assert.equal(isAbsoluteLocalPath('\\\\server\\share\\报告.pdf'), true);
  assert.equal(isAbsoluteLocalPath('/home/user/报告.pdf'), true);
  assert.equal(isAbsoluteLocalPath('https://example.com/file.pdf'), false);
  assert.equal(isAbsoluteLocalPath('file:///C:/Downloads/file.pdf'), false);
  assert.equal(isAbsoluteLocalPath('../file.pdf'), false);

  const parsed = parseDownloadHistory(JSON.stringify({
    version: 1,
    records: [record('safe', 1), { ...record('unsafe', 2), path: 'https://example.com/file.pdf' }],
  }));
  assert.deepEqual(parsed.records.map((item) => item.id), ['safe']);
});
