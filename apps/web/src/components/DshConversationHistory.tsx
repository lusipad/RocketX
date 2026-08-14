import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Loader2, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { isTauriRuntime } from '../lib/client';
import { useDshWorkspace, type DshSession } from '../stores/dshWorkspace';
import { toast } from '../stores/toast';
import { ageLabel, workspaceLabel } from './DshConversationShared';

function sessionTitle(session: DshSession): string {
  return session.title?.trim() || session.preview?.trim() || '新会话';
}

async function chooseWorkspaceDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error('网页版没有本地 DeepSeek 执行面，请使用 RocketX 桌面端');
  const path = await open({ directory: true, multiple: false, title: '选择 DeepSeek 工作区' });
  return typeof path === 'string' ? path : null;
}

export default function DshConversationHistory({ onNavigate }: { onNavigate?: () => void }) {
  const status = useDshWorkspace((state) => state.status);
  const workspaceRoot = useDshWorkspace((state) => state.workspaceRoot);
  const sessions = useDshWorkspace((state) => state.sessions);
  const activeSessionId = useDshWorkspace((state) => state.activeSessionId);
  const pendingApproval = useDshWorkspace((state) => state.pendingApproval);
  const pendingQuestion = useDshWorkspace((state) => state.pendingQuestion);
  const setWorkspaceRoot = useDshWorkspace((state) => state.setWorkspaceRoot);
  const connect = useDshWorkspace((state) => state.connect);
  const refresh = useDshWorkspace((state) => state.refresh);
  const startSession = useDshWorkspace((state) => state.startSession);
  const openSession = useDshWorkspace((state) => state.openSession);
  const [query, setQuery] = useState('');

  const visibleSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return sessions;
    return sessions.filter((session) => (
      `${session.title ?? ''}\n${session.preview ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalized)
    ));
  }, [query, sessions]);

  const chooseWorkspace = async (): Promise<void> => {
    try {
      const path = await chooseWorkspaceDirectory();
      if (!path) return;
      await setWorkspaceRoot(path);
      await connect();
    } catch (error) {
      toast.error(error, '无法设置 DeepSeek 工作区');
    }
  };

  return (
    <aside className="dsh-conversation-history" aria-label="DeepSeek 会话列表">
      <header>
        <div>
          <strong>DeepSeek</strong>
          <span>{workspaceRoot ? workspaceLabel(workspaceRoot) : '未选择工作区'}</span>
        </div>
        <button type="button" onClick={() => void startSession().then(() => onNavigate?.()).catch((error) => toast.error(error, '无法新建会话'))} disabled={!workspaceRoot || status !== 'ready'}>
          <MessageSquarePlus size={15} aria-hidden="true" />
          新会话
        </button>
        <div className="dsh-history-toolbar">
          <label className="dsh-history-search">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话"
              aria-label="搜索 DeepSeek 会话"
            />
          </label>
          <button type="button" aria-label="选择工作区" onClick={() => void chooseWorkspace()}>
            <FolderOpen size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="刷新会话"
            disabled={!workspaceRoot || status === 'connecting'}
            onClick={() => void refresh().catch((error) => toast.error(error, '无法刷新会话'))}
          >
            {status === 'connecting'
              ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <RefreshCw size={14} aria-hidden="true" />}
          </button>
        </div>
      </header>

      {workspaceRoot ? <p className="dsh-history-path" title={workspaceRoot}>{workspaceRoot}</p> : null}

      {pendingApproval || pendingQuestion ? (
        <section className="dsh-history-pending" aria-label="待处理交互">
          <strong>待处理</strong>
          <ul>
            {pendingApproval ? <li>{pendingApproval.reason || `审批：${pendingApproval.toolName}`}</li> : null}
            {pendingQuestion ? <li>{pendingQuestion.questions[0]?.question || '等待回答'}</li> : null}
          </ul>
        </section>
      ) : null}

      <nav aria-label="DeepSeek 历史">
        <ul>
          {visibleSessions.map((session) => {
            const running = session.status === 'running';
            return (
              <li key={session.id}>
                <button
                  type="button"
                  disabled={status !== 'ready'}
                  aria-current={session.id === activeSessionId ? 'page' : undefined}
                  onClick={() => void openSession(session.id).then(() => onNavigate?.()).catch((error) => toast.error(error, '无法打开会话'))}
                >
                  <span className={`dsh-history-status${running ? ' is-running' : ''}`} aria-hidden="true" />
                  <span className="butler-conversation-history-title">{sessionTitle(session)}</span>
                  <time dateTime={new Date(session.updatedAt).toISOString()}>{ageLabel(session.updatedAt)}</time>
                  {session.preview ? <small>{session.preview}</small> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {visibleSessions.length === 0 ? (
          <p className="dsh-history-empty">{workspaceRoot ? '还没有 DeepSeek 会话' : '请先选择工作区'}</p>
        ) : null}
      </nav>
    </aside>
  );
}
