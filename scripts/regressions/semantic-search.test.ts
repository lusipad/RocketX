import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { AiBus } from '../../apps/web/src/kernel/ai/bus';
import type { AiCapability, AiProvider } from '../../apps/web/src/kernel/ai/provider';
import {
  SemanticIndexRebuildRequiredError,
  SemanticSearchIndex,
  cosineSimilarity,
  type SemanticEmbedder,
} from '../../apps/web/src/kernel/ai/semantic-search';

class FakeEmbedder implements SemanticEmbedder {
  providerId = 'embedding-provider';
  model = 'embedding-v1';
  dimension = 2;
  calls: string[][] = [];

  describeEmbedding(_capability: AiCapability) {
    return { providerId: this.providerId, model: this.model };
  }

  async embed(_capability: AiCapability, texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const primary = text.includes('alpha') || text.includes('项目') ? 1 : 0;
      const values = [primary, primary ? 0 : 1];
      while (values.length < this.dimension) values.push(0.5);
      return values.slice(0, this.dimension);
    });
  }
}

const scope = {
  serverId: 'https://chat-a.example.com',
  userId: 'user-a',
  memberRoomIds: ['room-a', 'room-b'],
} as const;

test('embedding 路由暴露实际 provider/model 并沿用本地限制', async () => {
  let called = false;
  const provider: AiProvider = {
    id: 'embed-local',
    locality: 'local',
    embeddingModel: 'nomic-embed-text',
    async *chat() {},
    async embed(texts) {
      called = true;
      return texts.map(() => [1, 0]);
    },
  };
  const bus = new AiBus(() => {});
  bus.register(provider);
  bus.setRoute('semantic-search', { providerId: provider.id, localOnly: true });
  assert.deepEqual(bus.describeEmbedding('semantic-search'), {
    providerId: 'embed-local',
    model: 'nomic-embed-text',
  });
  assert.deepEqual(await bus.embed('semantic-search', ['hello']), [[1, 0]]);
  assert.equal(called, true);

  const external: AiProvider = { ...provider, id: 'embed-external', locality: 'external' };
  const guardedBus = new AiBus(() => {});
  guardedBus.register(external);
  guardedBus.setRoute('semantic-search', { providerId: external.id, localOnly: true });
  await assert.rejects(() => guardedBus.embed('semantic-search', ['secret']), /仅允许本地模型/);
});

test('增量同步只嵌入新增或变化文档并绑定索引元数据', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const embedder = new FakeEmbedder();
  const index = new SemanticSearchIndex(store.vectors, embedder);
  const documents = [
    { id: 'a', roomId: 'room-a', text: 'alpha 项目', revision: 1, payload: { ts: 1 } },
    { id: 'b', roomId: 'room-b', text: 'beta 日常', revision: 1, payload: { ts: 2 } },
    { id: 'outside', roomId: 'room-x', text: 'alpha 机密', revision: 1 },
  ];

  const first = await index.synchronize(documents, scope);
  assert.deepEqual(first, {
    providerId: 'embedding-provider',
    model: 'embedding-v1',
    dimension: 2,
    documentCount: 2,
    embedded: 2,
    reused: 0,
    deleted: 0,
    rebuilt: false,
  });
  assert.deepEqual(embedder.calls, [['alpha 项目', 'beta 日常']]);

  const second = await index.synchronize(documents, scope);
  assert.equal(second?.embedded, 0);
  assert.equal(second?.reused, 2);
  assert.equal(embedder.calls.length, 1);

  const changed = documents.map((document) =>
    document.id === 'a' ? { ...document, text: 'alpha 项目更新', revision: 2 } : document,
  );
  const third = await index.synchronize(changed, scope);
  assert.equal(third?.embedded, 1);
  assert.equal(third?.reused, 1);
  assert.deepEqual(embedder.calls.at(-1), ['alpha 项目更新']);
  assert.deepEqual(await index.metadata(scope), {
    providerId: 'embedding-provider',
    model: 'embedding-v1',
    dimension: 2,
    documentCount: 2,
  });

  const persisted = (await store.vectors.list<Record<string, unknown>>()).filter(
    ({ value }) => value.kind === 'document',
  );
  assert.equal(persisted.length, 2);
  for (const { value } of persisted) {
    assert.equal(value.providerId, 'embedding-provider');
    assert.equal(value.model, 'embedding-v1');
    assert.equal(value.dimension, 2);
  }
});

