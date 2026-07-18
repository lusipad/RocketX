import { kernelStore } from '../store';
import { getAiBus } from './runtime';
import { SemanticSearchIndex, type SemanticEmbedder } from './semantic-search';

let index: SemanticSearchIndex | undefined;

const runtimeEmbedder: SemanticEmbedder = {
  describeEmbedding: (capability) => getAiBus().describeEmbedding(capability),
  embed: (capability, texts) => getAiBus().embed(capability, texts),
};

export function getSemanticSearchIndex(): SemanticSearchIndex {
  index ??= new SemanticSearchIndex(kernelStore.vectors, runtimeEmbedder);
  return index;
}

/**
 * 语义搜索是否可用：需要「语义搜索」能力路由到配置了 embedding 模型的
 * Provider。只有对话大模型（或 Codex）时不可用——入口应该隐藏而不是
 * 让用户点出一个报错（issue #95）。
 */
export function semanticSearchAvailable(): boolean {
  try {
    getAiBus().describeEmbedding('semantic-search');
    return true;
  } catch {
    return false;
  }
}
