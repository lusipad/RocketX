import type { RcSlashCommand } from '@rcx/rc-client';
import { t } from '../i18n';
import type { CommandDialog } from '../stores/commandUi';

/**
 * 斜杠命令的客户端注册表与逐项执行策略。
 *
 * 之前 27 个命令一律盲转发服务端（commands.run）：参数苛刻、失败只有一条 toast、
 * 完全没有 GUI。现在每个命令都有一句话策略：
 *   - text    纯文本类：客户端改写文本后直接发送（服务端实现也只是改文本，无需绕一圈）
 *   - gui     参数化动作类：解析参数作预填值，打开对应 GUI（对话框里的确认按钮才执行动作）
 *   - forward 客户端做不了的（无 REST 端点 / 服务器应用提供）：仍走 commands.run
 *
 * 注册表同时是「已知命令」的来源之一：即使服务端 commands.list 没返回某个命令，
 * 只要这里有实现（text/gui），就不会被当成未知命令拦下。
 */

export type ClientCommandAction =
  | { type: 'send'; text: string }
  | { type: 'open'; dialog: CommandDialog }
  | { type: 'panel'; panel: 'kanban' | 'oncall' }
  | { type: 'hideConv'; rid: string }
  | { type: 'forward' };

export interface ClientCommandInfo {
  desc: string;
  params?: string;
  kind: 'text' | 'gui' | 'forward';
}

/**
 * 全量中文说明表。
 *
 * **不能直接用服务器返回的 description**：RC 返回的是 i18n 键名而不是人话 ——
 * `Slash_Shrug_Description`、`Remove_someone_from_room` 这样的键。官方客户端自带
 * 词典去翻，我们没有；直接显示等于把内部标识符糊到用户脸上。
 *
 * 文案规范：一句陈述语气的短句说清「做什么」；颜文字命令用文字描述，
 * 不把颜文字本身堆进说明里。这里的 desc 同时是兜底：即使服务端给了可读描述，
 * 也以这里为准，保证全列表口径一致。
 */
