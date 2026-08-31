import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('群信息优先显示成功加载的实际成员数，失败时回退房间人数', async () => {
  const source = await readFile(
    new URL('../../apps/web/src/components/RoomInfoPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /const count = memberCount \?\? info\?\.usersCount \?\? undefined;/);
  assert.match(
    source,
    /void loadMembers\(rid\)\.then\(\(m\) => \{[\s\S]*?if \(!useChat\.getState\(\)\.memberErrors\[rid\]\) setMemberCount\(m\.length\);/,
  );
});
