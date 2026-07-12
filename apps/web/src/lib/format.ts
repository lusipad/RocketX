const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY = 24 * 60 * 60 * 1000;

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 会话列表时间：今天→HH:mm，昨天→昨天，7 天内→周X，更早→YYYY/M/D */
export function fmtConvTime(ms: number): string {
  if (!ms) return '';
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  if (day === today) return fmtTime(ms);
  if (day === today - DAY) return '昨天';
  if (day > today - 7 * DAY) return WEEKDAYS[new Date(ms).getDay()];
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 消息区日期分割线：今天 / 昨天 / M月D日 周X */
export function fmtDayDivider(ms: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  if (day === today) return '今天';
  if (day === today - DAY) return '昨天';
  const d = new Date(ms);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${d.getFullYear()}年${base}`;
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 系统消息文案（Rocket.Chat 消息的 t 字段） */
const SYSTEM_MESSAGES: Record<string, (user: string, msg: string) => string> = {
  uj: (u) => `${u} 加入了会话`,
  ul: (u) => `${u} 退出了会话`,
  ru: (u, m) => `${u} 将 ${m} 移出了会话`,
  au: (u, m) => `${u} 邀请 ${m} 加入了会话`,
  r: (u, m) => `${u} 将会话名称修改为 ${m}`,
  'message_pinned': (u) => `${u} 置顶了一条消息`,
  'room_changed_topic': (u, m) => `${u} 将话题修改为 ${m}`,
  'room_changed_description': (u) => `${u} 修改了会话描述`,
  'room_changed_announcement': (u) => `${u} 修改了群公告`,
  'subscription-role-added': (u, m) => `${m} 被设置为 ${u}`,
  'ut': (u) => `${u} 加入了讨论`,
  'wm': (u) => `${u}，欢迎加入`,
};

export function systemMessageText(t: string, username: string, msg: string): string {
  const fn = SYSTEM_MESSAGES[t];
  return fn ? fn(username, msg) : `${username} ${t} ${msg}`.trim();
}

export { emojiFromShortcode } from './emoji';
