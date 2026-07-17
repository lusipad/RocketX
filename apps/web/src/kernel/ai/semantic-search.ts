import type { NamedStore } from '@rcx/rcx-store';
import type { AiCapability } from './provider';
import type { AiEmbeddingBinding } from './bus';

const INDEX_VERSION = 1 as const;
const RECORD_PREFIX = 'semantic-search:v1:';

export interface SemanticSearchScope {
  serverId: string;
  userId: string;
  memberRoomIds: readonly string[];
}

export interface SemanticDocument<T = unknown> {
  id: string;
  roomId: string;
  text: string;
  revision?: string | number;
  payload?: T;
}

export interface SemanticSearchResult<T = unknown> {
  id: string;
  roomId: string;
  text: string;
  payload?: T;
  score: number;
}

export interface SemanticIndexMetadata extends AiEmbeddingBinding {
  dimension: number;
  documentCount: number;
}

export interface SemanticSyncResult extends SemanticIndexMetadata {
  embedded: number;
  reused: number;
  deleted: number;
  rebuilt: boolean;
}

export interface SemanticSearchOptions {
  limit?: number;
  minScore?: number;
}

export interface SemanticEmbedder {
  describeEmbedding(capability: AiCapability): AiEmbeddingBinding;
  embed(capability: AiCapability, texts: string[]): Promise<number[][]>;
}

interface StoredScope {
  serverId: string;
  userId: string;
}

interface SemanticManifestRecord extends SemanticIndexMetadata {
  kind: 'manifest';
  version: typeof INDEX_VERSION;
  scope: StoredScope;
}

interface SemanticDocumentRecord<T = unknown> {
  kind: 'document';
  version: typeof INDEX_VERSION;
  scope: StoredScope;
  documentId: string;
  roomId: string;
  text: string;
  fingerprint: string;
  payload?: T;
  vector: number[];
  providerId: string;
  model: string;
  dimension: number;
}

type SemanticRecord = SemanticManifestRecord | SemanticDocumentRecord;

interface StoredDocumentEntry {
  id: string;
  value: SemanticDocumentRecord;
}

