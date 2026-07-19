import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BUTLER_DRAFT_SYSTEM_PROMPT,
  runButlerDraft,
} from '../../apps/web/src/kernel/ai/features/butler-draft';
import type { AiChatGateway } from '../../apps/web/src/kernel/ai/features/structured-output';
import type { AiCapability, AiChatRequest } from '../../apps/web/src/kernel/ai/provider';
import {
  runDraftWithBrain,
  setButlerRoundsCodexRunner,
} from '../../apps/web/src/lib/butlerRoundsBrain';
import {
  setButlerBrain,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  type ButlerBrainStorage,
} from '../../apps/web/src/lib/butlerBrain';

class MemoryStorage implements ButlerBrainStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function gateway(
  content: string,
  inspect?: (capability: AiCapability, request: AiChatRequest) => void,
): AiChatGateway {
  return {
    async *chat(capability, request) {
      inspect?.(capability, request);
      yield { content, finishReason: 'stop' };
    },
  };
}

test('拟稿使用 rounds 能力并严格解析单行 JSON 草稿', async () => {
  let capability: AiCapability | undefined;
  let request: AiChatRequest | undefined;
  const result = await runButlerDraft({
    subject: '确认发布窗口',
    who: 'Alice',
    context: '想礼貌问一下今天能否确认',
  }, gateway('{"draft":"Alice，方便的话今天帮我确认一下发布窗口，可以吗？"}', (nextCapability, nextRequest) => {
    capability = nextCapability;
    request = nextRequest;
  }));

  assert.deepEqual(result, { draft: 'Alice，方便的话今天帮我确认一下发布窗口，可以吗？' });
  assert.equal(capability, 'butler-rounds');
  assert.equal(request?.responseFormat, 'json');
  assert.equal(request?.thinking, 'disabled');
  assert.match(BUTLER_DRAFT_SYSTEM_PROMPT, /用用户的口吻拟一句简短、不带火气的中文消息,一句话,不解释/);
  assert.deepEqual(JSON.parse(request?.messages[1].content ?? ''), {
    subject: '确认发布窗口',
    who: 'Alice',
    context: '想礼貌问一下今天能否确认',
  });
});

test('拟稿拒绝空值、多行、超长和多余字段', async () => {
  await assert.rejects(
    () => runButlerDraft({ subject: '提醒' }, gateway('{"draft":"  "}')),
    /draft不能为空/,
  );
  await assert.rejects(
    () => runButlerDraft({ subject: '提醒' }, gateway('{"draft":"第一行\\n第二行"}')),
    /单行文本/,
  );
  await assert.rejects(
    () => runButlerDraft({ subject: '提醒' }, gateway(JSON.stringify({ draft: '好'.repeat(161) }))),
    /不能超过 160 个字符/,
  );
  await assert.rejects(
    () => runButlerDraft({ subject: '提醒' }, gateway('{"draft":"请确认一下。","explanation":"额外解释"}')),
    /只包含 draft/,
  );
});

test('Codex 大脑剥除 JSON 围栏后仍走同一拟稿契约', async () => {
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restoreTauri = setButlerBrainTauriProvider(() => true);
  const restoreRunner = setButlerRoundsCodexRunner(async () => ({
    text: '```json\n{"draft":"我晚一点把结论整理好发你。"}\n```',
  }));
  try {
    setButlerBrain('codex');
    assert.deepEqual(
      await runDraftWithBrain({ subject: '回复结论', who: '小王' }),
      { draft: '我晚一点把结论整理好发你。' },
    );
  } finally {
    restoreRunner();
    restoreTauri();
    restoreStorage();
  }
});

test('拟稿契约、路由和页面不触达消息发送链路', async () => {
  const sources = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/ai/features/butler-draft.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/lib/butlerRoundsBrain.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/ButlerPage.tsx', import.meta.url), 'utf8'),
  ]);
  const source = sources.join('\n');
  assert.doesNotMatch(source, /\.send\s*\(|\brest\.send\b|\brealtime\b|\bsendMessage\b|\bsend_message\b/u);
});
