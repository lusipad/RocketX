import { useChat } from '../stores/chat';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import type { AiRuntimeProvider } from './runtimeMode';

export type ButlerTaskHandoffStatus = 'started' | 'drafted' | 'copied';

export interface ButlerTaskHandoffResult {
  provider: Exclude<AiRuntimeProvider, 'none'>;
  status: ButlerTaskHandoffStatus;
}

export interface ButlerTaskHandoffOptions {
  rid?: string;
  preferRoomPanel?: boolean;
}

interface CodexWorkspaceHandoff {
  workspaceRoot: string;
  status: string;
  connect: () => Promise<unknown>;
  startTask: (text: string, title: string) => Promise<unknown>;
  setComposerDraft: (text: string) => void;
}

export interface ButlerTaskHandoffDependencies {
  getProvider: () => AiRuntimeProvider;
  openConversation: () => void;
  openRoomPanel: (rid: string) => void;
  getCodexWorkspace: () => CodexWorkspaceHandoff;
  draftHostedRoomPrompt: (rid: string, prompt: string) => void;
  copyDeepSeekPrompt: (prompt: string) => Promise<void>;
  notifyDeepSeekPaste: () => void;
}

export function defaultButlerTaskHandoffDependencies(): ButlerTaskHandoffDependencies {
  return {
    getProvider: () => useUI.getState().aiRuntimeProvider,
    openConversation: () => useUI.getState().openButlerConversation(),
    openRoomPanel: () => useChat.getState().setPanel({ kind: 'butler' }),
    getCodexWorkspace: () => useCodexWorkspace.getState(),
    draftHostedRoomPrompt: (rid, prompt) => {
      const chat = useChat.getState();
      const command = `@ai ${prompt}`;
      const current = chat.drafts[rid]?.trim();
      chat.setDraft(rid, current ? `${current}\n${command}` : command);
    },
    copyDeepSeekPrompt: async (prompt) => {
      if (!navigator.clipboard?.writeText) throw new Error('系统剪贴板不可用，无法把任务交给 DSH');
      await navigator.clipboard.writeText(prompt);
    },
    notifyDeepSeekPaste: () => toast.success('任务已复制，请在 DSH 中粘贴发送'),
  };
}

export async function handoffToButlerTaskWith(
  text: string,
  title: string,
  deps: ButlerTaskHandoffDependencies,
  options: ButlerTaskHandoffOptions = {},
): Promise<ButlerTaskHandoffResult> {
  const prompt = text.trim();
  if (!prompt) throw new Error('任务内容不能为空');
  const trimmedTitle = title.trim().slice(0, 80);
  const provider = deps.getProvider();
  if (provider === 'none') throw new Error('当前未启用 AI，请先在设置中选择 Codex 或 DSH 并重启 RocketX');

  if (options.preferRoomPanel && options.rid) {
    deps.draftHostedRoomPrompt(options.rid, prompt);
    deps.openRoomPanel(options.rid);
    return { provider, status: 'drafted' };
  }

  if (provider === 'deepseek') {
    await deps.copyDeepSeekPrompt(prompt);
    deps.openConversation();
    deps.notifyDeepSeekPaste();
    return { provider, status: 'copied' };
  }

  deps.openConversation();
  const workspace = deps.getCodexWorkspace();
  if (!workspace.workspaceRoot) {
    workspace.setComposerDraft(prompt);
    return { provider, status: 'drafted' };
  }

  try {
    if (workspace.status === 'idle' || workspace.status === 'unavailable') {
      await workspace.connect();
    }
    await workspace.startTask(prompt, trimmedTitle);
    return { provider, status: 'started' };
  } catch (error) {
    workspace.setComposerDraft(prompt);
    throw error;
  }
}

export async function handoffToButlerTask(
  text: string,
  title: string,
  options: ButlerTaskHandoffOptions = {},
): Promise<ButlerTaskHandoffResult> {
  return handoffToButlerTaskWith(
    text,
    title,
    defaultButlerTaskHandoffDependencies(),
    options,
  );
}
