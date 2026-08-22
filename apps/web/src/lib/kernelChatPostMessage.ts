import { useChat } from '../stores/chat';
import type { KernelChatPostPort } from '../kernel/postMessage';

export function createDefaultKernelChatPostPort(): KernelChatPostPort {
  return {
    isMember: (rid) => !!useChat.getState().subscriptions[rid],
    send: async (rid, text, tmid) => {
      await useChat.getState().send(text, { rid, ...(tmid ? { tmid } : {}) });
    },
  };
}