export class SemanticIndexRebuildRequiredError extends Error {
  constructor(message = 'Embedding Provider 或模型已变化，请重建语义索引') {
    super(message);
    this.name = 'SemanticIndexRebuildRequiredError';
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}

function normalizeScope(scope: SemanticSearchScope): {
  stored: StoredScope;
  memberRoomIds: Set<string>;
  key: string;
} {
  const serverId = required(scope.serverId, 'serverId');
  const userId = required(scope.userId, 'userId');
  const memberRoomIds = new Set(scope.memberRoomIds.map((id) => required(id, 'roomId')));
  return {
    stored: { serverId, userId },
    memberRoomIds,
    key: `${encodeURIComponent(serverId)}:${encodeURIComponent(userId)}`,
  };
}

function sameScope(left: StoredScope, right: StoredScope): boolean {
  return left.serverId === right.serverId && left.userId === right.userId;
}

function manifestId(scopeKey: string): string {
  return `${RECORD_PREFIX}${scopeKey}:manifest`;
}

function documentId(scopeKey: string, id: string): string {
  return `${RECORD_PREFIX}${scopeKey}:document:${encodeURIComponent(id)}`;
}

function fingerprint(document: SemanticDocument): string {
  return JSON.stringify([document.roomId, document.text, document.revision ?? null]);
}

function bindingMatches(
  binding: AiEmbeddingBinding,
  record: Pick<SemanticIndexMetadata, 'providerId' | 'model'>,
): boolean {
  return binding.providerId === record.providerId && binding.model === record.model;
}

function validateVectors(vectors: number[][], expectedCount: number): number {
  if (vectors.length !== expectedCount) throw new Error('embedding 响应数量与输入不一致');
  if (vectors.length === 0) return 0;
  const dimension = vectors[0]?.length ?? 0;
  if (dimension === 0) throw new Error('embedding 向量维度不能为空');
  for (const vector of vectors) {
    if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('embedding 向量维度不一致或包含非有限数值');
    }
  }
  return dimension;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error('余弦相似度要求两个非空且同维度的向量');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export class SemanticSearchIndex {
  constructor(
    private readonly store: NamedStore,
    private readonly embedder: SemanticEmbedder,
    private readonly batchSize = 32,
  ) {
    if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('batchSize 必须是正整数');
  }

  private async loadScope(scope: StoredScope): Promise<{
    manifest?: SemanticManifestRecord;
    documents: StoredDocumentEntry[];
  }> {
    const entries = await this.store.list<SemanticRecord>();
    let manifest: SemanticManifestRecord | undefined;
    const documents: StoredDocumentEntry[] = [];
    for (const entry of entries) {
      const value = entry.value;
      if (!value || value.version !== INDEX_VERSION || !sameScope(value.scope, scope)) continue;
      if (value.kind === 'manifest') manifest = value;
      else if (value.kind === 'document') documents.push({ id: entry.id, value });
    }
    return { manifest, documents };
  }

  private async embedDocuments(documents: readonly SemanticDocument[]): Promise<{
    vectors: number[][];
    dimension: number;
  }> {
    const vectors: number[][] = [];
    let dimension = 0;
    for (let start = 0; start < documents.length; start += this.batchSize) {
      const batch = documents.slice(start, start + this.batchSize);
      const embedded = await this.embedder.embed('semantic-search', batch.map((item) => item.text));
      const batchDimension = validateVectors(embedded, batch.length);
      if (dimension !== 0 && batchDimension !== dimension) {
        throw new Error('embedding 批次之间的向量维度不一致');
      }
      dimension = batchDimension;
      vectors.push(...embedded);
    }
    return { vectors, dimension };
  }

  async metadata(scope: SemanticSearchScope): Promise<SemanticIndexMetadata | undefined> {
    const normalized = normalizeScope(scope);
    const { manifest } = await this.loadScope(normalized.stored);
    if (!manifest) return undefined;
    return {
      providerId: manifest.providerId,
      model: manifest.model,
      dimension: manifest.dimension,
      documentCount: manifest.documentCount,
    };
  }

  async synchronize<T = unknown>(
    documents: readonly SemanticDocument<T>[],
    scope: SemanticSearchScope,
  ): Promise<SemanticSyncResult | undefined> {
    const normalized = normalizeScope(scope);
    const binding = this.embedder.describeEmbedding('semantic-search');
    const previous = await this.loadScope(normalized.stored);
    const eligible = new Map<string, SemanticDocument<T>>();
    for (const document of documents) {
      const id = required(document.id, 'document.id');
      const roomId = required(document.roomId, 'document.roomId');
      if (!normalized.memberRoomIds.has(roomId)) continue;
      if (eligible.has(id)) throw new Error(`语义索引文档 id 重复: ${id}`);
      eligible.set(id, { ...document, id, roomId });
    }

    if (eligible.size === 0) {
      await Promise.all([
        ...previous.documents.map((entry) => this.store.delete(entry.id)),
        this.store.delete(manifestId(normalized.key)),
      ]);
      return undefined;
    }

    const previousById = new Map(previous.documents.map((entry) => [entry.value.documentId, entry]));
    let rebuilt =
      previous.documents.length > 0 &&
      (!previous.manifest || !bindingMatches(binding, previous.manifest));
    let candidates = [...eligible.values()].filter((document) => {
      if (rebuilt) return true;
      const prior = previousById.get(document.id)?.value;
      return !prior || prior.fingerprint !== fingerprint(document) || !bindingMatches(binding, prior);
    });

    let embedded = await this.embedDocuments(candidates);
    if (
      !rebuilt &&
      candidates.length > 0 &&
      previous.manifest &&
      embedded.dimension !== previous.manifest.dimension
    ) {
      rebuilt = true;
      candidates = [...eligible.values()];
      embedded = await this.embedDocuments(candidates);
    }

    const dimension = embedded.dimension || previous.manifest?.dimension || 0;
    if (dimension === 0) throw new Error('无法确定语义索引向量维度');
    const vectorById = new Map(candidates.map((document, index) => [document.id, embedded.vectors[index]]));
    let reused = 0;
    const nextRecords: SemanticDocumentRecord<T>[] = [];
    for (const document of eligible.values()) {
      const prior = previousById.get(document.id)?.value as SemanticDocumentRecord<T> | undefined;
      const vector = vectorById.get(document.id) ?? prior?.vector;
      if (!vector || vector.length !== dimension) {
        throw new Error('现有向量与当前 embedding 维度不一致，请重建语义索引');
      }
      if (!vectorById.has(document.id)) reused += 1;
      nextRecords.push({
        kind: 'document',
        version: INDEX_VERSION,
        scope: normalized.stored,
        documentId: document.id,
        roomId: document.roomId,
        text: document.text,
        fingerprint: fingerprint(document),
        payload: document.payload,
        vector,
        providerId: binding.providerId,
        model: binding.model,
        dimension,
      });
    }

    const nextIds = new Set(nextRecords.map((record) => record.documentId));
    const stale = previous.documents.filter((entry) => !nextIds.has(entry.value.documentId));
    await Promise.all(stale.map((entry) => this.store.delete(entry.id)));
    await Promise.all(
      nextRecords.map((record) =>
        this.store.set(documentId(normalized.key, record.documentId), record),
      ),
    );
    const manifest: SemanticManifestRecord = {
      kind: 'manifest',
      version: INDEX_VERSION,
      scope: normalized.stored,
      providerId: binding.providerId,
      model: binding.model,
      dimension,
      documentCount: nextRecords.length,
    };
    await this.store.set(manifestId(normalized.key), manifest);

    return {
      providerId: binding.providerId,
      model: binding.model,
      dimension,
      documentCount: nextRecords.length,
      embedded: candidates.length,
      reused,
      deleted: stale.length,
      rebuilt,
    };
  }

  async search<T = unknown>(
    query: string,
    scope: SemanticSearchScope,
    options: SemanticSearchOptions = {},
  ): Promise<Array<SemanticSearchResult<T>>> {
    const normalized = normalizeScope(scope);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const current = await this.loadScope(normalized.stored);
    if (!current.manifest) return [];
    const disallowed = current.documents.filter(
      (entry) => !normalized.memberRoomIds.has(entry.value.roomId),
    );
    if (disallowed.length > 0) {
      await Promise.all(disallowed.map((entry) => this.store.delete(entry.id)));
    }
    const searchable = current.documents.filter((entry) =>
      normalized.memberRoomIds.has(entry.value.roomId),
    );
    if (searchable.length === 0) {
      await this.store.delete(manifestId(normalized.key));
      return [];
    }
    if (disallowed.length > 0) {
      await this.store.set(manifestId(normalized.key), {
        ...current.manifest,
        documentCount: searchable.length,
      });
    }

    const binding = this.embedder.describeEmbedding('semantic-search');
    if (!bindingMatches(binding, current.manifest)) throw new SemanticIndexRebuildRequiredError();

    const queryVectors = await this.embedder.embed('semantic-search', [normalizedQuery]);
    const queryDimension = validateVectors(queryVectors, 1);
    if (queryDimension !== current.manifest.dimension) {
      throw new SemanticIndexRebuildRequiredError('Embedding 向量维度已变化，请重建语义索引');
    }

    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit 必须是正整数');
    const minScore = options.minScore ?? -1;
    return searchable
      .map(({ value }) => {
        if (
          value.dimension !== current.manifest?.dimension ||
          !bindingMatches(binding, value)
        ) {
          throw new SemanticIndexRebuildRequiredError();
        }
        return {
          id: value.documentId,
          roomId: value.roomId,
          text: value.text,
          payload: value.payload as T | undefined,
          score: cosineSimilarity(queryVectors[0], value.vector),
        };
      })
      .filter((result) => result.score >= minScore)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
  }
}
