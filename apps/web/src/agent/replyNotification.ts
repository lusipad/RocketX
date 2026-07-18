import { agentInstruction } from './context';

const EXPECTED_REPLY_TTL_MS = 10 * 60 * 1_000;
const AGENT_REPLY_RE = /^\s*🤖\s*Codex(?:\s|（|:|：|$)/i;

interface PendingReply {
  count: number;
  expiresAt: number;
}

export function createAgentReplyNotificationTracker() {
  const pending = new Map<string, PendingReply>();

  return {
    expect(rid: string, text: string, now = Date.now()): boolean {
      if (agentInstruction(text) === null) return false;
      const current = pending.get(rid);
      pending.set(rid, {
        count: current && current.expiresAt >= now ? current.count + 1 : 1,
        expiresAt: now + EXPECTED_REPLY_TTL_MS,
      });
      return true;
    },

    cancel(rid: string): void {
      const current = pending.get(rid);
      if (!current || current.count <= 1) pending.delete(rid);
      else pending.set(rid, { ...current, count: current.count - 1 });
    },

    consume(rid: string, text: string, now = Date.now()): boolean {
      const current = pending.get(rid);
      if (!current) return false;
      if (current.expiresAt < now) {
        pending.delete(rid);
        return false;
      }
      if (!AGENT_REPLY_RE.test(text)) return false;
      if (current.count <= 1) pending.delete(rid);
      else pending.set(rid, { ...current, count: current.count - 1 });
      return true;
    },
  };
}

export const agentReplyNotificationTracker = createAgentReplyNotificationTracker();
