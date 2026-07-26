import {
  runButlerRounds,
  type RoundsInput,
  type RoundsResult,
} from '../kernel/ai/features/butler-rounds';
import {
  runButlerDraft,
  type ButlerDraftInput,
  type ButlerDraftResult,
} from '../kernel/ai/features/butler-draft';
import type { AiChatGateway } from '../kernel/ai/features/structured-output';
import { runButlerCodexEphemeral } from '../stores/butlerCodex';
import { codexBrainAvailability } from './butlerBrain';

type ButlerRoundsCodexRunner = typeof runButlerCodexEphemeral;

let codexRunner: ButlerRoundsCodexRunner = runButlerCodexEphemeral;

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function codexEphemeralGateway(signal?: AbortSignal): AiChatGateway {
  return {
    async *chat(_capability, request) {
      const text = request.messages
        .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
        .join('\n\n');
      const result = await codexRunner({ text, signal });
      yield { content: stripJsonFence(result.text), finishReason: 'stop' };
    },
  };
}

/**
 * 需要 AI 想一下的功能都从这里取通道，别各自去接 AiBus。
 *
 * 决策 13 之后 Codex 是唯一的大脑，管家层只管时机、呈现和闸门。
 * 内置那个 provider 从来没有密钥，走 AiBus 的功能会闷头发出请求、
 * 拿回 401，再被 toast 改写成「没有权限执行此操作」——用户完全被
 * 指向错误方向（issue #229）。从这里取通道就没有这一路。
 */
export function butlerBrainGateway(signal?: AbortSignal): AiChatGateway {
  const availability = codexBrainAvailability();
  if (!availability.available) {
    throw new Error(availability.reason ?? 'Codex 暂不可用');
  }
  return codexEphemeralGateway(signal);
}

export async function runRoundsWithBrain(
  input: RoundsInput,
  signal?: AbortSignal,
): Promise<RoundsResult> {
  return runButlerRounds(input, butlerBrainGateway(signal));
}

export async function runDraftWithBrain(input: ButlerDraftInput): Promise<ButlerDraftResult> {
  return runButlerDraft(input, butlerBrainGateway());
}

export function setButlerRoundsCodexRunner(runner: ButlerRoundsCodexRunner): () => void {
  const previous = codexRunner;
  codexRunner = runner;
  return () => {
    codexRunner = previous;
  };
}
