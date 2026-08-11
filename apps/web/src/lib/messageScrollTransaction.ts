export type MessageScrollEntry = 'latest' | 'locate';

export interface MessageScrollTransaction {
  generation: number;
  rid: string;
  entry: MessageScrollEntry;
  messageId?: string;
}

export function nextMessageScrollTransaction(
  generation: number,
  rid: string,
  entry: MessageScrollEntry,
  messageId?: string,
): MessageScrollTransaction {
  return {
    generation: generation + 1,
    rid,
    entry,
    ...(entry === 'locate' && messageId ? { messageId } : {}),
  };
}

export function messageScrollTransactionMatches(
  transaction: MessageScrollTransaction | null,
  generation: number,
  rid: string,
  entry?: MessageScrollEntry,
  messageId?: string,
): boolean {
  return transaction?.generation === generation &&
    transaction.rid === rid &&
    (entry === undefined || transaction.entry === entry) &&
    (messageId === undefined || transaction.messageId === messageId);
}

export type MessageScrollCommand = 'anchor' | 'locate' | 'latest' | 'follow' | 'none';

export function messageScrollCommand({
  anchorSettled,
  entry,
  openPending,
  stickToBottom,
}: {
  anchorSettled: boolean;
  entry: MessageScrollEntry;
  openPending: boolean;
  stickToBottom: boolean;
}): MessageScrollCommand {
  if (anchorSettled) return 'anchor';
  if (openPending && entry === 'locate') return 'locate';
  if (openPending) return 'latest';
  return stickToBottom ? 'follow' : 'none';
}
