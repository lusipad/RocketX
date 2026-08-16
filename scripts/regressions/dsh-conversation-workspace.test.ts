import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('apps/web/src/components/DshConversation.tsx', 'utf8');

test('主管家 DSH 固定使用系统管家目录，不继承上一次 Codex 项目选择', () => {
  assert.match(source, /await workspace\.ensureDefaultWorkspace\(\);/);
  assert.match(source, /normalizeWorkspaceRoot\(latest\.butlerWorkspaceRoot\) \|\| normalizeWorkspaceRoot\(latest\.defaultWorkspaceRoot\)/);
  assert.doesNotMatch(source, /workspace\.workspaceRoot\.trim\(\)/);
  assert.doesNotMatch(source, /useCodexWorkspace\.subscribe/);
});