test('provider/model 或维度变化强制全量重建，搜索不会混用旧索引', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const embedder = new FakeEmbedder();
  const index = new SemanticSearchIndex(store.vectors, embedder);
  const documents = [
    { id: 'a', roomId: 'room-a', text: 'alpha' },
    { id: 'b', roomId: 'room-b', text: 'beta' },
  ];
  await index.synchronize(documents, scope);

  embedder.model = 'embedding-v2';
  await assert.rejects(
    () => index.search('项目', scope),
    (error) => error instanceof SemanticIndexRebuildRequiredError,
  );
  const modelRebuild = await index.synchronize(documents, scope);
  assert.equal(modelRebuild?.rebuilt, true);
  assert.equal(modelRebuild?.embedded, 2);
  assert.equal(modelRebuild?.model, 'embedding-v2');

  embedder.dimension = 3;
  const dimensionRebuild = await index.synchronize([
    { ...documents[0], text: 'alpha changed' },
    documents[1],
  ], scope);
  assert.equal(dimensionRebuild?.rebuilt, true);
  assert.equal(dimensionRebuild?.embedded, 2);
  assert.equal(dimensionRebuild?.dimension, 3);
});

test('余弦检索排序正确并在成员变化后删除无权房间向量', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const embedder = new FakeEmbedder();
  const index = new SemanticSearchIndex(store.vectors, embedder);
  await index.synchronize([
    { id: 'project', roomId: 'room-a', text: 'alpha 项目', payload: { rid: 'room-a' } },
    { id: 'daily', roomId: 'room-b', text: 'beta 日常', payload: { rid: 'room-b' } },
  ], scope);

  const all = await index.search<{ rid: string }>('项目回顾', scope);
  assert.deepEqual(all.map(({ id }) => id), ['project', 'daily']);
  assert.ok(all[0].score > all[1].score);
  assert.deepEqual(all[0].payload, { rid: 'room-a' });

  const reducedScope = { ...scope, memberRoomIds: ['room-a'] };
  const allowed = await index.search('项目回顾', reducedScope);
  assert.deepEqual(allowed.map(({ id }) => id), ['project']);
  assert.equal((await index.metadata(reducedScope))?.documentCount, 1);
  const persistedText = JSON.stringify(await store.vectors.list());
  assert.equal(persistedText.includes('beta 日常'), false);
});

test('服务器和用户作用域完全隔离且空作用域不发送 query embedding', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const embedder = new FakeEmbedder();
  const index = new SemanticSearchIndex(store.vectors, embedder);
  await index.synchronize([{ id: 'a', roomId: 'room-a', text: 'alpha' }], {
    ...scope,
    memberRoomIds: ['room-a'],
  });
  const callsAfterSync = embedder.calls.length;

  assert.deepEqual(await index.search('项目', { ...scope, serverId: 'https://chat-b.example.com' }), []);
  assert.deepEqual(await index.search('项目', { ...scope, userId: 'user-b' }), []);
  assert.deepEqual(await index.search('项目', { ...scope, memberRoomIds: [] }), []);
  assert.equal(embedder.calls.length, callsAfterSync);
  assert.equal(await index.metadata(scope), undefined);
});

test('余弦相似度拒绝维度错误并安全处理零向量', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.throws(() => cosineSimilarity([1], [1, 0]), /同维度/);
});
