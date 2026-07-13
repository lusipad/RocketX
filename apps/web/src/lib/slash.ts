import type { RcSlashCommand } from '@rcx/rc-client';

/**
 * 斜杠命令的解析。
 *
 * 这块之前整个不存在 —— 打 `/kick @张三` 回车，它会原样变成一条文本消息广播给全群。
 * 命令一律由服务端执行（commands.run），客户端只负责认出来并转发。
 */

/**
 * 一次「命令输入」长什么样：以 / 开头，紧跟一个纯 ASCII 的命令名，然后是可选参数。
 *
 * 命令名限定 [a-zA-Z0-9_-] 是有意的，它同时把两类**不是命令**的正常文本挡在外面：
 *   - 路径：`/usr/bin/env` —— usr 后面跟的是 `/` 不是空格，整体不匹配
 *   - 中文：`/或者这样` —— 中文字符不在字符集里，不匹配
 * 这两种都会照常当普通消息发出去。
 */
const SLASH_RE = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

export interface ParsedSlash {
  command: string;
  params: string;
}

/** 这段文本是不是一次命令输入？不是就返回 null（调用方按普通消息发） */
export function parseSlash(text: string): ParsedSlash | null {
  const m = SLASH_RE.exec(text.trim());
  if (!m) return null;
  return { command: m[1].toLowerCase(), params: (m[2] ?? '').trim() };
}

export function findCommand(
  commands: RcSlashCommand[],
  name: string,
): RcSlashCommand | undefined {
  const lower = name.toLowerCase();
  return commands.find((c) => c.command.toLowerCase() === lower);
}

/**
 * 命令的中文说明。
 *
 * **不能直接用服务器返回的 description**：RC 返回的是 i18n 键名而不是人话 ——
 * 27 个命令里有 24 个是 `Slash_Shrug_Description`、`Remove_someone_from_room`
 * 这样的键（官方客户端自带词典去翻，我们没有）。直接显示等于把内部标识符糊到用户脸上。
 */
const COMMAND_ZH: Record<string, { desc: string; params?: string }> = {
  me: { desc: '以动作形式发言（显示成「你 正在敲代码」）', params: '你的动作' },
  msg: { desc: '给某人发私聊', params: '@用户名 消息内容' },
  shrug: { desc: '发送 ¯\\_(ツ)_/¯', params: '附带的消息（可选）' },
  tableflip: { desc: '发送 (╯°□°）╯︵ ┻━┻', params: '附带的消息（可选）' },
  unflip: { desc: '发送 ┬─┬ ノ( ゜-゜ノ)', params: '附带的消息（可选）' },
  lennyface: { desc: '发送 ( ͡° ͜ʖ ͡°)', params: '附带的消息（可选）' },
  gimme: { desc: '发送 ༼ つ ◕_◕ ༽つ', params: '附带的消息（可选）' },

  invite: { desc: '邀请用户加入本频道', params: '@用户名' },
  'invite-all-to': { desc: '把本频道的人全部邀请到指定频道', params: '#频道' },
  'invite-all-from': { desc: '把指定频道的人全部邀请到本频道', params: '#频道' },
  kick: { desc: '把某人移出本频道', params: '@用户名' },
  mute: { desc: '禁言某人（他将无法在本频道发言）', params: '@用户名' },
  unmute: { desc: '解除禁言', params: '@用户名' },
  ban: { desc: '封禁用户（移出并禁止再进）', params: '@用户名' },
  unban: { desc: '解除封禁', params: '@用户名' },

  create: { desc: '新建频道', params: '#频道名' },
  join: { desc: '加入指定的公开频道', params: '#频道' },
  leave: { desc: '退出当前频道' },
  part: { desc: '退出当前频道（同 /leave）' },
  hide: { desc: '从列表里隐藏会话（不退群）', params: '#会话' },
  archive: { desc: '归档频道（不再接收新消息）', params: '#频道' },
  unarchive: { desc: '取消归档', params: '#频道' },
  topic: { desc: '设置频道话题', params: '话题内容' },

  status: { desc: '设置你的状态文案', params: '状态文案' },
  help: { desc: '显示快捷键列表' },
  sendEmailAttachment: { desc: '把附件作为邮件发送', params: '消息 id' },
  'slackbridge-import': { desc: '从 Slack 导入历史消息' },
};

/** 看着像 i18n 键名吗（Slash_Shrug_Description / Remove_someone_from_room） */
function looksLikeI18nKey(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/.test(s);
}

/** 命令的说明文字。翻不出来的宁可留空，也不显示 `Slash_Xxx_Description` */
export function commandDesc(cmd: RcSlashCommand): string {
  const zh = COMMAND_ZH[cmd.command]?.desc;
  if (zh) return zh;
  const raw = cmd.description ?? '';
  return looksLikeI18nKey(raw) ? '' : raw;
}

/** 命令的参数提示，同样要挡掉 i18n 键名（/status 和 /topic 的 params 也是键） */
export function commandParams(cmd: RcSlashCommand): string {
  const zh = COMMAND_ZH[cmd.command]?.params;
  if (zh) return zh;
  const raw = cmd.params ?? '';
  return looksLikeI18nKey(raw) ? '' : raw;
}

/**
 * 光标停在命令名上时，返回已经打出来的前缀（用于弹补全面板）；否则 null。
 *
 * 只在「第一行、光标还在命令名里面」时才算：一旦打了空格进入参数区，
 * 或者换了行，补全面板就该收起来。
 */
export function slashPrefix(textBeforeCursor: string): string | null {
  const m = /^\/([a-zA-Z0-9_-]*)$/.exec(textBeforeCursor);
  return m ? m[1] : null;
}

/** 按前缀筛命令，前缀完全匹配开头的排在前面 */
export function filterCommands(
  commands: RcSlashCommand[],
  prefix: string,
  limit = 8,
): RcSlashCommand[] {
  const q = prefix.toLowerCase();
  if (!q) return commands.slice(0, limit);
  return commands
    .filter((c) => c.command.toLowerCase().includes(q))
    .sort((a, b) => {
      const as = a.command.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.command.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || a.command.localeCompare(b.command);
    })
    .slice(0, limit);
}
