import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('三个管家输入框都用 Codex skills/list 提供 $skill 候选', () => {
  const menu = readFileSync('apps/web/src/components/ButlerSkillMenu.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const panel = readFileSync('apps/web/src/components/ButlerPanel.tsx', 'utf8');

  assert.match(menu, /listButlerCodexSkills/);
  assert.match(menu, /butlerSkillQuery/);
  assert.match(menu, /filterButlerSkillOptions/);
  assert.match(menu, /aria-label="可用 Skills"/);
  assert.match(menu, /`\$\$\{skill\.name\} `/);

  for (const source of [conversation, page, panel]) {
    assert.match(source, /<ButlerSkillMenu/);
    assert.match(source, /skillMenu\.handleKeyDown/);
    assert.match(source, /skillMenu\.reopen\(\)/);
    assert.match(source, /skillMenu\.dismiss\(\)/);
  }
});
