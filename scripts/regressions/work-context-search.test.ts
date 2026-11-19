import assert from 'node:assert/strict';
import test from 'node:test';
import { searchWorkContext } from '../../apps/web/src/lib/workSearch';

const sources = {
  accountScope: 'alice', cards: [
    { id: 'a', title: '发布准备', adoWorkItemId: 812, adoProject: 'RocketX', updatedAt: 10, state: { projectKey: 'RocketX' } },
    { id: 'b', title: '隐私项目', updatedAt: 10, state: { projectKey: 'Other' } },
  ],
  sessions: [
    { id: 'sa', todoId: 'a', nativeSessionId: 'thread-native', runtime: 'codex', title: '核验', workspaceRoot: 'D:/RocketX', accountScope: 'alice', updatedAt: 20 },
    { id: 'sb', todoId: 'b', nativeSessionId: 'other-thread', runtime: 'codex', workspaceRoot: 'D:/other', accountScope: 'bob', updatedAt: 20 },
  ],
  links: [{ id: 'la', todoId: 'a', externalId: '812', title: '缺陷', webUrl: 'https://ado/item/812', lastVerifiedAt: 30 }],
  evidences: [{ id: 'ea', todoId: 'a', title: 'release-notes.md', summary: 'D:/RocketX/docs/release-notes.md', workspaceRoot: 'D:/RocketX', verifiedAt: 40 }],
  digests: [{ id: 'da', accountScope: 'alice', relatedTodoId: 'a', title: '发布摘要', summaryMd: '验收依据', createdAt: 50 }],
};

test('缓存检索支持 ADO 号、原生会话、成果文件和外部联系并保留来源', () => {
  for (const query of ['812', 'thread-native', 'release-notes.md', 'ado/item/812', '验收依据']) {
    const results = searchWorkContext({ ...sources, query, workspaceRoot: 'd:\\rocketx', projectKey: 'RocketX' });
    assert.ok(results.length > 0, query);
    assert.ok(results.every((r) => r.workId === 'a'));
    assert.ok(results.every((r) => r.updatedAt > 0));
  }
});

test('账号和项目范围不会返回其他会话或未关联的成果，不把未搜索到宣称为全源不存在', () => {
  const other = searchWorkContext({ ...sources, query: 'other-thread' });
  assert.deepEqual(other, []);
  const project = searchWorkContext({ ...sources, query: '隐私', workspaceRoot: 'D:/RocketX', projectKey: 'RocketX' });
  assert.deepEqual(project, []);
  assert.deepEqual(searchWorkContext({ ...sources, query: '   ' }), []);
});
