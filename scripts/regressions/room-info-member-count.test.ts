import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('群信息优先显示成功加载的实际成员数，失败时回退房间人数', async () => {
  const source = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );

  // 成员列表读 store（拉人后会跟着更新），失败时才回退 rooms.info 的人数，
  // 否则一次失败就把群显示成 0 人。
  assert.match(
    source,
    /const count = \(memberError \? undefined : memberList\?\.length\) \?\? info\?\.usersCount \?\? undefined;/,
  );
  assert.match(source, /s\.memberErrors\[s\.activeRid\]/);
});
