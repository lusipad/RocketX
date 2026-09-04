import type { RcMessage } from '@rcx/rc-client';

export function isPollMessage(message: Pick<RcMessage, 'blocks'>): boolean {
  return (message.blocks ?? []).some(
    (block) =>
      block.type === 'section'
      && block.accessory?.type === 'button'
      && block.accessory.actionId === 'vote',
  );
}
