/**
 * issue #19 修复的实时验证（临时脚本，跑真实 RC）：
 *  1. stream-room-messages 订阅 __my_messages__ 能否收到「未按房间订阅」的消息 —— 通知修复的前提
 *  2. 置顶/取消置顶是否会推送消息更新或系统消息 —— 置顶同步策略的依据
 *  3. files.list 的 url/path、附件 image_url/title_link 是相对还是绝对 —— 图片/下载修复的依据
 *  4. rest.fetchFile 对相对路径 & 绝对地址（Site_Url 拼的）都能取回文件
 *
 * 用法：pnpm exec tsx scripts/verify-issue19.ts
 */
import { RcRestClient, RcRealtimeClient, type RcMessage } from '../packages/rc-client/src/index';

const BASE = process.env.RC_BASE_URL ?? 'http://localhost:3300';
const USER = process.env.RC_USER ?? 'admin';
const PASS = process.env.RC_PASS ?? 'rcxdev123';
const USER2 = process.env.RC_USER2 ?? 'zhangsan';
const PASS2 = process.env.RC_PASS2 ?? 'zhangsan123';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const rest = new RcRestClient({ baseUrl: BASE });
  const rest2 = new RcRestClient({ baseUrl: BASE });
  const me = await rest.login(USER, PASS);
  await rest2.login(USER2, PASS2);
  console.log(`已登录 ${USER} / ${USER2}`);

  const stamp = Date.now().toString(36);
  const room = await rest.createGroup(`验证19-${stamp}`, [USER2], false);
  const rid = room._id;
  console.log(`建频道 ${room.name} (${rid})`);

  // ---- 1) __my_messages__ 全局流 ----
  const rt = new RcRealtimeClient(`${BASE.replace(/^http/, 'ws')}/websocket`);
  await rt.connect();
  await rt.login(me.authToken);
  const events: { eventName: string; msg: RcMessage }[] = [];
  rt.onStream('stream-room-messages', (eventName, args) => {
    const msg = args[0] as RcMessage;
    if (msg?._id) events.push({ eventName, msg });
  });
  rt.subscribe('stream-room-messages', '__my_messages__');
  await wait(800);

  // 注意：故意不按房间 id 订阅 —— 模拟「没打开过的会话」。
  // 本地未注册工作区限制非管理员发消息（restricted-workspace），用 admin 发不影响验证点
  await rest.sendMessage(rid, '验证全局流的消息');
  await wait(1500);
  const got = events.find((e) => e.msg.rid === rid && e.msg.msg?.includes('全局流'));
  console.log(
    got
      ? `✓ __my_messages__ 收到未订阅房间的消息（eventName=${got.eventName}）`
      : '✗ __my_messages__ 没收到消息 —— 通知修复对该服务器版本无效！',
  );

  // ---- 2) 置顶是否推送 ----
  events.length = 0;
  const sent = await rest.sendMessage(rid, '要被置顶的消息');
  await wait(800);
  events.length = 0;
  await rest.pinMessage((sent as { _id: string })._id);
  await wait(1500);
  const pinUpdate = events.find((e) => e.msg._id === (sent as { _id: string })._id);
  const pinSystem = events.find((e) => e.msg.t === 'message_pinned');
  console.log(
    `置顶后 1.5s 内收到事件 ${events.length} 条；原消息更新推送：${pinUpdate ? `有(pinned=${pinUpdate.msg.pinned})` : '无'}；message_pinned 系统消息：${pinSystem ? '有' : '无'}`,
  );
  await rest.unpinMessage((sent as { _id: string })._id);
  await wait(1200);
  const unpinned = events.filter((e) => e.msg._id === (sent as { _id: string })._id).at(-1);
  console.log(
    `取消置顶后原消息更新推送：${unpinned ? `有(pinned=${JSON.stringify(unpinned.msg.pinned)})` : '无'}；message_unpinned 系统消息：${events.some((e) => e.msg.t === 'message_unpinned') ? '有' : '无'}`,
  );

  // ---- 3) 文件字段形态 + fetchFile ----
  const blob = new Blob(['issue19 验证文件内容'], { type: 'text/plain' });
  await rest.uploadMedia(rid, blob, { fileName: '验证文件.txt' });
  await wait(800);
  const files = await rest.getRoomFiles(rid, 'c');
  const f = files[0];
  console.log(`files.list → url=${f?.url}  path=${f?.path}`);
  const history = await rest.getHistory(rid, 'c', 5);
  const fileMsg = history.find((m) => m.file?.name === '验证文件.txt');
  const att = fileMsg?.attachments?.[0];
  console.log(`attachment → title_link=${att?.title_link}`);

  if (att?.title_link) {
    const b1 = await rest.fetchFile(att.title_link);
    console.log(`✓ fetchFile(相对路径) ${b1.size} 字节`);
    const abs = `${BASE}${att.title_link}`;
    const b2 = await rest.fetchFile(abs);
    console.log(`✓ fetchFile(绝对地址) ${b2.size} 字节`);
  }

  // ---- 清理 ----
  rt.close();
  await rest.deleteRoom(rid, 'c').catch(() => {});
  console.log('已清理测试频道');
}

main().catch((err) => {
  console.error('验证失败：', err);
  process.exit(1);
});
