import {
  BUTLER_LEARNING_DAY_MS,
  BUTLER_OPERATION_LIMIT,
  butlerLearningDayKey,
  createButlerLearningId,
  normalizeButlerLearningText,
  type OperationAction,
  type OperationReceipt,
  type RepetitionCandidate,
  type WorkInsight,
} from './model';

export function createOperationReceipt(input: {
  action: OperationAction;
  intentKey: string;
  surface: string;
  outcome?: OperationReceipt['outcome'];
  at?: number;
  durationMs?: number;
}): OperationReceipt {
  const intentKey = normalizeButlerLearningText(input.intentKey, 100);
  const surface = normalizeButlerLearningText(input.surface, 60);
  if (!intentKey || !surface) throw new Error('语义回执必须包含意图和工作面');
  return {
    id: createButlerLearningId('operation'),
    action: input.action,
    intentKey,
    surface,
    outcome: input.outcome ?? 'completed',
    at: input.at ?? Date.now(),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

export function appendOperationReceipt(
  receipts: readonly OperationReceipt[],
  receipt: OperationReceipt,
): OperationReceipt[] {
  return [...receipts, receipt].slice(-BUTLER_OPERATION_LIMIT);
}

export function analyzeWorkInsights(
  receipts: readonly OperationReceipt[],
  now = Date.now(),
): WorkInsight[] {
  const recent = receipts.filter((receipt) =>
    receipt.outcome === 'completed' && now - receipt.at <= 30 * BUTLER_LEARNING_DAY_MS);
  if (recent.length < 3) return [];
  const insights: WorkInsight[] = [];
  const hourBuckets = new Map<number, number>();
  for (const receipt of recent) {
    const hour = new Date(receipt.at).getHours();
    hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
  }
  const peak = [...hourBuckets.entries()].sort((a, b) => b[1] - a[1])[0];
  if (peak && peak[1] >= 3) {
    insights.push({
      id: `insight-rhythm-${peak[0]}`,
      kind: 'rhythm',
      title: `你通常在 ${String(peak[0]).padStart(2, '0')}:00 左右集中处理工作`,
      evidence: `最近 30 天有 ${peak[1]} 次已完成操作落在这个时段。`,
      suggestion: '可以把需要连续注意力的检查或整理集中到这个时间窗。',
      confidence: peak[1] >= 6 ? 'high' : 'medium',
      createdAt: now,
    });
  }
  const viewCounts = new Map<string, number>();
  for (const receipt of recent.filter((item) => item.action === 'open-view')) {
    viewCounts.set(receipt.intentKey, (viewCounts.get(receipt.intentKey) ?? 0) + 1);
  }
  const frequentView = [...viewCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (frequentView && frequentView[1] >= 3) {
    insights.push({
      id: `insight-attention-${frequentView[0]}`,
      kind: 'attention',
      title: '这个工作面被你反复手动打开',
      evidence: `“${frequentView[0]}”出现了 ${frequentView[1]} 次。`,
      suggestion: '先预演一个快捷入口或例行照看，减少来回切换。',
      confidence: frequentView[1] >= 6 ? 'high' : 'medium',
      createdAt: now,
    });
  }
  const questions = recent.filter((receipt) => receipt.action === 'ask-butler').length;
  const tasks = recent.filter((receipt) => receipt.action === 'create-task').length;
  if (questions >= 2 && tasks >= 1) {
    insights.push({
      id: 'insight-collaboration-question-to-task',
      kind: 'collaboration',
      title: '你会先让管家分析，再把结论转为任务',
      evidence: `最近有 ${questions} 次分析请求和 ${tasks} 次任务创建。`,
      suggestion: '遇到同类问题时，可以直接要求“分析后把可执行项转为任务”。',
      confidence: questions + tasks >= 6 ? 'high' : 'medium',
      createdAt: now,
    });
  }
  return insights;
}

export function mineRepetitionCandidates(
  receipts: readonly OperationReceipt[],
  options: { minimumOccurrences?: number; minimumDays?: number; now?: number } = {},
): RepetitionCandidate[] {
  const minimumOccurrences = options.minimumOccurrences ?? 3;
  const minimumDays = options.minimumDays ?? 2;
  const now = options.now ?? Date.now();
  const groups = new Map<string, OperationReceipt[]>();
  for (const receipt of receipts) {
    if (receipt.outcome !== 'completed' || now - receipt.at > 30 * BUTLER_LEARNING_DAY_MS) continue;
    const key = `${receipt.action}:${receipt.intentKey}`;
    groups.set(key, [...(groups.get(key) ?? []), receipt]);
  }
  return [...groups.entries()].flatMap(([key, entries]) => {
    const days = new Set(entries.map((entry) => butlerLearningDayKey(entry.at)));
    if (entries.length < minimumOccurrences || days.size < minimumDays) return [];
    const ordered = [...entries].sort((a, b) => a.at - b.at);
    return [{
      id: `repeat-${key.replace(/[^a-zA-Z0-9-]+/g, '-')}`,
      action: ordered[0].action,
      intentKey: ordered[0].intentKey,
      occurrences: entries.length,
      activeDays: days.size,
      firstAt: ordered[0].at,
      lastAt: ordered.at(-1)!.at,
      surfaces: [...new Set(entries.map((entry) => entry.surface))],
    }];
  }).sort((a, b) => b.occurrences - a.occurrences);
}
