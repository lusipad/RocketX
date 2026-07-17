import { tsMs, type RcMessage } from '@rcx/rc-client';

export interface MentionRoom {
  rid: string;
  name: string;
  userMentions: number;
}

export interface MentionItem {
  message: RcMessage;
  roomName: string;
}

export interface MentionPage {
  messages: RcMessage[];
  count: number;
  offset: number;
  total: number;
}

export interface MentionInboxResult {
  items: MentionItem[];
  warnings: string[];
}

function directlyMentions(message: RcMessage, userId: string, username: string): boolean {
  return !!message.mentions?.some(
    (mention) =>
      mention.type !== 'team' &&
      (mention._id === userId || mention.username.toLowerCase() === username.toLowerCase()),
  );
}

export async function collectMentionInbox(
  rooms: MentionRoom[],
  user: { _id: string; username: string },
  fetchPage: (rid: string, offset: number, count: number) => Promise<MentionPage>,
  pageSize = 50,
): Promise<MentionInboxResult> {
  const warnings: string[] = [];
  const byId = new Map<string, MentionItem>();
  const candidates = rooms.filter((room) => room.userMentions > 0);

  await Promise.all(
    candidates.map(async (room) => {
      try {
        for (let offset = 0; ; offset += pageSize) {
          const page = await fetchPage(room.rid, offset, pageSize);
          for (const message of page.messages) {
            if (directlyMentions(message, user._id, user.username)) {
              byId.set(message._id, { message, roomName: room.name });
            }
          }
          if (offset + page.messages.length >= page.total || page.messages.length < pageSize) break;
        }
      } catch (error) {
        warnings.push(`${room.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  return {
    items: [...byId.values()].sort((left, right) => tsMs(right.message.ts) - tsMs(left.message.ts)),
    warnings,
  };
}
