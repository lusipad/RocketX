/**
 * 基础功能冒烟测试：直接跑 rc-client 打真实 Rocket.Chat，覆盖 IM 核心链路。
 *
 * 用法（需要一个可登录的 RC 服务器）：
 *   cd services/ado-bridge && pnpm exec tsx ../../scripts/smoke.ts
 * 环境变量：RC_BASE_URL / RC_USER / RC_PASS / RC_USER2 / RC_PASS2
 */
import { RcRestClient, RcRealtimeClient, tsMs, type RcMessage } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';
const USER2 = process.env.RC_USER2 ?? 'zhangsan';
const PASS2 = process.env.RC_PASS2 ?? 'zhangsan123';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name} — ${err instanceof Error ? err.message : err}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(`\n冒烟测试 → ${BASE}\n`);

  // ---- 认证 ----
  const rest = new RcRestClient({ baseUrl: BASE });
  const rest2 = new RcRestClient({ baseUrl: BASE });
  let me: Awaited<ReturnType<RcRestClient['login']>>;

  console.log('[认证]');
  await check('登录', async () => {
    me = await rest.login(USER, PASS);
    assert(me.authToken && me.userId, '未拿到 token');
    return me.me.username;
  });
  await check('token 续期', async () => {
    const resumed = await rest.loginWithToken(me.authToken);
    assert(resumed.userId === me.userId, 'userId 不一致');
  });
  await check('第二用户登录', async () => {
    const d = await rest2.login(USER2, PASS2);
    return d.me.username;
  });

  // ---- 会话 ----
  console.log('\n[会话]');
  const stamp = Date.now().toString(36);
  let channelId = '';
  let dmId = '';

  await check('创建频道（中文名）', async () => {
    const room = await rest.createGroup(`冒烟测试-${stamp}`, [USER2], false);
    channelId = room._id;
    assert(channelId, '未返回房间 id');
    return room.name;
  });
  await check('会话列表包含新频道', async () => {
    const subs = await rest.getSubscriptions();
    assert(
      subs.some((s) => s.rid === channelId),
      '订阅里没有新频道',
    );
    return `${subs.length} 个会话`;
  });
  await check('发起私聊', async () => {
    const room = await rest.createDirectMessage(USER2);
    dmId = room._id;
    await rest.openDirectMessage(dmId);
    assert(dmId, '未返回 DM id');
  });
  await check('成员列表', async () => {
    const members = await rest.getMembers(channelId, 'c');
    assert(members.length >= 2, `成员数异常: ${members.length}`);
    return `${members.length} 人`;
  });

  // ---- 消息 ----
  console.log('\n[消息]');
  let firstId = '';

  await check('发送消息', async () => {
    const msg = await rest.sendMessage(channelId, '冒烟测试：第一条消息');
    firstId = msg._id;
    assert(firstId, '未返回消息 id');
  });
  await check('历史消息', async () => {
    const history = await rest.getHistory(channelId, 'c', 20);
    assert(
      history.some((m) => m._id === firstId),
      '历史里没有刚发的消息',
    );
    // 断言时间升序
    for (let i = 1; i < history.length; i++) {
      assert(tsMs(history[i].ts) >= tsMs(history[i - 1].ts), '历史消息未按时间升序');
    }
    return `${history.length} 条`;
  });
  await check('编辑消息', async () => {
    const updated = await rest.updateMessage(channelId, firstId, '冒烟测试：已编辑');
    assert(updated.msg === '冒烟测试：已编辑', '内容未更新');
    assert(updated.editedAt, '缺少 editedAt 标记');
  });
  await check('表情回应', async () => {
    await rest.react(firstId, ':thumbsup:');
    const history = await rest.getHistory(channelId, 'c', 5);
    const msg = history.find((m) => m._id === firstId);
    assert(msg?.reactions?.[':thumbsup:']?.usernames?.length, '回应未记录');
  });
  await check('置顶 / 取消置顶', async () => {
    await rest.pinMessage(firstId);
    const pinned = await rest.getPinnedMessages(channelId);
    assert(
      pinned.some((m) => m._id === firstId),
      '置顶列表里没有该消息',
    );
    await rest.unpinMessage(firstId);
  });
  await check('标记（星标）', async () => {
    await rest.starMessage(firstId);
    const starred = await rest.getStarredMessages(channelId);
    assert(
      starred.some((m) => m._id === firstId),
      '标记列表里没有该消息',
    );
    await rest.unstarMessage(firstId);
  });
  await check('引用回复（服务端展开）', async () => {
    const link = `${BASE}/channel/冒烟测试-${stamp}?msg=${firstId}`;
    const quoted = await rest.sendMessageRaw({
      rid: channelId,
      msg: `[ ](${link}) 这是引用回复`,
    });
    const history = await rest.getHistory(channelId, 'c', 3);
    const msg = history.find((m) => m._id === quoted._id);
    assert(msg?.attachments?.[0]?.message_link, '服务端未展开引用附件');
    return `引用了 ${msg!.attachments![0].author_name}`;
  });
  await check('话题（线程）回复', async () => {
    await rest.sendMessage(channelId, '线程回复', firstId);
    const thread = await rest.getThreadMessages(firstId);
    assert(thread.length >= 1, '线程消息为空');
    return `${thread.length} 条回复`;
  });
  await check('搜索消息（中文子串）', async () => {
    const found = await rest.searchMessages(channelId, '冒烟');
    assert(found.length > 0, '中文子串搜不到（检查 Message_AlwaysSearchRegExp）');
    return `${found.length} 条命中`;
  });
  await check('创建讨论', async () => {
    const d = await rest.createDiscussion(channelId, `讨论-${stamp}`, firstId);
    assert(d._id && d.prid === channelId, '讨论未正确关联父房间');
  });

  // ---- 文件 ----
  console.log('\n[文件]');
  await check('上传中文名文件 + 文件名保真', async () => {
    const name = '项目计划书.txt';
    await rest.uploadMedia(channelId, new File(['内容'], name, { type: 'text/plain' }));
    const history = await rest.getHistory(channelId, 'c', 1);
    assert(history[0]?.file?.name === name, `文件名被破坏: ${history[0]?.file?.name}`);
    return name;
  });
  await check('上传图片 + 附件带 image_url', async () => {
    // 1x1 PNG
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    await rest.uploadMedia(channelId, new File([png], '截图.png', { type: 'image/png' }));
    const history = await rest.getHistory(channelId, 'c', 1);
    assert(history[0]?.attachments?.[0]?.image_url, '图片附件缺少 image_url');
  });
  await check('带认证下载文件', async () => {
    const history = await rest.getHistory(channelId, 'c', 5);
    const fileMsg = history.reverse().find((m) => m.file?.name === '项目计划书.txt');
    const link = fileMsg?.attachments?.[0]?.title_link;
    assert(link, '找不到文件链接');
    const blob = await rest.fetchFile(link!);
    assert(blob.size > 0, '下载内容为空');
    return `${blob.size} 字节`;
  });

  // ---- 会话管理 ----
  console.log('\n[会话管理]');
  await check('置顶会话 / 取消', async () => {
    await rest.favoriteRoom(channelId, true);
    const subs = await rest.getSubscriptions();
    assert(subs.find((s) => s.rid === channelId)?.f, '未标记 favorite');
    await rest.favoriteRoom(channelId, false);
  });
  await check('免打扰 / 取消', async () => {
    await rest.muteRoom(channelId, true);
    const subs = await rest.getSubscriptions();
    assert(subs.find((s) => s.rid === channelId)?.disableNotifications, '未设置免打扰');
    await rest.muteRoom(channelId, false);
  });
  await check('标为已读', async () => {
    await rest2.sendMessage(channelId, '来自第二用户的未读消息');
    await new Promise((r) => setTimeout(r, 800));
    await rest.markRead(channelId);
    const subs = await rest.getSubscriptions();
    const sub = subs.find((s) => s.rid === channelId);
    assert(sub && sub.unread === 0 && !sub.alert, '未读未清零');
  });
  await check('通讯录目录', async () => {
    const { result, total } = await rest.directory('users', '', 20);
    assert(result.length > 0 && total > 0, '目录为空');
    return `${total} 个用户`;
  });
  await check('spotlight 搜索', async () => {
    const { users } = await rest.spotlight(USER2);
    assert(
      users.some((u) => u.username === USER2),
      '搜不到第二用户',
    );
  });

  // ---- 实时 ----
  console.log('\n[实时]');
  await check('WebSocket 连接 + 登录', async () => {
    const wsUrl = `${BASE.replace(/^http/, 'ws')}/websocket`;
    const rt = new RcRealtimeClient(wsUrl);
    await rt.connect();
    await rt.login(me.authToken);
    assert(rt.status === 'connected', `状态异常: ${rt.status}`);

    // 订阅房间，等第二用户发消息推送过来
    const received = new Promise<RcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('10 秒未收到实时消息')), 10_000);
      rt.onStream('stream-room-messages', (_rid, args) => {
        const msg = args[0] as RcMessage;
        if (msg?.msg?.includes('实时推送测试')) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    rt.subscribe('stream-room-messages', channelId);
    await new Promise((r) => setTimeout(r, 500));
    await rest2.sendMessage(channelId, '实时推送测试');
    const msg = await received;
    rt.close();
    return `收到「${msg.msg}」`;
  });

  // ---- 清理 ----
  console.log('\n[清理]');
  await check('删除消息', async () => {
    // 用一条干净消息：作为线程/讨论父级的消息 RC 会保留占位，不适合测删除
    const tmp = await rest.sendMessage(channelId, '待删除的消息');
    await rest.deleteMessage(channelId, tmp._id);
    const history = await rest.getHistory(channelId, 'c', 30);
    assert(!history.some((m) => m._id === tmp._id), '消息未删除');
  });
  await check('隐藏会话', async () => {
    await rest.hideRoom(dmId, 'd');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
