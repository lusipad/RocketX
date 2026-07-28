import { MessageSquarePlus } from 'lucide-react';
import { butlerRecapAgoLabel, useButler } from '../stores/butler';

export default function ButlerConversationHistory() {
  const sessions = useButler((state) => state.sessions);
  const activeSessionId = useButler((state) => state.activeSessionId);
  const running = useButler((state) => state.running);
  const newConversation = useButler((state) => state.newConversation);
  const switchSession = useButler((state) => state.switchSession);

  return (
    <aside className="butler-conversation-history" aria-label="对话历史">
      <header>
        <div>
          <h2>对话历史</h2>
          <span>{sessions.length} 个会话</span>
        </div>
        <button
          type="button"
          onClick={() => void newConversation()}
          disabled={running}
          aria-label="新对话"
        >
          <MessageSquarePlus size={15} aria-hidden="true" />
          新对话
        </button>
      </header>

      <nav aria-label="管家对话历史">
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => void switchSession(session.id)}
                disabled={running}
                aria-current={session.id === activeSessionId ? 'page' : undefined}
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
          ))}
        </ul>
      </nav>
    </aside>
  );
}
