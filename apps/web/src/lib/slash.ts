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
