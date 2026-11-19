import { useState } from 'react';
import type { AgentComposerRequest, ComposerDraft } from '../stores/agentComposerDrafts';

export default function AgentComposerFeedback({ draft, onRetry }: {
  draft: ComposerDraft;
  onRetry: (request: AgentComposerRequest) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-2 text-xs">
      {draft.saveError ? <p role="alert" className="text-danger">{draft.saveError}</p> : null}
      {draft.pending ? <p role="status" className="text-ink-3">正在发送到原会话，可继续填写下一条要求。</p> : null}
      {draft.failed.map((request) => (
        <div key={request.id} role="alert" className="rounded-lg border border-line p-2">
          <p>发送未完成：{request.error}</p>
          {request.requiresVerification ? <p className="text-ink-3">执行器可能已经收到要求。请先核对原会话，避免重复执行。</p> : null}
          <p className="whitespace-pre-wrap break-words text-ink-2">{request.text}</p>
          {request.images.length ? <p className="text-ink-3">附件：{request.images.map((image) => image.name).join('、')}</p> : null}
          {request.requiresVerification ? <label className="mt-1 flex items-center gap-1"><input type="checkbox" checked={Boolean(checked[request.id])} onChange={(event) => setChecked((current) => ({ ...current, [request.id]: event.target.checked }))} />已核对原会话，可以重发</label> : null}
          <button type="button" disabled={Boolean(draft.pending) || (request.requiresVerification && !checked[request.id])} onClick={() => {
            setChecked((current) => ({ ...current, [request.id]: false }));
            onRetry(request);
          }} className="mt-1 text-primary disabled:opacity-50">重试原请求</button>
        </div>
      ))}
    </div>
  );
}
