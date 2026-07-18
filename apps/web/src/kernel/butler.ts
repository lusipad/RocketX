import type { ComposerCommandContext } from './types';
import { useButler } from '../stores/butler';
import { useChat } from '../stores/chat';

export function runButlerCommand({ rid, params }: ComposerCommandContext): void {
  const chat = useChat.getState();
  const roomName =
    chat.subscriptions[rid]?.fname ||
    chat.subscriptions[rid]?.name ||
    chat.rooms[rid]?.fname ||
    chat.rooms[rid]?.name ||
    rid;
  chat.setPanel({ kind: 'butler' });
  const question = params.trim();
  if (question) void useButler.getState().ask(question, { rid, roomName });
}
