import type { RcSlashCommand } from '@rcx/rc-client';
import { COMMAND_INFO, clientCommandInfo } from './clientCommands';

/**
 * 斜杠命令的解析。
 *
 * 命令的执行策略：客户端有实现的（纯文本改写 / 打开 GUI）直接客户端执行，
 * 没有的转发服务端（commands.run）。见 lib/clientCommands.ts。
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
 * 服务端返回的 description 是 i18n 键名（Slash_Shrug_Description），不能直接展示。
 * 说明文案统一在 lib/clientCommands.ts 的 COMMAND_INFO 里维护；服务端列表里出现
 * 词典没覆盖的命令时，先挡掉 i18n 键名，可读的英文描述原样兜底，其余标为服务器命令。
 */
const FALLBACK_DESC = '服务器提供的命令';

/** 看着像 i18n 键名吗（Slash_Shrug_Description / Remove_someone_from_room） */
function looksLikeI18nKey(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/.test(s);
}

export function commandDesc(cmd: RcSlashCommand): string {
  const info = clientCommandInfo(cmd.command);
  if (info) return info.desc;
  const raw = cmd.description ?? '';
  if (!raw || looksLikeI18nKey(raw)) return FALLBACK_DESC;
  return raw;
}

/** 命令的参数提示，同样要挡掉 i18n 键名（/status 和 /topic 的 params 也是键） */
export function commandParams(cmd: RcSlashCommand): string {
  const info = clientCommandInfo(cmd.command);
  if (info) return info.params ?? '';
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

/**
 * 按前缀筛命令，前缀完全匹配开头的排在前面。
 *
 * 不截断：以前砍到前 8 条，打一个 `/` 只能看到 27 个命令里的 8 个，剩下的既翻不到
 * 也不知道存在。要显示不下是面板该滚动的事，不是这里该把数据丢掉。
 */
export function filterCommands(commands: RcSlashCommand[], prefix: string): RcSlashCommand[] {
  const q = prefix.toLowerCase();
  if (!q) return [...commands].sort((a, b) => a.command.localeCompare(b.command));
  return commands
    .filter((c) => c.command.toLowerCase().includes(q))
    .sort((a, b) => {
      const as = a.command.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.command.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || a.command.localeCompare(b.command);
    });
}

/** 编辑距离（限制在±2 内使用），用于给打错的命令找最近似的建议 */
function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * 找打错的命令的最近似候选：前缀完全匹配优先，其次编辑距离 ≤2 里最短的那个。
 * 找不到返回 null——宁可不说，也别瞎猜一个坑用户。
 */
export function nearestCommand(name: string, commands: RcSlashCommand[]): string | null {
  const q = name.toLowerCase();
  if (!q) return null;
  const byPrefix = commands
    .map((c) => c.command.toLowerCase())
    .filter((c) => c !== q && c.startsWith(q))
    .sort((a, b) => a.length - b.length);
  if (byPrefix[0]) return byPrefix[0];
  let best: string | null = null;
  let bestScore = 3;
  for (const c of commands) {
    const lower = c.command.toLowerCase();
    if (lower === q) continue;
    const d = editDistance(q, lower);
    if (d < bestScore) {
      best = lower;
      bestScore = d;
    }
  }
  return best;
}

/** 兼容导出：词典表本体（供测试覆盖检查等使用） */
export { COMMAND_INFO };
