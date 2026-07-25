import { useState } from 'react';
import { Check, ExternalLink, Eye, ListTodo } from 'lucide-react';
import { adoWebBase } from '../lib/ado';
import {
  parseButlerConclusions,
  senderFromSourceLabel,
  type ButlerConclusion,
} from '../lib/butlerConclusions';
import {
  createConclusionCheckpoint,
  turnConclusionIntoTodo,
  watchConclusion,
} from '../lib/butlerConclusionActions';
import { openButlerSource } from '../lib/butlerSourceNavigation';
import { siteUrlSync, openExternal } from '../lib/client';
import { executeApprovedButlerOperation, type ButlerLine } from '../stores/butler';
import { toast } from '../stores/toast';
import { flushTodoWrites } from '../stores/todos';

const COLLAPSE_THRESHOLD = 3;

function openLabel(conclusion: ButlerConclusion): string {
  if (conclusion.ref.startsWith('msg:')) return '打开原文';
  if (conclusion.ref.startsWith('pr:')) return `打开 PR #${conclusion.ref.slice(3)}`;
  if (conclusion.ref.startsWith('wi:')) return `打开工作项 #${conclusion.ref.slice(3)}`;
  return '打开构建';
}

/**
 * 结论级一键动作。
 *
 * 归属完全来自结论文本自带的链接（技能强制每条带 [原文](link) / [#编号](webUrl)），
 * 但写动作的字段只认命中的 ButlerSource——模型编出来的 id 不会变成写操作。
 * 没有可识别锚点时整个组件不渲染，因此对既有回答零影响。
 */
export default function ButlerConclusionActions({
  line,
  disabled = false,
}: {
  line: ButlerLine;
  disabled?: boolean;
}) {
  const [watching, setWatching] = useState<{ index: number; who: string; due: string } | null>(null);
  const [handled, setHandled] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  if (
    line.role !== 'assistant'
    || line.text.startsWith('我是你的管家')
    || line.text.startsWith('📌')
    || line.text.startsWith('✅')
  ) return null;

  const conclusions = parseButlerConclusions(line.text, {
    siteUrl: siteUrlSync(),
    adoBase: adoWebBase(),
    ...(line.sources ? { sources: line.sources } : {}),
  });
  if (conclusions.length === 0) return null;

  const collapsed = conclusions.length > COLLAPSE_THRESHOLD && !expanded;

  const open = (conclusion: ButlerConclusion): void => {
    if (conclusion.source) {
      void openButlerSource(conclusion.source);
      return;
    }
    if (conclusion.fallbackWebUrl) void openExternal(conclusion.fallbackWebUrl);
  };

  const asTodo = async (conclusion: ButlerConclusion): Promise<void> => {
    setBusy(true);
    try {
      const checkpoint = createConclusionCheckpoint(conclusion, 'todo');
      const outcome = await executeApprovedButlerOperation(
        checkpoint,
        () => turnConclusionIntoTodo(conclusion),
      );
      await flushTodoWrites();
      if (outcome === 'already-exists') toast.info('这条已经在待办里了');
      else if (outcome === 'unsupported') toast.error('这条不支持记为待办');
      else {
        setHandled((current) => ({ ...current, [conclusion.index]: '已记为待办' }));
        toast.success('已记为待办');
      }
    } catch (error) {
      toast.error(error, '记待办失败');
    } finally {
      setBusy(false);
    }
  };

  const submitWatch = async (conclusion: ButlerConclusion): Promise<void> => {
    if (!watching) return;
    const who = watching.who.trim();
    if (!who) {
      toast.error('先写清楚在等谁');
      return;
    }
    setBusy(true);
    try {
      const checkpoint = createConclusionCheckpoint(conclusion, 'wait', who);
      const outcome = await executeApprovedButlerOperation(
        checkpoint,
        () => watchConclusion(conclusion, { who, ...(watching.due ? { due: watching.due } : {}) }),
      );
      await flushTodoWrites();
      if (outcome === 'needs-who') {
        toast.error('先写清楚在等谁');
        return;
      }
      if (outcome === 'unsupported') {
        toast.error('这条不支持盯它');
        return;
      }
      setHandled((current) => ({ ...current, [conclusion.index]: `在等 ${who}` }));
      setWatching(null);
      toast.success(outcome === 'already-watching' ? '已经在等这条了' : `已放进等待台账：等 ${who}`);
    } catch (error) {
      toast.error(error, '盯它失败');
    } finally {
      setBusy(false);
    }
  };

  const visible = collapsed ? [] : conclusions;

  return (
    <div className="mt-2 rounded-lg border border-line bg-fill-1/40 px-2.5 py-2" aria-label="逐条处理">
      {collapsed ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-2xs text-ink-3 hover:text-ink"
        >
          逐条处理（{conclusions.length}）
        </button>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visible.map((conclusion) => (
            <div key={conclusion.index} role="group" aria-label={`结论 ${conclusion.index + 1}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-2" title={conclusion.text}>
                  {conclusion.label}
                </span>
                {handled[conclusion.index] ? (
                  <span className="flex shrink-0 items-center gap-1 text-2xs text-success">
                    <Check size={11} />
                    {handled[conclusion.index]}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => open(conclusion)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-40"
                >
                  <ExternalLink size={11} />
                  {openLabel(conclusion)}
                </button>
                {conclusion.can.todo && (
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => void asTodo(conclusion)}
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-40"
                  >
                    <ListTodo size={11} />
                    记为待办
                  </button>
                )}
                {conclusion.can.watch && (
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => setWatching(watching?.index === conclusion.index ? null : {
                      index: conclusion.index,
                      who: senderFromSourceLabel(conclusion.source?.label) ?? '',
                      due: '',
                    })}
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-40"
                  >
                    <Eye size={11} />
                    盯它
                  </button>
                )}
              </div>
              {watching?.index === conclusion.index && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-primary/25 bg-surface px-2 py-1.5">
                  <input
                    value={watching.who}
                    onChange={(event) => setWatching({ ...watching, who: event.target.value })}
                    aria-label="我在等谁"
                    placeholder="在等谁"
                    className="h-7 w-24 rounded border border-line bg-surface px-2 text-2xs text-ink outline-none focus:border-primary"
                  />
                  <input
                    type="date"
                    value={watching.due}
                    onChange={(event) => setWatching({ ...watching, due: event.target.value })}
                    aria-label="什么时候要"
                    className="h-7 rounded border border-line bg-surface px-1.5 text-2xs text-ink outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    disabled={busy || !watching.who.trim()}
                    onClick={() => void submitWatch(conclusion)}
                    className="h-7 rounded-md bg-primary px-2.5 text-2xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                  >
                    放进等待
                  </button>
                  <button
                    type="button"
                    onClick={() => setWatching(null)}
                    className="h-7 rounded-md border border-line bg-surface px-2 text-2xs text-ink hover:bg-fill-hover"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
