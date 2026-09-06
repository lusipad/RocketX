import { parseSlash } from '../lib/slash';
import type { RcSlashCommand } from '@rcx/rc-client';
import { clientCommandList } from '../lib/clientCommands';
import { kernelRegistry } from './registry';

export interface InputDispatcher {
  rid: string;
  runSlash: (command: string, params: string, tmid?: string) => Promise<void>;
  commands: readonly RcSlashCommand[];
}

/**
 * 已知命令的合并顺序：服务端 → 应用贡献 → 客户端注册表。
 * 后合并的覆盖同名前者：/poll 这类原生功能必须压过示例应用的同名命令，
 * 客户端有实现的命令也不能被服务端列表缺席拖累（缺席就拦会显得「命令无效」）。
 */
export function composerCommands(serverCommands: readonly RcSlashCommand[]): RcSlashCommand[] {
  const merged = new Map<string, RcSlashCommand>();
  for (const command of serverCommands) merged.set(command.command.toLowerCase(), command);
  for (const command of kernelRegistry.get('composer.command')) {
    merged.set(command.name.toLowerCase(), {
      command: command.name,
      description: command.description,
      params: command.params,
    });
  }
  for (const command of clientCommandList()) {
    merged.set(command.command.toLowerCase(), command);
  }
  return [...merged.values()];
}

export async function dispatchInput(
  text: string,
  dispatcher: InputDispatcher,
  tmid?: string,
): Promise<{ handled: boolean; accepted?: boolean; command?: string }> {
  const trigger = kernelRegistry
    .get('composer.trigger')
    .find((candidate) => text === candidate.prefix || text.startsWith(`${candidate.prefix} `));
  if (trigger) {
    const handled = await trigger.run({ rid: dispatcher.rid, text, ...(tmid ? { tmid } : {}) });
    if (handled === false) return { handled: false };
    return { handled: true, accepted: true };
  }
  const slash = parseSlash(text);
  if (!slash) return { handled: false };
  const accepted = dispatcher.commands.some(
    (command) => command.command.toLowerCase() === slash.command,
  );
  await dispatcher.runSlash(slash.command, slash.params, tmid);
  return { handled: true, accepted, command: slash.command };
}
