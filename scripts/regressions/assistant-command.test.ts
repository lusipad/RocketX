import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('AI 助手不做本地正则拆解，所有输入交给 AI 大脑（issue #89）', () => {
  // 正则命令解析模块已整体删除，不能再被加回来
  assert.equal(existsSync('apps/web/src/lib/assistantCommand.ts'), false);

  const page = readFileSync('apps/web/src/pages/AiAssistantPage.tsx', 'utf8');
  assert.doesNotMatch(page, /isAssistantWorkCommand|fallbackAssistantCommand|AssistantCommand/);
  assert.match(page, /await askButler\(value\)/);
  // 快捷提示也走同一条 AI 路径
  assert.match(page, /QUICK_PROMPTS\.map\(\(prompt\) => <button key=\{prompt\} onClick=\{\(\) => void submit\(prompt\)\}/);
});
