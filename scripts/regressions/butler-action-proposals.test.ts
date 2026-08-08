import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  butlerActionMessageId,
  createButlerAdoStateActionDraft,
  createButlerActionCheckpoint,
  createButlerActionDraft,
  butlerActionAuditEntry,
  normalizeButlerActionDraft,
} from '../../apps/web/src/lib/butlerActions';

const line = {
  id: 'a1',
  role: 'assistant' as const,
  text: '**结论**\n发布构建失败，需要回滚。',
  sources: [{ kind: 'message' as const, id: 'm1', mid: 'm1', rid: 'r1', label: '发布群：构建失败' }],
};

test('统一动作草案从回答与来源生成，创建前不执行副作用', () => {
  const reply = createButlerActionDraft('reply', line, null, () => 'draft-1');
  const send = createButlerActionDraft('send', line, null, () => 'draft-2');
  const todo = createButlerActionDraft('todo', line, null, () => 'draft-3');
  const commitment = createButlerActionDraft('commitment', line, null, () => 'draft-4');

  assert.deepEqual(
    { kind: reply.kind, rid: reply.rid, text: reply.text },
    { kind: 'reply', rid: 'r1', text: '**结论**\n发布构建失败，需要回滚。' },
  );
  assert.equal(send.kind, 'send');
  assert.equal(send.rid, 'r1');
  assert.equal(send.messageId, butlerActionMessageId('draft-2'));
  assert.match(send.messageId ?? '', /^[23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz]{17}$/);
  assert.equal(todo.title, '结论');
  assert.equal(todo.status, 'pending');
  assert.equal(commitment.committedTo, '');
});

test('发送动作 checkpoint 持久化稳定消息 ID 与写能力', () => {
  const send = createButlerActionDraft('send', line, null, () => 'draft-send');
  const checkpoint = createButlerActionCheckpoint(send, 456);

  assert.deepEqual(
    {
      toolName: checkpoint.toolName,
      effect: checkpoint.effect,
      capability: checkpoint.capability,
      preview: checkpoint.preview,
      messageId: checkpoint.params.messageId,
    },
    {
      toolName: 'action.send',
      effect: 'write',
      capability: 'chat.messages.write',
      preview: '发送回复到原会话：**结论**\n发布构建失败，需要回滚。',
      messageId: send.messageId,
    },
  );
});

test('ADO 状态动作冻结 revision 与非秘密连接身份，并标记为受控写', () => {
  const draft = createButlerAdoStateActionDraft({
    workItemId: 123,
    workItemTitle: '修复发布失败',
    currentState: 'Active',
    targetState: 'Resolved',
    expectedRevision: 7,
    adoIdentityId: '  00000000-0000-0000-0000-000000000123  ',
    webUrl: 'http://ado/DefaultCollection/Shop/_workitems/edit/123',
    project: 'Shop',
    adoBase: 'http://ado/DefaultCollection',
    adoAuth: 'ntlm',
    adoAccount: 'CORP\\lus',
  }, () => 'draft-ado-state');
  const checkpoint = createButlerActionCheckpoint(draft, 456);

  assert.deepEqual(
    {
      kind: draft.kind,
      workItemId: draft.workItemId,
      currentState: draft.currentState,
      targetState: draft.targetState,
      expectedRevision: draft.expectedRevision,
      adoIdentityId: draft.adoIdentityId,
      adoBase: draft.adoBase,
      adoAuth: draft.adoAuth,
      adoAccount: draft.adoAccount,
      source: draft.sources[0],
      toolName: checkpoint.toolName,
      effect: checkpoint.effect,
      capability: checkpoint.capability,
      preview: checkpoint.preview,
    },
    {
      kind: 'ado-state',
      workItemId: 123,
      currentState: 'Active',
      targetState: 'Resolved',
      expectedRevision: 7,
      adoIdentityId: '00000000-0000-0000-0000-000000000123',
      adoBase: 'http://ado/DefaultCollection',
      adoAuth: 'ntlm',
      adoAccount: 'CORP\\lus',
      source: {
        kind: 'work-item',
        id: '123',
        label: '#123 修复发布失败',
        project: 'Shop',
        webUrl: 'http://ado/DefaultCollection/Shop/_workitems/edit/123',
      },
      toolName: 'action.ado-state',
      effect: 'write',
      capability: 'ado.work-items.state.write',
      preview: '修改 ADO 工作项 #123「修复发布失败」：Active → Resolved',
    },
  );
  assert.equal(checkpoint.params.adoIdentityId, '00000000-0000-0000-0000-000000000123');
  assert.equal(JSON.stringify(checkpoint.params).includes('pat'), false, 'checkpoint 不得保存 PAT');
  assert.deepEqual(normalizeButlerActionDraft(JSON.parse(JSON.stringify(draft))), draft);
  assert.equal(normalizeButlerActionDraft({ ...draft, expectedRevision: 0 }), null);
  assert.equal(normalizeButlerActionDraft({ ...draft, adoIdentityId: undefined }), null);
});