export const COMMAND_INFO: Record<string, ClientCommandInfo> = {
  // ---- 纯文本类（客户端直发） ----
  me: {
    get desc() { return t('chat.command.me.desc'); },
    get params() { return t('chat.command.me.params'); },
    kind: 'forward',
  },
  shrug: {
    get desc() { return t('chat.command.shrug.desc'); },
    get params() { return t('chat.command.optionalMessageParams'); },
    kind: 'text',
  },
  tableflip: {
    get desc() { return t('chat.command.tableflip.desc'); },
    get params() { return t('chat.command.optionalMessageParams'); },
    kind: 'text',
  },
  unflip: {
    get desc() { return t('chat.command.unflip.desc'); },
    get params() { return t('chat.command.optionalMessageParams'); },
    kind: 'text',
  },
  lennyface: {
    get desc() { return t('chat.command.lennyface.desc'); },
    get params() { return t('chat.command.optionalMessageParams'); },
    kind: 'text',
  },
  gimme: {
    get desc() { return t('chat.command.gimme.desc'); },
    get params() { return t('chat.command.optionalMessageParams'); },
    kind: 'text',
  },

  // ---- 参数化动作类（打开 GUI） ----
  msg: {
    get desc() { return t('chat.command.msg.desc'); },
    get params() { return t('chat.command.msg.params'); },
    kind: 'gui',
  },
  invite: {
    get desc() { return t('chat.command.invite.desc'); },
    get params() { return t('chat.command.invite.params'); },
    kind: 'gui',
  },
  'invite-all-to': {
    get desc() { return t('chat.command.inviteAllTo.desc'); },
    get params() { return t('chat.command.inviteAllTo.params'); },
    kind: 'gui',
  },
  'invite-all-from': {
    get desc() { return t('chat.command.inviteAllFrom.desc'); },
    get params() { return t('chat.command.inviteAllFrom.params'); },
    kind: 'gui',
  },
  kick: {
    get desc() { return t('chat.command.kick.desc'); },
    get params() { return t('chat.command.usernameParams'); },
    kind: 'gui',
  },
  mute: {
    get desc() { return t('chat.command.mute.desc'); },
    get params() { return t('chat.command.usernameParams'); },
    kind: 'gui',
  },
  unmute: {
    get desc() { return t('chat.command.unmute.desc'); },
    get params() { return t('chat.command.usernameParams'); },
    kind: 'gui',
  },
  ban: {
    get desc() { return t('chat.command.ban.desc'); },
    get params() { return t('chat.command.usernameParams'); },
    kind: 'gui',
  },
  unban: {
    get desc() { return t('chat.command.unban.desc'); },
    get params() { return t('chat.command.usernameParams'); },
    kind: 'gui',
  },
  create: {
    get desc() { return t('chat.command.create.desc'); },
    get params() { return t('chat.command.create.params'); },
    kind: 'gui',
  },
  join: {
    get desc() { return t('chat.command.join.desc'); },
    get params() { return t('chat.command.join.params'); },
    kind: 'gui',
  },
  leave: {
    get desc() { return t('chat.command.leave.desc'); },
    kind: 'gui',
  },
  part: {
    get desc() { return t('chat.command.part.desc'); },
    kind: 'gui',
  },
  hide: {
    get desc() { return t('chat.command.hide.desc'); },
    kind: 'text',
  },
  archive: {
    get desc() { return t('chat.command.archive.desc'); },
    get params() { return t('chat.command.optionalChannelParams'); },
    kind: 'gui',
  },
  unarchive: {
    get desc() { return t('chat.command.unarchive.desc'); },
    get params() { return t('chat.command.optionalChannelParams'); },
    kind: 'gui',
  },
  topic: {
    get desc() { return t('chat.command.topic.desc'); },
    get params() { return t('chat.command.topic.params'); },
    kind: 'gui',
  },
  status: {
    get desc() { return t('chat.command.status.desc'); },
    get params() { return t('chat.command.status.params'); },
    kind: 'gui',
  },
  poll: {
    get desc() { return t('chat.command.poll.desc'); },
    get params() { return t('chat.command.poll.params'); },
    kind: 'gui',
  },
  kanban: {
    get desc() { return t('chat.command.kanban.desc'); },
    kind: 'gui',
  },
  oncall: {
    get desc() { return t('chat.command.oncall.desc'); },
    kind: 'gui',
  },
  help: {
    get desc() { return t('chat.command.help.desc'); },
    kind: 'gui',
  },

  // ---- 服务端提供，保持转发 ----
  // 注意：这里的键一律小写（clientCommandInfo 查找时会把命令名转小写）
  sendemailattachment: {
    get desc() { return t('chat.command.sendemailattachment.desc'); },
    get params() { return t('chat.command.sendemailattachment.params'); },
    kind: 'forward',
  },
  'slackbridge-import': {
    get desc() { return t('chat.command.slackbridgeImport.desc'); },
    kind: 'forward',
  },
};

/** 颜文字命令的改写素材：与 RC 服务端 slashcommands 的输出保持一致 */
const KAO_MOJI: Record<string, string> = {
  shrug: '¯\\_(ツ)_/¯',
  tableflip: '(╯°□°）╯︵ ┻━┻',
  unflip: '┬─┬ ノ( ゜-゜ノ)',
  lennyface: '( ͡° ͜ʖ ͡°)',
  gimme: '༼ つ ◕_◕ ༽つ',
};

export function clientCommandInfo(name: string): ClientCommandInfo | undefined {
  return COMMAND_INFO[name.toLowerCase()];
}

