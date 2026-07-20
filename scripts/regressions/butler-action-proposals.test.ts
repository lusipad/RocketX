import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createButlerActionDraft,
  butlerActionAuditEntry,
} from '../../apps/web/src/lib/butlerActions';

const line = {
  id: 'a1',
  role: 'assistant' as const,
  text: '**结论**\n发布构建失败，需要回滚。',
  sources: [{ kind: 'message' as const, id: 'm1', mid: 'm1', rid: 'r1', label: '发布群：构建失败' }],
};

test('统一动作草案从回答与来源生成，创建前不执行副作用', () => {
  const reply = createButlerActionDraft('reply', line, null, () => 'draft-1');
  const todo = createButlerActionDraft('todo', line, null, () => 'draft-2');
  const commitment = createButlerActionDraft('commitment', line, null, () => 'draft-3');

  assert.deepEqual(
    { kind: reply.kind, rid: reply.rid, text: reply.text },
    { kind: 'reply', rid: 'r1', text: '**结论**\n发布构建失败，需要回滚。' },
  );
  assert.equal(todo.title, '结论');
  assert.equal(todo.status, 'pending');
  assert.equal(commitment.committedTo, '');
});

test('Butler 动作审计条目不记录正文，只记录动作和结果', () => {
  const entry = butlerActionAuditEntry('reply', 'executed', { id: 'draft-1', rid: 'r1', text: '秘密正文' }, 123);
  assert.deepEqual(
    { appId: entry.appId, action: entry.action, allowed: entry.allowed, timestamp: entry.timestamp },
    { appId: 'builtin:butler', action: 'butler.action.reply.executed', allowed: true, timestamp: 123 },
  );
  assert.equal(JSON.stringify(entry).includes('秘密正文'), false);
});

test('回复动作只落编辑框草稿，统一动作卡不接入消息发送路径', () => {
  const source = readFileSync('apps/web/src/components/ButlerActions.tsx', 'utf8');
  assert.match(source, /useChat\.getState\(\)\.setDraft/);
  assert.doesNotMatch(source, /useChat\.getState\(\)\.send\s*\(/);
  assert.doesNotMatch(source, /rest\.sendMessage/);
  assert.match(source, /等待确认/);
  assert.match(source, /auditButlerAction/);
});
