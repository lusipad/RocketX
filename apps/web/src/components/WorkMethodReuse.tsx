import { useState } from 'react';
import { useT } from '../i18n';
import { createWorkFromSavedMethod, saveVerifiedWorkAsRoutine } from '../agent/workMethods';
import { evaluateCardCompletionGate } from '../agent/workCoordinator';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useRoutines } from '../stores/routines';
import { toast } from '../stores/toast';
import { useWorkLedger } from '../stores/workLedger';

export default function WorkMethodReuse({ workId, projectKey, workspaceRoot, onSelectWork }: {
  workId?: string | null; projectKey?: string | null; workspaceRoot?: string | null; onSelectWork?: (workId: string) => void;
}) {
  const t = useT();
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
        toast.success(t('agent.methodReuse.savedSuccess'));
      } else {
        const created = await createWorkFromSavedMethod(methodId, name, inputs, { projectKey, workspaceRoot });
        onSelectWork?.(created.id);
        toast.success(t('agent.methodReuse.createdSuccess'));
      }
      setMode('closed');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section aria-label={t('agent.methodReuse.title')} className="space-y-2 rounded-xl border border-line p-3 text-xs">
    <strong className="text-ink">{t('agent.methodReuse.title')}</strong>
    <p className="text-ink-3">{t('agent.methodReuse.desc')}</p>
    <div className="flex flex-wrap gap-2">
      {canSave && <button type="button" onClick={() => { setMode('save'); setName(card?.title ?? ''); setError(''); }} className="text-primary hover:underline">{t('agent.methodReuse.saveTemplateBtn')}</button>}
      {methods.length > 0 && <button type="button" onClick={() => { setMode('use'); setMethodId(methods[0].id); setName(''); setInputs(''); setError(''); }} className="text-primary hover:underline">{t('agent.methodReuse.createFromMethodBtn')}</button>}
      {!canSave && methods.length === 0 && <span className="text-ink-3">{t('agent.methodReuse.emptyHint')}</span>}
    </div>
    {methods.length > 0 && <details className="text-ink-3"><summary className="cursor-pointer">{t('agent.methodReuse.savedSummary', { count: methods.length })}</summary><ul className="mt-2 space-y-2">{methods.map((method) => <li key={method.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{t('agent.methodReuse.sourceWorkLine', { name: method.name, sourceWorkId: method.workTemplate!.sourceWorkId })}</span><button type="button" onClick={() => { useRoutines.getState().removeRoutine(method.id); if (methodId === method.id) setMode('closed'); }} className="shrink-0 text-danger hover:underline">{t('agent.methodReuse.deleteMethodAria', { name: method.name })}</button></li>)}</ul></details>}
    {mode !== 'closed' && <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-2">
      {mode === 'use' && <label className="block">{t('agent.methodReuse.savedMethodLabel')}<select aria-label={t('agent.methodReuse.savedMethodLabel')} className="ml-2 rounded border border-line bg-surface-4 p-1" value={methodId} onChange={(e) => setMethodId(e.target.value)}>{methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      <label className="block">{mode === 'save' ? t('agent.methodReuse.methodNameLabel') : t('agent.methodReuse.newWorkNameLabel')}<input aria-label={mode === 'save' ? t('agent.methodReuse.methodNameLabel') : t('agent.methodReuse.newWorkNameLabel')} required value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
      <label className="block">{mode === 'save' ? t('agent.methodReuse.inputsSaveLabel') : t('agent.methodReuse.inputsUseLabel')}<textarea aria-label={mode === 'save' ? t('agent.methodReuse.inputsSaveLabel') : t('agent.methodReuse.inputsUseLabel')} required value={inputs} onChange={(e) => setInputs(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
      {mode === 'save' && <>
        <label className="block">{t('agent.methodReuse.reusableStepsLabel')}<textarea aria-label={t('agent.methodReuse.reusableStepsLabel')} required value={steps} onChange={(e) => setSteps(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
        <label className="block">{t('agent.methodReuse.failureHandlingLabel')}<textarea aria-label={t('agent.methodReuse.failureHandlingLabel')} required value={failure} onChange={(e) => setFailure(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface-4 p-2" /></label>
      </>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <button type="submit" disabled={busy} className="rounded bg-primary px-3 py-1.5 text-white disabled:opacity-50">{busy ? t('agent.methodReuse.submitting') : mode === 'save' ? t('agent.methodReuse.submitSave') : t('agent.methodReuse.submitCreate')}</button>
      <button type="button" disabled={busy} onClick={() => setMode('closed')} className="ml-2 text-ink-3">{t('common.cancel')}</button>
    </form>}
  </section>;
}
