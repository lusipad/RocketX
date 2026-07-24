import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS,
  archiveCandidateOf,
  attachmentArchiveStorageKey,
  emptyAttachmentArchive,
  isAttachmentArchiveSuppressed,
  parseAttachmentArchive,
  planAttachmentArchiveCleanup,
  recordArchivedAttachment,
  roomArchiveSummaries,
  suppressArchivedAttachments,
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

test('手动删除房间后只抑制已删 rid+fileId，同房间新附件仍可归档', () => {
  let state = emptyAttachmentArchive();
  state = recordArchivedAttachment(state, archived('f1', 'r1', 100, 1));
  state = recordArchivedAttachment(state, archived('f2', 'r1', 120, 2));
  state = recordArchivedAttachment(state, archived('f3', 'r2', 140, 3));

  state = suppressArchivedAttachments(state, state.records.filter((item) => item.rid === 'r1'), 10);

  assert.deepEqual(state.records.map((item) => `${item.rid}:${item.fileId}`), ['r2:f3']);
  assert.equal(isAttachmentArchiveSuppressed(state, { rid: 'r1', fileId: 'f1' }), true);
  assert.equal(isAttachmentArchiveSuppressed(state, { rid: 'r1', fileId: 'f2' }), true);
  assert.equal(isAttachmentArchiveSuppressed(state, { rid: 'r1', fileId: 'f9' }), false);
  assert.equal(isAttachmentArchiveSuppressed(state, { rid: 'r2', fileId: 'f3' }), false);

  state = recordArchivedAttachment(state, archived('fresh', 'r1', 160, 20));
  assert.equal(isAttachmentArchiveSuppressed(state, { rid: 'r1', fileId: 'fresh' }), false);
  assert.deepEqual(state.records.map((item) => `${item.rid}:${item.fileId}`), ['r1:fresh', 'r2:f3']);
});

test('手动删除抑制向后兼容、拒绝损坏条目且保持有界', () => {
  const parsed = parseAttachmentArchive(JSON.stringify({
    version: 1,
    records: [archived('f1', 'r1', 100, 1)],
    suppressed: [
      { rid: 'r1', fileId: 'f1', deletedAt: 1 },
      { rid: 'r1', fileId: 'f1', deletedAt: 2 },
      { rid: 'r2', fileId: 'f2', deletedAt: 3 },
      { rid: '', fileId: 'bad', deletedAt: 4 },
      { rid: 'r3', fileId: 'bad', deletedAt: 'oops' },
    ],
  }));
  assert.equal(isAttachmentArchiveSuppressed(parsed, { rid: 'r1', fileId: 'f1' }), true);
  assert.equal(isAttachmentArchiveSuppressed(parsed, { rid: 'r2', fileId: 'f2' }), true);
  assert.equal((parsed.suppressed ?? []).some((item) => item.fileId === 'bad'), false);

  const bounded = suppressArchivedAttachments(
    emptyAttachmentArchive(),
    Array.from({ length: 2_100 }, (_, index) => ({ rid: 'r1', fileId: `f${index}` })),
    10,
  );
  assert.equal(bounded.suppressed?.length, 2_048);
});
