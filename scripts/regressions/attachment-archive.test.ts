import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS,
  archiveCandidateOf,
  attachmentArchiveStorageKey,
  emptyAttachmentArchive,
  planAttachmentArchiveCleanup,
  recordArchivedAttachment,
  roomArchiveSummaries,
  type ArchivedAttachmentV1,
} from '../../apps/web/src/lib/attachmentArchive';

const archived = (fileId: string, rid: string, size: number, cachedAt: number): ArchivedAttachmentV1 => ({
  fileId, rid, roomName: '房间-' + rid, name: fileId + '.pdf',
  sourcePath: '/file-upload/' + fileId + '/' + fileId + '.pdf', size, cachedAt,
});

test('附件留存默认关闭且按服务器和账号隔离', () => {
  assert.equal(DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS.enabled, false);
  assert.notEqual(attachmentArchiveStorageKey('https://a.example', 'u1'), attachmentArchiveStorageKey('https://a.example', 'u2'));
  assert.equal(attachmentArchiveStorageKey('HTTPS://A.EXAMPLE/', 'u1'), attachmentArchiveStorageKey('https://a.example', 'u1'));
});

test('只提取真实 Rocket.Chat 附件，忽略 LAN 本地文件', () => {
  const message: RcMessage = {
    _id: 'm1', rid: 'r1', msg: '', ts: '2026-07-22T10:00:00.000Z', u: { _id: 'u2', username: 'other' },
    file: { _id: 'f1', name: '报告.pdf', size: 1024 },
    attachments: [{ title_link: '/file-upload/f1/report.pdf', title_link_download: true }],
  };
  assert.deepEqual(archiveCandidateOf(message), { fileId: 'f1', rid: 'r1', name: '报告.pdf', sourcePath: '/file-upload/f1/report.pdf', size: 1024 });
  assert.equal(archiveCandidateOf({ ...message, rocketxLocalPath: 'C:\\lan\\报告.pdf' }), null);
});

test('同一文件去重并按房间汇总', () => {
  let state = emptyAttachmentArchive();
  state = recordArchivedAttachment(state, archived('f1', 'r1', 100, 1));
  state = recordArchivedAttachment(state, archived('f1', 'r1', 120, 2));
  state = recordArchivedAttachment(state, archived('f2', 'r2', 300, 3));
  state = recordArchivedAttachment(state, archived('f1', 'r2', 80, 4));
  assert.equal(state.records.length, 3);
  assert.deepEqual(roomArchiveSummaries(state), [
    { rid: 'r2', roomName: '房间-r2', files: 2, bytes: 380, latestCachedAt: 4 },
    { rid: 'r1', roomName: '房间-r1', files: 1, bytes: 120, latestCachedAt: 2 },
  ]);
});

test('清理先移除过期副本，再按最旧优先收敛总配额', () => {
  const now = 40 * 86_400_000;
  const state = { version: 1 as const, records: [
    archived('expired', 'r1', 100, now - 31 * 86_400_000),
    archived('old', 'r1', 250, now - 2_000),
    archived('new', 'r2', 300, now - 1_000),
  ] };
  const plan = planAttachmentArchiveCleanup(state, { ...DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS, enabled: true, retentionDays: 30, maxTotalBytes: 400 }, now);
  assert.deepEqual(plan.remove.map((item) => item.fileId), ['expired', 'old']);
  assert.deepEqual(plan.keep.map((item) => item.fileId), ['new']);
});
