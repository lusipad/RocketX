import { useState } from 'react';
import { tr, useUiLocale } from '../lib/uiLocale';
import type { AgentComposerRequest, ComposerDraft } from '../stores/agentComposerDrafts';

export default function AgentComposerFeedback({ draft, onRetry }: {
  draft: ComposerDraft;
  onRetry: (request: AgentComposerRequest) => void;
}) {
  const locale = useUiLocale();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-2 text-xs">
      {draft.saveError ? <p role="alert" className="text-danger">{draft.saveError}</p> : null}
      {draft.pending ? <p role="status" className="text-ink-3">{tr('正在发送到原会话，可继续填写下一条要求。', 'Sending to conversation… you can keep composing.', locale)}</p> : null}
      {draft.failed.map((request) => (
        <div key={request.id} role="alert" className="rounded-lg border border-line p-2">
          <p>{tr(`发送未完成：${request.error}`, `Delivery incomplete: ${request.error}`, locale)}</p>
          {request.requiresVerification ? <p className="text-ink-3">{tr('执行器可能已经收到要求。请先核对原会话，避免重复执行。', 'The runtime may have received this request. Check the conversation before resending.', locale)}</p> : null}
          <p className="whitespace-pre-wrap break-words text-ink-2">{request.text}</p>
          {request.images.length ? <p className="text-ink-3">{tr('附件：', 'Attachments: ', locale)}{request.images.map((image) => image.name).join(locale === 'zh' ? '、' : ', ')}</p> : null}
          {request.requiresVerification ? <label className="mt-1 flex items-center gap-1"><input type="checkbox" checked={Boolean(checked[request.id])} onChange={(event) => setChecked((current) => ({ ...current, [request.id]: event.target.checked }))} />{tr('已核对原会话，可以重发', 'Verified conversation, ready to resend', locale)}</label> : null}
          <button type="button" disabled={Boolean(draft.pending) || (request.requiresVerification && !checked[request.id])} onClick={() => {
            setChecked((current) => ({ ...current, [request.id]: false }));
            onRetry(request);
          }} className="mt-1 text-primary disabled:opacity-50">{tr('重试原请求', 'Retry request', locale)}</button>
        </div>
      ))}
    </div>
  );
}
