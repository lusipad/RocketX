import { useState } from 'react';
import { useT } from '../i18n';
import type { AgentComposerRequest, ComposerDraft } from '../stores/agentComposerDrafts';

export default function AgentComposerFeedback({ draft, onRetry }: {
  draft: ComposerDraft;
  onRetry: (request: AgentComposerRequest) => void;
}) {
  const t = useT();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-2 text-xs">
      {draft.saveError ? <p role="alert" className="text-danger">{draft.saveError}</p> : null}
      {draft.pending ? <p role="status" className="text-ink-3">{t('agent.composerFeedback.sending')}</p> : null}
      {draft.failed.map((request) => (
        <div key={request.id} role="alert" className="rounded-lg border border-line p-2">
          <p>{t('agent.composerFeedback.sendIncomplete', { error: request.error ?? '' })}</p>
          {request.requiresVerification ? <p className="text-ink-3">{t('agent.composerFeedback.verifyHint')}</p> : null}
          <p className="whitespace-pre-wrap break-words text-ink-2">{request.text}</p>
          {request.images.length ? <p className="text-ink-3">{t('agent.composerFeedback.attachments', { names: request.images.map((image) => image.name).join(t('agent.common.listSep')) })}</p> : null}
          {request.requiresVerification ? <label className="mt-1 flex items-center gap-1"><input type="checkbox" checked={Boolean(checked[request.id])} onChange={(event) => setChecked((current) => ({ ...current, [request.id]: event.target.checked }))} />{t('agent.composerFeedback.verifiedCheckbox')}</label> : null}
          <button type="button" disabled={Boolean(draft.pending) || (request.requiresVerification && !checked[request.id])} onClick={() => {
            setChecked((current) => ({ ...current, [request.id]: false }));
            onRetry(request);
          }} className="mt-1 text-primary disabled:opacity-50">{t('agent.composerFeedback.retryOriginal')}</button>
        </div>
      ))}
    </div>
  );
}
