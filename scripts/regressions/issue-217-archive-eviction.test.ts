import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS,
  isAttachmentArchiveSuppressed,
  planAttachmentArchiveCleanup,
  suppressArchivedAttachments,
  type ArchivedAttachmentV1,
  type AttachmentArchiveV1,
} from '../../apps/web/src/lib/attachmentArchive';

const MIB = 1024 * 1024;

function record(id: string, cachedAt: number, size = 400 * MIB): ArchivedAttachmentV1 {
  return {
    fileId: id,
    rid: 'room-1',
    roomName: '项目群',
    sourcePath: `/file-upload/${id}/x.bin`,
    name: `${id}.bin`,
    size,
    cachedAt,
  };
}

/**
 * issue #217：自动下载的附件会反复重下。
 *
 * 打开房间会重扫最近一页历史，而容量淘汰删的是最旧的一批。两者一重叠，
 * 被淘汰的附件下次打开房间又被当成「没下过」拉回来，下完再把别的挤掉——
 * 「下载→挤掉→再下载」空转，流量和磁盘都在白烧。
 */
test('容量淘汰掉的附件会留下墓碑，不会被再下一次', () => {
  const settings = { ...DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS, maxTotalBytes: 1024 * MIB };
  const now = Date.now();
  const archive: AttachmentArchiveV1 = {
    version: 1,
    records: [record('old', now - 3000), record('mid', now - 2000), record('new', now - 1000)],
  };

  const plan = planAttachmentArchiveCleanup(archive, settings, now);
  assert.ok(plan.remove.length > 0, '总量超过上限时应该有要淘汰的');

  const after = suppressArchivedAttachments(
    { version: 1, records: plan.keep },
    plan.remove,
    now,
  );

  for (const evicted of plan.remove) {
    assert.equal(
      isAttachmentArchiveSuppressed(after, evicted),
      true,
      `${evicted.fileId} 被淘汰后仍会被重新下载`,
    );
  }
  // 留下来的不受影响，仍然按「已归档」处理
  for (const kept of plan.keep) {
    assert.equal(isAttachmentArchiveSuppressed(after, kept), false);
  }
});

test('留存期到期删掉的同样留墓碑——那是用户明确说过不要留的', () => {
  const settings = { ...DEFAULT_ATTACHMENT_ARCHIVE_SETTINGS, retentionDays: 30 };
  const now = Date.now();
  const expired = record('expired', now - 40 * 86_400_000, 1 * MIB);
  const fresh = record('fresh', now - 86_400_000, 1 * MIB);

  const plan = planAttachmentArchiveCleanup(
    { version: 1, records: [expired, fresh] },
    settings,
    now,
  );
  assert.deepEqual(plan.remove.map((item) => item.fileId), ['expired']);

  const after = suppressArchivedAttachments({ version: 1, records: plan.keep }, plan.remove, now);
  assert.equal(isAttachmentArchiveSuppressed(after, expired), true);
  assert.equal(isAttachmentArchiveSuppressed(after, fresh), false);
});