test('Butler 动作审计条目不记录正文，只记录动作和结果', () => {
  const entry = butlerActionAuditEntry('reply', 'executed', { id: 'draft-1', rid: 'r1', text: '秘密正文' }, 123);
  assert.deepEqual(
    { appId: entry.appId, action: entry.action, allowed: entry.allowed, timestamp: entry.timestamp },
    { appId: 'builtin:butler', action: 'butler.action.reply.executed', allowed: true, timestamp: 123 },
  );
  assert.equal(JSON.stringify(entry).includes('秘密正文'), false);
});

test('回复动作只落编辑框草稿，不接入发送路径', () => {
  const source = readFileSync('apps/web/src/components/ButlerActions.tsx', 'utf8');
  const replyBranch = source.slice(
    source.indexOf("if (draft.kind === 'reply')"),
    source.indexOf("if (draft.kind === 'send')"),
  );
  assert.match(replyBranch, /useChat\.getState\(\)\.setDraft/);
  assert.doesNotMatch(replyBranch, /useChat\.getState\(\)\.send\s*\(/);
  assert.doesNotMatch(replyBranch, /rest\.sendMessage/);
  assert.match(source, /等待确认/);
  assert.match(source, /await begin\(\)/, '副作用前必须先进入统一 checkpoint 执行态');
});

test('回复草稿写入后立即完成 checkpoint，导航失败不反写为执行失败', () => {
  const source = readFileSync('apps/web/src/components/ButlerActions.tsx', 'utf8');
  const replyBranch = source.slice(
    source.indexOf("if (draft.kind === 'reply')"),
    source.indexOf("if (draft.kind === 'todo')"),
  );
  const writeIndex = replyBranch.indexOf('setDraft(');
  const completeIndex = replyBranch.indexOf('await done(');
  const navigationIndex = replyBranch.indexOf('openRoom(');

  assert.ok(writeIndex >= 0 && completeIndex > writeIndex, '草稿写入后必须完成 checkpoint');
  assert.ok(navigationIndex > completeIndex, '非关键导航必须发生在 checkpoint 完成之后');
  assert.match(replyBranch, /openRoom[\s\S]*catch\s*\(/, '导航失败必须被单独降级处理');
});

test('发送回复分支复用稳定消息 ID，只有成功投递才完成 checkpoint', () => {
  const source = readFileSync('apps/web/src/components/ButlerActions.tsx', 'utf8');
  const sendBranch = source.slice(
    source.indexOf("if (draft.kind === 'send')"),
    source.indexOf("if (draft.kind === 'todo')"),
  );

  assert.match(sendBranch, /useChat\.getState\(\)\.send\(/);
  assert.match(sendBranch, /clientId:\s*draft\.messageId!/);
  assert.match(sendBranch, /result\.delivery === 'unknown'/);
  assert.match(sendBranch, /发送结果暂时无法确认，请检查原会话后重试/);
  assert.match(sendBranch, /result\.delivery === 'failed'/);
  assert.match(sendBranch, /result\.delivery === 'lan'/);
  assert.match(sendBranch, /await done\(/);
});

test('待办和承诺必须等待本次持久化完成后再完成 checkpoint', () => {
  const source = readFileSync('apps/web/src/components/ButlerActions.tsx', 'utf8');
  for (const [kind, nextKind] of [['todo', 'commitment'], ['commitment', 'ado']] as const) {
    const branch = source.slice(
      source.indexOf(`if (draft.kind === '${kind}')`),
      source.indexOf(`if (draft.kind === '${nextKind}')`),
    );
    const addIndex = branch.indexOf('useTodos.getState().add(');
    const persistedIndex = branch.indexOf('await awaitLastTodoWrite()');
    const completeIndex = branch.indexOf('await done(');
    assert.ok(addIndex >= 0 && persistedIndex > addIndex, `${kind} 必须等待刚刚那次写入`);
    assert.ok(completeIndex > persistedIndex, `${kind} 只能在持久化后完成 checkpoint`);
  }
});

test('ADO 状态确认分支走 Host 受控写合同，不经 Business MCP', () => {
  const source = readFileSync('apps/web/src/components/ButlerActions.tsx', 'utf8');
  const branch = source.slice(
    source.indexOf("if (draft.kind === 'ado-state')"),
    source.indexOf("if (draft.kind === 'ado')"),
  );
  assert.match(branch, /directSetWorkItemStateControlled/);
  assert.match(branch, /expectedRevision:\s*draft\.expectedRevision!/);
  assert.match(branch, /expectedState:\s*draft\.currentState!/);
  assert.match(branch, /await done\(/);
  assert.doesNotMatch(branch, /businessMcp|rocketx_azure_devops_server_read/);
});
