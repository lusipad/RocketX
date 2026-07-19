import {
  runButlerRounds,
  type RoundsInput,
  type RoundsResult,
} from '../kernel/ai/features/butler-rounds';
import type { AiChatGateway } from '../kernel/ai/features/structured-output';
import { getAiBus } from '../kernel/ai/runtime';
import { runButlerCodexEphemeral } from '../stores/butlerCodex';
import { codexBrainAvailability, getButlerBrain } from './butlerBrain';

type ButlerRoundsCodexRunner = typeof runButlerCodexEphemeral;

let codexRunner: ButlerRoundsCodexRunner = runButlerCodexEphemeral;

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function codexEphemeralGateway(): AiChatGateway {
  return {
    async *chat(_capability, request) {
      const text = request.messages
        .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
        .join('\n\n');
      const result = await codexRunner({ text });
      yield { content: stripJsonFence(result.text), finishReason: 'stop' };
    },
  };
}

export async function runRoundsWithBrain(input: RoundsInput): Promise<RoundsResult> {
  if (getButlerBrain() === 'codex') {
    const availability = codexBrainAvailability();
    if (!availability.available) {
      throw new Error(`${availability.reason ?? 'Codex 大脑暂不可用'}，可在设置中切换为 API 大脑`);
    }
    return runButlerRounds(input, codexEphemeralGateway());
  }
  return runButlerRounds(input, getAiBus());
}

export function setButlerRoundsCodexRunner(runner: ButlerRoundsCodexRunner): () => void {
  const previous = codexRunner;
  codexRunner = runner;
  return () => {
    codexRunner = previous;
  };
}
