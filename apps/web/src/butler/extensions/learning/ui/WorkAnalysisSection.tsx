import { BrainCircuit } from 'lucide-react';
import { useStore } from 'zustand';
import {
  butlerOperationJournal,
  butlerWorkAnalysis,
  runButlerLearningAnalysis,
} from '../runtime';

function insightKindLabel(kind: 'rhythm' | 'attention' | 'collaboration'): string {
  if (kind === 'rhythm') return '节奏';
  if (kind === 'attention') return '注意力';
  return '协作';
}

export default function WorkAnalysisSection() {
  const journalState = useStore(butlerOperationJournal.store);
  const analysisState = useStore(butlerWorkAnalysis.store);

  return (
    <section aria-label="工作分析" className="border-t border-line/70 pt-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <BrainCircuit size={15} />
            工作分析
          </h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            只分析动作含义和结果，不采集键鼠、屏幕、原始输入或消息正文。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-3">
            <input
              type="checkbox"
              checked={journalState.enabled}
              onChange={(event) => butlerOperationJournal.setEnabled(event.target.checked)}
            />
            记录语义回执
          </label>
          <button
            type="button"
            onClick={runButlerLearningAnalysis}
            disabled={!journalState.enabled}
            className="h-8 rounded border border-line px-3 text-xs text-ink hover:bg-fill-hover disabled:opacity-40"
          >
            重新分析
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {analysisState.insights.length ? analysisState.insights.map((insight) => (
          <article key={insight.id} className="rounded-lg border border-line bg-surface-2 p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-fill-1 px-2 py-0.5 text-[10px] text-ink-3">
                {insightKindLabel(insight.kind)}
              </span>
              <h4 className="text-sm font-medium text-ink">{insight.title}</h4>
            </div>
            <p className="mt-2 text-xs text-ink-3">{insight.evidence}</p>
            <p className="mt-1 text-xs text-ink-2">建议：{insight.suggestion}</p>
          </article>
        )) : (
          <p className="rounded-lg bg-surface-2 p-4 text-sm text-ink-3">
            还没有足够样本。管家会在有至少 3 个语义操作后给出第一条弱洞察。
          </p>
        )}
      </div>
    </section>
  );
}
