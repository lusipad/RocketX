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
  // 踢人 / 设角色 都要用第二用户的 id
  let user2Id = '';
  await check('第二用户登录', async () => {
    const d = await rest2.login(USER2, PASS2);
    user2Id = d.userId;
    return d.me.username;
  });

  // ---- 会话 ----
  console.log('\n[会话]');
  const stamp = Date.now().toString(36);
  let channelId = '';
  let dmId = '';
  // 测试建出来的房间要记下来，跑完删掉 —— 每跑一次留一个「冒烟测试-xxx」频道，
  // 跑几十次就把真实用户的会话列表淹了
  const createdRooms: { rid: string; type: 'c' | 'p' }[] = [];

  await check('创建频道（中文名）', async () => {
    const room = await rest.createGroup(`冒烟测试-${stamp}`, [USER2], false);
    createdRooms.push({ rid: room._id, type: 'c' });
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
    // 讨论是独立房间，删父频道不会连带删掉它
    createdRooms.push({ rid: d._id, type: d.t === 'p' ? 'p' : 'c' });
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

  // ---- 多人聊天 ----
  console.log('\n[多人聊天]');
  await check('多人直聊：一次拉多个人', async () => {
    // 单人传 username、多人传 usernames，服务端认的是两个不同的字段，传错就失败
    const room = await rest.createDirectMessage([USER2, 'rocket.cat']);
    await rest.openDirectMessage(room._id);
    const info = await rest.getRoomInfo(room._id);
    const n = info.uids?.length ?? info.usersCount ?? 0;
    assert(n === 3, `期望 3 人（含自己），实际 ${n}`);
    assert(info.t === 'd', `RC 里多人直聊的 t 仍应是 'd'，实际 ${info.t}`);
    return `${n} 人，t=${info.t}`;
  });

  await check('多人直聊无法直接加人（这是 RC 的限制，不是我们的 bug）', async () => {
    const room = await rest.createDirectMessage([USER2, 'rocket.cat']);
    const others = await rest.searchUsers('', 20);
    const outsider = others.users.find(
      (u) => ![USER, USER2, 'rocket.cat'].includes(u.username),
    );
    if (!outsider) return '（服务器上没有第 4 个用户，跳过）';
    let rejected = false;
    try {
      await rest.inviteToRoom(room._id, 'd', outsider._id);
    } catch {
      rejected = true;
    }
    assert(rejected, 'RC 居然允许了？那客户端就该改用直接加人而不是新建会话');
    return `已确认拒绝，客户端改为新建包含所有人的会话`;
  });

  // ---- 群设置 ----
  console.log('\n[群设置]');
  await check('改群公告 / 话题 / 介绍并回读', async () => {
    // 服务端 schema 是严格模式：字段必须叫 roomAnnouncement 而不是 announcement，
    // 传错直接 400「must NOT have additional properties」——只有打真实服务器才暴露
    const stamp = Date.now().toString(36);
    await rest.saveRoomSettings(channelId, {
      announcement: `公告-${stamp}`,
      topic: `话题-${stamp}`,
      description: `介绍-${stamp}`,
    });
    const room = await rest.getRoomInfo(channelId);
    assert(room.announcement === `公告-${stamp}`, `公告没写进去：${room.announcement}`);
    assert(room.topic === `话题-${stamp}`, `话题没写进去：${room.topic}`);
    assert(room.description === `介绍-${stamp}`, `介绍没写进去：${room.description}`);
    return '三项都已生效';
  });

  await check('rooms.info 能拿到成员数与创建者', async () => {
    const room = await rest.getRoomInfo(channelId);
    assert(!!room.u?.username, '缺少创建者');
    assert((room.usersCount ?? 0) > 0, '成员数为 0');
    return `${room.usersCount} 人，创建者 ${room.u?.username}`;
  });

  await check('改群名并回读', async () => {
    const next = `冒烟改名-${Date.now().toString(36)}`;
    await rest.saveRoomSettings(channelId, { name: next });
    const room = await rest.getRoomInfo(channelId);
    assert(room.name === next || room.fname === next, `群名没改成：${room.fname ?? room.name}`);
    return next;
  });

  // ---- 斜杠命令 ----
  console.log('\n[斜杠命令]');
  await check('拉到服务器命令表', async () => {
    const cmds = await rest.listCommands();
    assert(cmds.length > 0, '一个命令都没拿到');
    assert(
      cmds.some((c) => c.command === 'me'),
      '命令表里没有 /me',
    );
    return `${cmds.length} 个命令`;
  });

  await check('commands.run 真的执行了（不是当文本发出去）', async () => {
    // 这正是之前的 bug：/me 会被原样存成一条消息文本。
    // 走 commands.run 的话，服务端产生的是一条 t='message_snippeted' 风格的动作消息，
    // 消息正文不会是 "/me ..." 这个字面量
    const marker = `冒烟-${Date.now().toString(36)}`;
    await rest.runCommand('me', channelId, marker);
    const history = await rest.getHistory(channelId, 'c', 10);
    assert(
      !history.some((m) => m.msg === `/me ${marker}`),
      '命令被当成普通文本发出去了',
    );
    assert(
      history.some((m) => m.msg.includes(marker)),
      '命令没有产生任何消息',
    );
    return '服务端执行，未泄漏成字面量';
  });

  // ---- 群管理 ----
  console.log('\n[群管理]');
  await check('房间角色：创建者是 owner', async () => {
    const roles = await rest.getRoomRoles(channelId, 'c');
    const mine = roles.find((r) => r.u.username === USER);
    assert(!!mine, `角色表里没有 ${USER}`);
    assert(mine!.roles.includes('owner'), `${USER} 不是 owner：${mine!.roles.join(',')}`);
    return `${roles.length} 人有角色`;
  });

  await check('设为管理员 / 取消管理员', async () => {
    // 建频道时就把 USER2 拉进来了，这里只是保险 —— 已经在群里会报错，忽略即可
    await rest.inviteToRoom(channelId, 'c', user2Id).catch(() => {});
    await rest.setRoomRole(channelId, 'c', user2Id, 'moderator', true);
    let roles = await rest.getRoomRoles(channelId, 'c');
    assert(
      roles.find((r) => r.u._id === user2Id)?.roles.includes('moderator'),
      '没设上管理员',
    );
    await rest.setRoomRole(channelId, 'c', user2Id, 'moderator', false);
    roles = await rest.getRoomRoles(channelId, 'c');
    assert(
      !roles.find((r) => r.u._id === user2Id)?.roles.includes('moderator'),
      '管理员没取消掉',
    );
  });

  await check('禁言 / 解除禁言（只能走斜杠命令，REST 没这个端点）', async () => {
    // channels.muteUser 和 groups.muteUser 在 RC 8.6.1 都是 404 —— 实测过。
    // 服务端只在 /mute 命令里实现了禁言，所以 muteUser() 内部走的是 commands.run
    await rest.muteUser(channelId, USER2, true);
    let room = await rest.getRoomInfo(channelId);
    assert((room.muted ?? []).includes(USER2), `没禁上言：muted=${JSON.stringify(room.muted)}`);
    await rest.muteUser(channelId, USER2, false);
    room = await rest.getRoomInfo(channelId);
    assert(!(room.muted ?? []).includes(USER2), '禁言没解除');
    return `${USER2} 禁言→解除，均生效`;
  });

  await check('移出成员（kick）', async () => {
    const before = await rest.getMembers(channelId, 'c');
    assert(before.some((m) => m._id === user2Id), `${USER2} 不在群里，没法测踢人`);
    await rest.kickFromRoom(channelId, 'c', user2Id);
    const after = await rest.getMembers(channelId, 'c');
    assert(!after.some((m) => m._id === user2Id), '人没被踢出去');
    return `${before.length} → ${after.length} 人`;
  });

  await check('设为只读 / 取消只读', async () => {
    await rest.setReadOnly(channelId, 'c', true);
    let room = await rest.getRoomInfo(channelId);
    assert(room.ro === true, '没设成只读');
    await rest.setReadOnly(channelId, 'c', false);
    room = await rest.getRoomInfo(channelId);
    assert(!room.ro, '只读没取消');
  });

  await check('归档 / 取消归档', async () => {
    await rest.archiveRoom(channelId, 'c', true);
    let room = await rest.getRoomInfo(channelId);
    assert(room.archived === true, '没归档');
    await rest.archiveRoom(channelId, 'c', false);
    room = await rest.getRoomInfo(channelId);
    assert(!room.archived, '归档没取消');
  });

  // ---- 面板数据 ----
  console.log('\n[面板]');
  await check('频道文件列表', async () => {
    const files = await rest.getRoomFiles(channelId, 'c');
    // 前面上传过两个文件（中文名文档 + 图片）
    assert(files.length >= 2, `只拿到 ${files.length} 个文件，至少该有 2 个`);
    assert(!!files[0].name, '文件缺少文件名');
    return `${files.length} 个文件，最新：${files[0].name}`;
  });

  await check('提及我的消息', async () => {
    const mentioned = await rest.getMentionedMessages(channelId);
    // 只验证接口通、返回结构对；有没有内容取决于前面发没发 @
    assert(Array.isArray(mentioned), '返回的不是数组');
    return `${mentioned.length} 条`;
  });

  // ---- 个人资料 ----
  console.log('\n[个人资料]');
  await check('改昵称并回读', async () => {
    const me = await rest.me();
    const original = me.name;
    const next = `冒烟-${Date.now().toString(36)}`;
    await rest.updateOwnBasicInfo({ name: next });
    const after = await rest.me();
    assert(after.name === next, `昵称没改成：${after.name}`);
    // 改回去，别把用户的账号名字留成测试串
    await rest.updateOwnBasicInfo({ name: original });
    return `${original} → ${next} → 已还原`;
  });

  await check('上传头像后还原', async () => {
    // 1x1 透明 PNG
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    await rest.setAvatar(new Blob([png], { type: 'image/png' }), 'smoke.png');
    const after = await rest.getUserInfo(USER);
    assert(!!after.avatarETag, '头像没上传上去（avatarETag 为空）');
    // 必须还原：这是用户的真实账号，不能给人家留一张 1x1 透明图当头像
    await rest.resetAvatar();
    return '已上传并还原为默认头像';
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
  await check('删除测试期间建的房间', async () => {
    // hideRoom 只是从自己列表里隐掉，房间还在服务器上 —— 必须真删
    let removed = 0;
    for (const r of createdRooms.reverse()) {
      try {
        await rest.deleteRoom(r.rid, r.type);
        removed++;
      } catch (err) {
        console.log(`    ! 删除 ${r.rid} 失败：${err instanceof Error ? err.message : err}`);
      }
    }
    assert(removed === createdRooms.length, `${createdRooms.length} 个房间只删掉了 ${removed} 个`);
    return `已清理 ${removed} 个房间`;
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
