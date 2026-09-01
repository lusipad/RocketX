import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path: string): Promise<string> =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('群信息的人数直接读 store，不留本地快照（issue #375）', async () => {
  const panel = await source('apps/web/src/components/RoomInfoPanel.tsx');

  // 本地 useState 快照只会停在打开面板那一刻：拉完人以后头部人数变了，
  // 群信息还显示 1 个人。
  assert.doesNotMatch(panel, /setMemberCount/);
  assert.match(panel, /const memberList = useChat\(\(s\) => \(s\.activeRid \? s\.members\[s\.activeRid\] : undefined\)\);/);
  assert.match(panel, /const memberError = useChat\(\(s\) => \(s\.activeRid \? s\.memberErrors\[s\.activeRid\] : undefined\)\);/);
  // 成员接口失败时仍回退 rooms.info 的人数，不把群显示成 0 人
  assert.match(
    panel,
    /const count = \(memberError \? undefined : memberList\?\.length\) \?\? info\?\.usersCount \?\? undefined;/,
  );
});

test('房间人数变化时强制重拉成员列表（issue #375）', async () => {
  const panel = await source('apps/web/src/components/RoomInfoPanel.tsx');
  assert.match(panel, /const roomUsersCount = rid \? rooms\[rid\]\?\.usersCount : undefined;/);
  assert.match(panel, /if \(cached && cached\.length !== roomUsersCount\) void refreshMembers\(rid\);/);

  const store = await source('apps/web/src/stores/chat.ts');
  assert.match(store, /refreshMembers: \(rid\) => get\(\)\.loadMembers\(rid, \{ force: true \}\),/);
  // force 必须作废在途请求，否则更早的响应会把新快照覆盖回去
  assert.match(store, /const version = force \? invalidateMemberRequests\(rid\) : memberVersion\(rid\);/);
  assert.match(store, /if \(!force && cached && !get\(\)\.memberErrors\[rid\]\) return cached;/);
});

test('长共享路径卡片可断行，不把聊天区顶出横向滚动条（issue #378）', async () => {
  const item = await source('apps/web/src/components/MessageItem.tsx');

  // truncate 的 white-space: nowrap 会把卡片最小宽度顶成整条路径的宽度
  assert.match(item, /<span className="min-w-0 break-all line-clamp-2">\{uncPath\}<\/span>/);
  assert.match(item, /className="mt-1 flex max-w-full min-w-0 items-center gap-1\.5 rounded-md border border-line/);
  // 气泡本身是 flex 子项，默认 min-width:auto 同样会被不可断行的内容顶宽
  assert.match(item, /className=\{`min-w-0 text-sm leading-relaxed break-words \$\{/);
});
