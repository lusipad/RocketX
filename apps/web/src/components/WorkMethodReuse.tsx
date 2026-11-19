import { useState } from 'react';
import { createWorkFromSavedMethod, saveVerifiedWorkAsRoutine } from '../agent/workMethods';
import { evaluateCardCompletionGate } from '../agent/workCoordinator';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useRoutines } from '../stores/routines';
import { toast } from '../stores/toast';
import { useWorkLedger } from '../stores/workLedger';

export default function WorkMethodReuse({ workId, projectKey, workspaceRoot, onSelectWork }: {
  workId?: string | null; projectKey?: string | null; workspaceRoot?: string | null; onSelectWork?: (workId: string) => void;
}) {
  const cards = useWorkLedger((s) => s.cards);
  const evidences = useWorkLedger((s) => s.evidences);
  const routines = useRoutines((s) => s.routines);
  const card = cards.find((c) => c.id === workId);
  const canSave = Boolean(card?.done && card.state.acceptance.length && evaluateCardCompletionGate(card, evidences).canMarkDone);
  const methods = routines.filter((r) => r.workTemplate?.accountScope === resolveButlerAccountScope() && (!r.workTemplate.projectKey || r.workTemplate.projectKey === projectKey));
  const [mode, setMode] = useState<'closed' | 'save' | 'use'>('closed');
  const [name, setName] = useState('');
  const [inputs, setInputs] = useState('');
  const [steps, setSteps] = useState('');
  const [failure, setFailure] = useState('');
  const [methodId, setMethodId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (mode === 'save' && workId) {
        saveVerifiedWorkAsRoutine(workId, { name, inputs, steps, failureHandling: failure }, workspaceRoot ?? '');
        toast.success('方法已保存，默认手动使用');
      } else {
        const created = await createWorkFromSavedMethod(methodId, name, inputs, { projectKey, workspaceRoot });
        onSelectWork?.(created.id);
        toast.success('已创建新工作，请核对输入并选择执行环境');
      }
      setMode('closed');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section aria-label="复用已验证方法" className="space-y-2 rounded-xl border border-line p-3 text-xs">
    <strong className="text-ink">复用已验证方法</strong>
    <p className="text-ink-3">只保存方法与验收条件；每次创建独立工作并重新核验，不自动安排执行。</p>
    <div className="flex flex-wrap gap-2">
      {canSave && <button type="button" onClick={() => { setMode('save'); setName(card?.title ?? ''); setError(''); }} className="text-primary hover:underline">将成功方法保存为模板</button>}
      {methods.length > 0 && <button type="button" onClick={() => { setMode('use'); setMethodId(methods[0].id); setName(''); setInputs(''); setError(''); }} className="text-primary hover:underline">从方法创建工作</button>}
      {!canSave && methods.length === 0 && <span className="text-ink-3">工作验收完成后可保存方法，供当前项目再次使用。</span>}
    </div>
    {methods.length > 0 && <details className="text-ink-3"><summary className="cursor-pointer">已保存方法与来源（{methods.length}）</summary><ul className="mt-2 space-y-2">{methods.map((method) => <li key={method.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{method.name} · 来源工作：{method.workTemplate!.sourceWorkId}</span><button type="button" onClick={() => { useRoutines.getState().removeRoutine(method.id); if (methodId === method.id) setMode('closed'); }} className="shrink-0 text-danger hover:underline">删除方法 {method.name}</button></li>)}</ul></details>}
    {mode !== 'closed' && <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-2">
      {mode === 'use' && <label className="block">已保存方法<select aria-label="已保存方法" className="ml-2 rounded border border-line bg-surface-4 p-1" value={methodId} onChange={(e) => setMethodId(e.target.value)}>{methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      <label className="block">{mode === 'save' ? '方法名称' : '新工作名称'}<input aria-label={mode === 'save' ? '方法名称' : '新工作名称'} required value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
      <label className="block">{mode === 'save' ? '输入及来源说明' : '本次输入及来源'}<textarea aria-label={mode === 'save' ? '输入及来源说明' : '本次输入及来源'} required value={inputs} onChange={(e) => setInputs(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
      {mode === 'save' && <>
        <label className="block">可复用步骤<textarea aria-label="可复用步骤" required value={steps} onChange={(e) => setSteps(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
        <label className="block">失败处理<textarea aria-label="失败处理" required value={failure} onChange={(e) => setFailure(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
      </>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <button type="submit" disabled={busy} className="rounded bg-primary px-3 py-1.5 text-white disabled:opacity-50">{busy ? '处理中…' : mode === 'save' ? '保存方法' : '创建新工作'}</button>
      <button type="button" disabled={busy} onClick={() => setMode('closed')} className="ml-2 text-ink-3">取消</button>
    </form>}
  </section>;
}
