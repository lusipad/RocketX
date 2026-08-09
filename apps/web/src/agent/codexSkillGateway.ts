import type { AiChatGateway, AiChatRequest } from './structuredOutput';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { runCodexAutomation } from './codexAutomation';

function renderRequest(skillName: string, request: AiChatRequest): string {
  const messages = request.messages.map((message) => (
    `${message.role.toUpperCase()}:\n${message.content}`
  )).join('\n\n');
  return `$${skillName}\n\n${messages}`;
}

/** 将需要同步返回结果的标准化行为交给一个真实 Codex Skill。 */
export function codexSkillGateway(skillName: string, taskName: string): AiChatGateway {
  return {
    async *chat(_capability, request) {
      const state = useCodexWorkspace.getState();
      const result = await runCodexAutomation({
        workspaceRoot: state.workspaceRoot,
        text: renderRequest(skillName, request),
        name: taskName,
        model: state.selectedModel || undefined,
        effort: state.selectedEffort,
        skillName,
      });
      yield { content: result.text, finishReason: 'stop' };
    },
  };
}
