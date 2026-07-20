import { ExternalLink } from 'lucide-react';
import type { ButlerSource } from '../lib/butlerContext';
import { openExternal } from '../lib/client';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';

async function openSource(source: ButlerSource): Promise<void> {
  const ui = useUI.getState();
  if (source.kind === 'message' && source.rid && source.mid) {
    ui.setModule('messages');
    await useChat.getState().jumpToMessage(source.mid, source.rid);
    return;
  }
  if (source.kind === 'room' && source.rid) {
    ui.setModule('messages');
    await useChat.getState().openRoom(source.rid);
    return;
  }
  if (source.kind === 'todo') {
    ui.setModule('todos');
    return;
  }
  if (source.kind === 'calendar') {
    ui.setModule('calendar');
    return;
  }
  if (source.webUrl) {
    await openExternal(source.webUrl);
    return;
  }
  if (source.kind === 'work-item') ui.setWorkbenchTab('workitems');
  if (source.kind === 'pull-request') ui.setWorkbenchTab('prs');
  if (source.kind === 'build') ui.setWorkbenchTab('builds');
  ui.setModule('workbench');
}

export default function ButlerSources({ sources }: { sources?: ButlerSource[] }) {
  if (!sources?.length) return null;
  return (
    <div className="mt-2 flex max-w-full flex-wrap gap-1.5" aria-label="回答来源">
      {sources.map((source) => (
        <button
          key={`${source.kind}:${source.id}`}
          type="button"
          title={`打开来源：${source.label}`}
          onClick={() => void openSource(source)}
          className="flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-left text-2xs text-ink-2 hover:border-primary/40 hover:text-primary"
        >
          <ExternalLink size={10} className="shrink-0" />
          <span className="truncate">{source.label}</span>
        </button>
      ))}
    </div>
  );
}
