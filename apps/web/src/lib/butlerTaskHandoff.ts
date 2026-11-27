import { t } from '../i18n';
import { useChat } from '../stores/chat';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';
import type { AiRuntimeProvider } from './runtimeMode';

export type ButlerTaskHandoffStatus = 'started' | 'drafted';

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
  };
}

export async function handoffToButlerTaskWith(
  text: string,
  title: string,
  deps: ButlerTaskHandoffDependencies,
  options: ButlerTaskHandoffOptions = {},
): Promise<ButlerTaskHandoffResult> {
  const prompt = text.trim();
  if (!prompt) throw new Error(t('butler.handoff.emptyPrompt'));
  const trimmedTitle = title.trim().slice(0, 80);
  const provider = deps.getProvider();
  if (provider === 'none') throw new Error(t('butler.handoff.aiDisabled'));

  if (options.preferRoomPanel && options.rid) {
    deps.draftHostedRoomPrompt(options.rid, prompt);
    deps.openRoomPanel(options.rid);
    return { provider, status: 'drafted' };
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
