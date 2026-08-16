import { Bot, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HostedSessionItem } from '../lib/hostedSessions';
import { renderMarkdownDoc } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import type { CodexWorkspaceMessage } from '../stores/codexWorkspace';
import { useSharedAgent } from '../stores/sharedAgent';
import ButlerSources from './ButlerSources';
import { CodexGeneratedImages, CodexImageAttachments } from './CodexImagePicker';

export type HostedTranscriptStatus = 'idle' | 'loading' | 'ready' | 'remote' | 'error';

function sameTranscript(
  current: readonly CodexWorkspaceMessage[],
  next: readonly CodexWorkspaceMessage[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((message, index) => JSON.stringify(message) === JSON.stringify(next[index]));
}

export function useHostedTranscript(session: HostedSessionItem | undefined) {
  const readTranscript = useSharedAgent((state) => state.readTranscript);
  const [messages, setMessages] = useState<CodexWorkspaceMessage[]>([]);
  const [status, setStatus] = useState<HostedTranscriptStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const identityRef = useRef<string | null>(null);
  const readIdentityRef = useRef<string | null>(null);
  const readPromiseRef = useRef<Promise<CodexWorkspaceMessage[]> | null>(null);
  const identity = session
    ? `${session.key}\u0000${session.local?.sessionId ?? session.remote?.sessionId ?? 'unbound'}`
    : null;

  useEffect(() => {
    const identityChanged = identityRef.current !== identity;
    identityRef.current = identity;
    if (!session) {
      if (identityChanged) setMessages([]);
      setStatus('idle');
      setError(null);
      return;
    }
    if (!session.local) {
      if (identityChanged) setMessages([]);
      setStatus('remote');
      setError(null);
      return;
    }
    const waitingForHandle = session.status === 'starting' && (
      session.backend === 'deepseek' ? !session.local.dshSessionId : !session.local.codexThreadId
    );
    if (waitingForHandle) {
      if (identityChanged) setMessages([]);
      setStatus('loading');
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let showInitialLoading = identityChanged;
    const active = ['starting', 'running', 'waiting-approval'].includes(session.status);
    const schedule = (): void => {
      if (!cancelled && active) timer = window.setTimeout(() => void load(), 1_800);
    };
    const load = async (): Promise<void> => {
      if (showInitialLoading) {
        showInitialLoading = false;
        setMessages([]);
        setStatus('loading');
        setError(null);
      }
      try {
        if (!readPromiseRef.current || readIdentityRef.current !== identity) {
          readIdentityRef.current = identity;
          const pending = readTranscript(session.key);
          readPromiseRef.current = pending;
          void pending.finally(() => {
            if (readPromiseRef.current === pending) {
              readPromiseRef.current = null;
              readIdentityRef.current = null;
            }
          }).catch(() => undefined);
        }
        const next = await readPromiseRef.current;
        if (cancelled) return;
        setMessages((current) => sameTranscript(current, next) ? current : next);
        setStatus('ready');
        setError(null);
      } catch (reason) {
        if (cancelled) return;
        setStatus('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        schedule();
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    identity,
    readTranscript,
    refreshVersion,
    session?.key,
    session?.status,
    session?.local?.codexThreadId,
    session?.local?.dshSessionId,
    session?.remote?.hostDeviceId,
  ]);

  return {
    messages,
    status,
    error,
    refresh: () => setRefreshVersion((current) => current + 1),
  };
}

export function HostedConversationTranscript({
  session,
  messages,
  status,
  error,
  onRefresh,
  onOpenRoom,
}: {
  session: HostedSessionItem;
  messages: readonly CodexWorkspaceMessage[];
  status: HostedTranscriptStatus;
  error: string | null;
  onRefresh: () => void;
  onOpenRoom?: () => void;
}) {
  const backendName = session.backend === 'deepseek' ? 'DeepSeek' : 'Codex';
  const active = ['starting', 'running', 'waiting-approval'].includes(session.status);
  const { scrollRef, onScroll } = useStickToBottom([session.key, messages]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="codex-native-transcript">
      <div className="codex-native-transcript-inner" aria-live="polite">
        {status === 'loading' ? (
          <div className="codex-native-landing" role="status">
            <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <p>{session.status === 'starting'
              ? `正在启动 ${backendName} Harness 会话…`
              : `正在读取 ${backendName} Harness 会话…`}</p>
          </div>
        ) : status === 'remote' ? (
          <div className="codex-native-landing">
            <Bot size={22} aria-hidden="true" />
            <h2>{session.status === 'interrupted' ? '宿主会话当前不可用' : '会话在宿主设备上运行'}</h2>
            <p>{session.status === 'interrupted'
              ? `@${session.remote?.hostUsername} 的宿主租约已中断或过期；打开房间可查看已共享结果，并在托管设置中接管。`
              : `当前设备不能直接读取 @${session.remote?.hostUsername} 本机的 Harness 历史；打开房间可以查看已经共享的结果。`}</p>
            {onOpenRoom ? (
              <button type="button" onClick={onOpenRoom}>
                <ExternalLink size={14} aria-hidden="true" /> 打开房间
              </button>
            ) : null}
          </div>
        ) : status === 'error' ? (
          <div className="codex-native-landing is-error" role="alert">
            <Bot size={22} aria-hidden="true" />
            <h2>Harness 历史读取失败</h2>
            <p>{error}</p>
            <div>
              <button type="button" onClick={onRefresh}>
                <RefreshCw size={14} aria-hidden="true" /> 重试
              </button>
              {onOpenRoom ? (
                <button type="button" onClick={onOpenRoom}>
                  <ExternalLink size={14} aria-hidden="true" /> 打开房间
                </button>
              ) : null}
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="codex-native-landing">
            <Bot size={22} aria-hidden="true" />
            <h2>Harness 会话还没有对话内容</h2>
            <p>房间中的下一条 @ai 指令会继续写入这条托管 session。</p>
          </div>
        ) : (
          <>
            {messages.map((entry) => (
              <article
                key={entry.id}
                data-speaker={entry.role}
                className={`codex-native-message${entry.pending ? ' is-streaming' : ''}`}
              >
                <span>{entry.role === 'assistant' ? backendName : entry.speaker || '房间成员'}</span>
                <div className="butler-conversation-markdown">
                  {entry.text
                    ? entry.role === 'assistant' && !entry.pending
                      ? (
                          <ButlerSources sources={entry.sources} text={entry.text}>
                            {(renderLink) => renderMarkdownDoc(entry.text, undefined, renderLink)}
                          </ButlerSources>
                        )
                      : entry.text
                    : null}
                  <CodexImageAttachments attachments={entry.attachments} />
                  <CodexGeneratedImages images={entry.generatedImages} />
                </div>
              </article>
            ))}
            {active && !messages.some((message) => message.pending) ? (
              <article data-speaker="assistant" className="codex-native-message is-streaming" role="status">
                <span>{backendName}</span>
                <div className="flex items-center gap-2 text-ink-3">
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  正在处理房间任务…
                </div>
              </article>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
