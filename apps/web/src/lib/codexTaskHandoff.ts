import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';

export type CodexTaskHandoffResult = 'started' | 'drafted';

/**
 * 所有业务入口只把上下文交给同一个 Codex 任务面，不再启动平行的管家会话。
 */
export async function handoffToCodexTask(
  text: string,
  title: string,
): Promise<CodexTaskHandoffResult> {
  const prompt = text.trim();
  if (!prompt) throw new Error('任务内容不能为空');
  if (useUI.getState().aiRuntimeProvider !== 'codex') {
    throw new Error('当前 AI 运行时不是 Codex');
  }
  useUI.getState().openButlerConversation();

  const workspace = useCodexWorkspace.getState();
  if (!workspace.workspaceRoot) {
    workspace.setComposerDraft(prompt);
    return 'drafted';
  }

  try {
    if (workspace.status === 'idle' || workspace.status === 'unavailable') {
      await workspace.connect();
    }
    await useCodexWorkspace.getState().startTask(prompt, title.trim().slice(0, 80));
    return 'started';
  } catch (error) {
    useCodexWorkspace.getState().setComposerDraft(prompt);
    throw error;
  }
}
