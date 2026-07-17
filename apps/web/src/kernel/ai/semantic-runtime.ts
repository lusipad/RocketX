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