/** 注册表转 RcSlashCommand，供补全列表 / 帮助对话框合并展示 */
export function clientCommandList(): RcSlashCommand[] {
  return Object.entries(COMMAND_INFO)
    .map(([command, info]) => ({ command, description: info.desc, params: info.params }))
    .sort((a, b) => a.command.localeCompare(b.command));
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/** 提取 @用户名（兼容逗号/空格分隔、多个） */
export function parseUsernames(params: string): string[] {
  return [...params.matchAll(/@([\w.\-]+)/g)].map((m) => m[1]);
}

/** 提取 #频道名（去掉 # 前缀；也容忍直接打频道名） */
export function parseRoomName(params: string): string {
  return params
    .split(/\s+/)[0]
    ?.replace(/^#/, '')
    .trim() ?? '';
}

/** /create 的参数：频道名 + --private/-p 标记 */
export function parseCreateParams(params: string): { name: string; priv: boolean } {
  const priv = /(?:^|\s)(?:--private|-p)(?:\s|$)/i.test(params);
  const name = params
    .replace(/(?:^|\s)(?:--private|-p)(?:\s|$)/gi, ' ')
    .trim()
    .replace(/^#/, '');
  return { name, priv };
}

/** /msg：@用户名 + 可选首条消息 */
export function parseMsgParams(params: string): { username: string; draft: string } {
  const username = parseUsernames(params)[0] ?? '';
  const draft = params.replace(/@[\w.\-]+/, '').trim();
  return { username, draft };
}

/**
 * 把一次命令输入解析成客户端动作。这是 runSlash 的纯函数核心：
 * chat store 只负责执行动作（发送 / 打开对话框 / 转发），这里负责全部判断。
 */
export function resolveClientCommand(
  command: string,
  params: string,
  rid: string,
): ClientCommandAction | null {
  const info = clientCommandInfo(command);
  if (!info) return null;
  const name = command.toLowerCase();

  if (info.kind === 'forward') return { type: 'forward' };

  // 颜文字类：改写文本直接发送
  const kao = KAO_MOJI[name];
  if (kao) {
    const body = params.trim();
    const text = name === 'gimme' ? (body ? `${kao} ${body}` : kao) : body ? `${body} ${kao}` : kao;
    return { type: 'send', text };
  }

  switch (name) {
    case 'hide':
      // 没有参数、随时可恢复（再点开就行），不需要 GUI 确认
      return { type: 'hideConv', rid };
    case 'topic':
      return { type: 'open', dialog: { kind: 'topic', rid, prefill: params } };
    case 'status':
      return { type: 'open', dialog: { kind: 'status', prefill: params } };
    case 'poll':
      return { type: 'open', dialog: { kind: 'poll', rid, prefill: params } };
    case 'kanban':
      return { type: 'panel', panel: 'kanban' };
    case 'oncall':
      return { type: 'panel', panel: 'oncall' };
    case 'join':
      return { type: 'open', dialog: { kind: 'join', prefill: parseRoomName(params) } };
    case 'invite':
      return { type: 'open', dialog: { kind: 'invite', rid, prefill: params } };
    case 'kick':
    case 'mute':
    case 'unmute':
    case 'ban':
    case 'unban':
      return {
        type: 'open',
        dialog: {
          kind: 'member',
          rid,
          action: name as 'kick' | 'mute' | 'unmute' | 'ban' | 'unban',
          prefill: parseUsernames(params)[0] ?? '',
        },
      };
    case 'invite-all-to':
    case 'invite-all-from':
      return { type: 'open', dialog: { kind: 'roomPick', rid, mode: name as 'invite-all-to' | 'invite-all-from' } };
    case 'create': {
      const { name: channelName, priv } = parseCreateParams(params);
      return { type: 'open', dialog: { kind: 'create', prefill: channelName, priv } };
    }
    case 'msg': {
      const { username, draft } = parseMsgParams(params);
      return { type: 'open', dialog: { kind: 'dm', prefill: username, draft } };
    }
    case 'archive':
    case 'unarchive':
      return { type: 'open', dialog: { kind: 'archive', rid, archive: name === 'archive' } };
    case 'leave':
    case 'part':
      return { type: 'open', dialog: { kind: 'leave', rid } };
    case 'help':
      return { type: 'open', dialog: { kind: 'help' } };
    default:
      // 字典里有但没实现分支的，按服务端命令兜底
      return { type: 'forward' };
  }
}
