import { MessageSquarePlus } from 'lucide-react';
import { butlerRecapAgoLabel, useButler } from '../stores/butler';
import type { HostedConversationProjection } from '../agent/hostedConversation';

export default function ButlerConversationHistory({
  hostedConversations = [],
  selectedHostedId,
  onSelectHosted,
  onSelectButler,
  onNewConversation,
}: {
  hostedConversations?: HostedConversationProjection[];
  selectedHostedId?: string | null;
  onSelectHosted?: (id: string) => void;
  onSelectButler?: () => void;
  onNewConversation?: () => void;
}) {
  const sessions = useButler((state) => state.sessions);
  const activeSessionId = useButler((state) => state.activeSessionId);
  const running = useButler((state) => state.running);
  const newConversation = useButler((state) => state.newConversation);
  const switchSession = useButler((state) => state.switchSession);
  const entries = [
    ...sessions.map((session) => ({ kind: 'butler' as const, ...session })),
    ...hostedConversations.map((conversation) => ({
      kind: 'hosted' as const,
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      lastAsk: `AI 托管 · ${conversation.preview}`,
    })),
  ].sort((left, right) => right.updatedAt - left.updatedAt);

  return (
    <aside className="butler-conversation-history" aria-label="对话历史">
      <header>
        <div>
          <h2>对话历史</h2>
          <span>{entries.length} 个会话</span>
        </div>
        <button
          type="button"
          onClick={() => {
            onNewConversation?.();
            void newConversation();
          }}
          disabled={running}
          aria-label="新对话"
        >
          <MessageSquarePlus size={15} aria-hidden="true" />
          新对话
        </button>
      </header>

      <nav aria-label="管家对话历史">
        <ul>
          {entries.map((session) => {
            const selected = session.kind === 'hosted'
              ? session.id === selectedHostedId
              : !selectedHostedId && session.id === activeSessionId;
            return (
            <li key={`${session.kind}:${session.id}`}>
              <button
                type="button"
                onClick={() => {
                  if (session.kind === 'hosted') {
                    onSelectHosted?.(session.id);
                    return;
                  }
                  onSelectButler?.();
                  void switchSession(session.id);
                }}
                disabled={running}
                aria-current={selected ? 'page' : undefined}
              >
                <span className="butler-conversation-history-title">{session.title}</span>
                <span className="butler-conversation-history-preview">
                  {session.lastAsk || '还没有消息'}
                </span>
                <time dateTime={new Date(session.updatedAt).toISOString()}>
                  {butlerRecapAgoLabel(session.updatedAt)}
                </time>
              </button>
            </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
