import { validateMemoryNoSecrets, useButlerMemory, type ButlerMemoryCategory, type ButlerMemoryEntry } from '../stores/butlerMemory';

export interface RecalledMemoryContext {
  memories: ButlerMemoryEntry[];
  promptBlock: string;
}

export interface MemoryCandidate {
  category: ButlerMemoryCategory;
  title: string;
  content: string;
  tags: string[];
}

const MAX_RECALLED_ITEMS = 5;
const MAX_RECALLED_CHARS = 1500;

export function formatRecalledMemoriesBlock(memories: readonly ButlerMemoryEntry[]): string {
  const usable = memories
    .filter((m) => m.enabled && !m.supersededBy && (!m.expiresAt || m.expiresAt > Date.now()))
    .slice(0, MAX_RECALLED_ITEMS);
  if (usable.length === 0) return '';

  const lines: string[] = ['<recalled_memory>'];
  let totalChars = 0;
  for (const item of usable) {
    const line = `- [${item.category}] ${item.title}: ${item.content.replace(/\s+/g, ' ').trim()}`;
    if (totalChars + line.length > MAX_RECALLED_CHARS && lines.length > 1) break;
    lines.push(line);
    totalChars += line.length;
  }
  lines.push('</recalled_memory>');
  return lines.join('\n');
}

export interface ParsedRecalledMemoryBlock {
  recalledCount: number;
  recalledLines: string[];
  cleanText: string;
}

export function parseRecalledMemoryBlock(text: string): ParsedRecalledMemoryBlock {
  const match = /^<recalled_memory>([\s\S]*?)<\/recalled_memory>\s*/u.exec(text);
  if (!match) {
    return { recalledCount: 0, recalledLines: [], cleanText: text };
  }
  const recalledLines = match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  return {
    recalledCount: recalledLines.length,
    recalledLines,
    cleanText: text.slice(match[0].length),
  };
}

export async function recallForPrompt(
  prompt: string,
  workspaceRoot?: string | null,
  limit = MAX_RECALLED_ITEMS,
): Promise<RecalledMemoryContext> {
  const cleanPrompt = prompt.trim();
  const state = useButlerMemory.getState();
  if (!cleanPrompt || state.memoryPaused) {
    return { memories: [], promptBlock: '' };
  }
  try {
    const memories = await state.recallRelevantMemories({
      query: cleanPrompt,
      workspaceRoot,
      limit,
    });
    return {
      memories,
      promptBlock: formatRecalledMemoriesBlock(memories),
    };
  } catch {
    return { memories: [], promptBlock: '' };
  }
}

const PREFERENCE_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  category: ButlerMemoryCategory;
}> = [
  { regex: /(?:以后|今后|每次|总是|默认|请记住|记住我喜欢|别再|不要再)([^\n。！？!?]{4,140})/u, category: 'preference' },
  { regex: /\b(?:always use|prefer using|please remember|from now on|never use|do not use|don't use)\s+([^\n.!?]{4,140})/i, category: 'preference' },
  { regex: /(?:我们项目|本仓库|架构约定|构建命令|发布流程|约定是)([^\n。！？!?]{4,140})/u, category: 'project_fact' },
];

export function extractMemoryCandidates(
  userPrompt: string,
  _assistantReply: string,
  existingMemories: readonly ButlerMemoryEntry[] = [],
): MemoryCandidate[] {
  const text = userPrompt.trim();
  if (!text || text.length < 6) return [];

  const existingNormalized = new Set(
    existingMemories.map((item) => item.content.trim().toLowerCase()),
  );
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const rule of PREFERENCE_PATTERNS) {
    const match = rule.regex.exec(text);
    if (!match) continue;
    const rawSentence = (match[0] || '').trim().replace(/^[,，:：\s]+/, '');
    if (rawSentence.length < 6) continue;
    const norm = rawSentence.toLowerCase();
    if (seen.has(norm) || existingNormalized.has(norm)) continue;
    if (!validateMemoryNoSecrets(rawSentence).ok) continue;

    seen.add(norm);
    candidates.push({
      category: rule.category,
      title: rawSentence.slice(0, 48),
      content: rawSentence,
      tags: ['auto-extracted'],
    });
    if (candidates.length >= 2) break;
  }

  return candidates;
}
