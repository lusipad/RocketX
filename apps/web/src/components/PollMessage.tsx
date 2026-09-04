import type { RcMessage, RcUiKitBlock, RcUiKitElement } from '@rcx/rc-client';
import { uiKitText } from '../lib/uikit';

export function PollMessage({
  message,
  onVote,
}: {
  message: RcMessage;
  onVote: (block: RcUiKitBlock, element: RcUiKitElement) => void | Promise<void>;
}) {
  return (
    <div className="w-full min-w-72 space-y-2 rounded-lg border border-line bg-surface-4 p-3">
      {(message.blocks ?? []).map((block, index) => {
        if (block.type === 'divider') {
          return <hr key={`divider-${index}`} className="border-line" />;
        }
        if (block.type === 'context') {
          return (
            <div key={block.blockId ?? `context-${index}`} className="space-y-1 text-xs text-ink-3">
              {(block.elements ?? []).map((element, elementIndex) => (
                <div key={elementIndex}>{uiKitText(element)}</div>
              ))}
            </div>
          );
        }
        if (block.type !== 'section') return null;
        const accessory = block.accessory;
        return (
          <div
            key={block.blockId ?? `section-${index}`}
            className="flex items-center justify-between gap-3"
          >
            <div className={index === 0 ? 'font-medium text-ink' : 'text-sm text-ink-2'}>
              {uiKitText(block.text)}
            </div>
            {accessory?.type === 'button' && accessory.actionId === 'vote' ? (
              <button
                type="button"
                onClick={() => void onVote(block, accessory)}
                className="shrink-0 rounded-md border border-primary px-3 py-1 text-xs text-primary transition hover:bg-primary/10"
              >
                {uiKitText(accessory.text) || '投票'}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
