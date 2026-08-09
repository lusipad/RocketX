import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('任务输入不再做本地命令拆解，统一交给 codexWorkspace 驱动的原生任务流', () => {
  assert.equal(existsSync('apps/web/src/lib/assistantCommand.ts'), false);

  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  assert.doesNotMatch(conversation, /AssistantCommand|assistantCommand|fallbackAssistantCommand|isAssistantWorkCommand/);
  assert.match(conversation, /const submit = async \(text = input, modeOverride\?: CodexFollowUpMode\): Promise<void> => \{/);
  assert.match(conversation, /await send\(value, outgoingImages, modeOverride\)/);
  assert.match(conversation, /if \(event\.key !== 'Enter' \|\| event\.nativeEvent\.isComposing\) return;/);
  assert.match(conversation, /const opposite = followUpMode === 'steer' \? 'queue' : 'steer';/);
  assert.match(conversation, /void submit\(\);/);
  assert.match(conversation, /suggestions\.map\(\(suggestion\) => \(/);
  assert.match(conversation, /onClick=\{\(\) => void submit\(suggestion\)\}/);
});
