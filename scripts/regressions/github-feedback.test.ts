import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('收起分组栏时禁止产生水平滚动条（issue #114）', () => {
  const source = readFileSync('apps/web/src/components/GroupFilter.tsx', 'utf8');
  assert.match(source, /collapsed \? 'w-12 min-h-0 overflow-x-hidden p-2'/);
  assert.match(source, /flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto/);
});

test('Azure DevOps 卡片可随聊天栏收窄且内部内容允许压缩（issue #116）', () => {
  const workItem = readFileSync('apps/web/src/components/WorkItemLink.tsx', 'utf8');
  const entities = readFileSync('apps/web/src/components/AdoEntityLink.tsx', 'utf8');

  assert.match(workItem, /inline-block min-w-0 w-full max-w-sm/);
  assert.match(workItem, /className="min-w-0 truncate">\{info\.project\}<\/span>/);
  assert.match(workItem, /break-words/);
  assert.match(entities, /inline-block min-w-0 w-full max-w-lg/);
  assert.match(entities, /inline-block min-w-0 w-full max-w-sm/);
  assert.match(entities, /min-w-0 flex-1 truncate/);
});
