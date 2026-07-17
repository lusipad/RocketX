import { parseSlash } from '../lib/slash';
import type { RcSlashCommand } from '@rcx/rc-client';
import { kernelRegistry } from './registry';

export interface InputDispatcher {
  rid: string;
  runSlash: (command: string, params: string, tmid?: string) => Promise<void>;
  commands: readonly RcSlashCommand[];
}

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
    await trigger.run({ rid: dispatcher.rid, text, ...(tmid ? { tmid } : {}) });
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
