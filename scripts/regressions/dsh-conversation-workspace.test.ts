import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('apps/web/src/components/DshConversation.tsx', 'utf8');

test('主管家 DSH 使用系统管家目录，私人房间入口使用 projectless 目录', () => {
  assert.match(source, /await workspace\.ensureDefaultWorkspace\(\);/);
  assert.match(source, /const personalConversationRequested = selectedPersonalDshFocusNonce > 0;/);
  assert.match(source, /personalConversationRequested[\s\S]*\? defaultWorkspaceRoot \|\| butlerWorkspaceRoot[\s\S]*: butlerWorkspaceRoot \|\| defaultWorkspaceRoot/);
  assert.doesNotMatch(source, /workspace\.workspaceRoot\.trim\(\)/);
  assert.doesNotMatch(source, /useCodexWorkspace\.subscribe/);
});
