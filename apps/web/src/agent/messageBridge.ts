import type { RcMessage } from '@rcx/rc-client';

export function agentMessageBridgeChanges(
  messages: RcMessage[],
  previous: RcMessage[],
  historyJustLoaded: boolean,
): { ingestOnly: RcMessage[]; handle: RcMessage[] } {
  if (historyJustLoaded) return { ingestOnly: messages, handle: [] };

  const previousById = new Map(previous.map((message) => [message._id, message]));
  const handle = messages.filter((message) => {
    const prior = previousById.get(message._id);
    return !prior || prior.msg !== message.msg || (prior.pending && !message.pending);
  });
  return { ingestOnly: [], handle };
}
