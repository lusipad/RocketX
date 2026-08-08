import { Check, Lightbulb, X } from 'lucide-react';
import { useStore } from 'zustand';
import { toast } from '../../../../stores/toast';
import type { ImprovementTarget } from '../model';
import { butlerEfficiency } from '../runtime';

const TARGET_LABELS: Record<ImprovementTarget, string> = {
  task: '任务',
  profile: 'Profile',
  'memory-rule': '规则',
  routine: '例行照看',
  'tool-preset': '快捷入口',
  'micro-skill': 'Skill',
  'no-op': '保持现状',
};

export default function EfficiencySection() {
  const efficiencyState = useStore(butlerEfficiency.store);
  const proposals = efficiencyState.proposals.filter(
    (proposal) => proposal.status !== 'dismissed' && proposal.target !== 'micro-skill',
  );

  return (
    <section aria-label="效率机会" className="border-t border-line/70 pt-7">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Lightbulb size={15} />
          可减少的重复
        </h3>
        <p className="mt-1 text-xs leading-5 text-ink-3">
          至少 3 次且跨 2 天才提出候选；这里只展示不需要沉淀为 Skill 的改进。
        </p>
      </div>
      <div className="mt-4 space-y-3">
        {proposals.length ? proposals.map((proposal) => (
          <article key={proposal.id} className="rounded-lg border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <span className="text-[10px] text-primary">{TARGET_LABELS[proposal.target]}</span>
                <h4 className="mt-0.5 text-sm font-medium text-ink">{proposal.title}</h4>
                <p className="mt-1 text-xs text-ink-3">{proposal.rationale}</p>
              </div>
              <button
                type="button"
                aria-label={`忽略${proposal.title}`}
                onClick={() => butlerEfficiency.dismiss(proposal.id)}
                className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
            {proposal.status === 'dry-run' || proposal.status === 'enabled' ? (
              <ol className="mt-3 space-y-1 text-xs text-ink-2">
                {proposal.preview.map((line) => <li key={line}>{line}</li>)}
              </ol>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              {proposal.status === 'suggested' ? (
                <button
                  type="button"
                  onClick={() => butlerEfficiency.dryRun(proposal.id)}
                  className="h-8 rounded border border-line px-3 text-xs text-ink hover:bg-fill-hover"
                >
                  先看预演
                </button>
              ) : null}
              {proposal.status === 'dry-run' && proposal.target === 'micro-skill' ? (
                <button
                  type="button"
                  onClick={() => {
                    try {
                      butlerEfficiency.enable(proposal.id);
                      toast.success(`已形成 Skill「${proposal.skillName}」`);
                    } catch (error) {
                      toast.error(error, '形成 Skill 失败');
                    }
                  }}
                  className="h-8 rounded bg-primary px-3 text-xs text-white hover:bg-primary-hover"
                >
                  确认形成 Skill
                </button>
              ) : null}
              {proposal.status === 'enabled' ? (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <Check size={12} />
                  已启用
                </span>
              ) : null}
            </div>
          </article>
        )) : (
          <p className="rounded-lg bg-surface-2 p-4 text-sm text-ink-3">
            还没有跨天稳定重复。一次性的操作不会被包装成自动化。
          </p>
        )}
      </div>
    </section>
  );
}
