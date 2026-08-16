import { CircleAlert, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentBackend } from '../agent/session';
import { DshController } from '../agent/dsh/DshController';
import { isTauriRuntime } from '../lib/client';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useSharedAgent } from '../stores/sharedAgent';
import { useUI } from '../stores/ui';

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function normalizeWorkspaceRoot(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

async function resolveWorkspaceRoot(): Promise<string> {
  const workspace = useCodexWorkspace.getState();
  await workspace.ensureDefaultWorkspace();
  const latest = useCodexWorkspace.getState();
  return normalizeWorkspaceRoot(latest.butlerWorkspaceRoot) || normalizeWorkspaceRoot(latest.defaultWorkspaceRoot);
}

type DshFrameRequest =
  | { requestId: string; type: 'rocketx:dsh-open-new-session'; workspacePath: string }
  | { requestId: string; type: 'rocketx:dsh-focus-session'; sessionId: string };

type DshFrameResponse =
  | { requestId: string; type: 'rocketx:dsh-ack' }
  | { requestId: string; type: 'rocketx:dsh-error'; error?: string };

const DSH_FRAME_REQUEST_TIMEOUT_MS = 12_000;

export default function DshConversation() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [error, setError] = useState('');
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [bootComplete, setBootComplete] = useState(false);
  const [frameNotice, setFrameNotice] = useState<{ kind: 'working' | 'error' | 'success'; text: string } | null>(null);
  const [bootNonce, setBootNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastFocusedSessionIdRef = useRef<string | null>(null);
  const frameNoticeTimerRef = useRef<number | null>(null);
  const selectedHostedSessionKey = useUI((state) => state.selectedHostedSessionKey);
  const selectedPersonalDshSessionId = useUI((state) => state.selectedPersonalDshSessionId);
  const selectedPersonalDshFocusNonce = useUI((state) => state.selectedPersonalDshFocusNonce);
  const hostedSessionsByKey = useSharedAgent((state) => state.sessions);
  const desktopRuntime = isTauriRuntime();
  const selectedHostedSession = selectedHostedSessionKey
    ? hostedSessionsByKey[selectedHostedSessionKey]
    : undefined;
  const focusTarget = useMemo(() => {
    if (selectedPersonalDshSessionId) {
      return {
        requestKey: `personal:${selectedPersonalDshSessionId}:${selectedPersonalDshFocusNonce}`,
        sessionId: selectedPersonalDshSessionId,
      };
    }
    if (!selectedHostedSession || agentBackend(selectedHostedSession) !== 'deepseek') return null;
    const sessionId = selectedHostedSession.dshSessionId ?? null;
    if (!sessionId) return null;
    return {
      requestKey: `hosted:${sessionId}`,
      sessionId,
    };
  }, [selectedHostedSession, selectedPersonalDshFocusNonce, selectedPersonalDshSessionId]);
  const focusSessionId = focusTarget?.sessionId ?? null;
  const focusRequestKey = focusTarget?.requestKey ?? null;
  const focusUnavailableMessage = useMemo(() => {
    if (!selectedHostedSessionKey || selectedPersonalDshSessionId || focusSessionId) return null;
    if (!selectedHostedSession) {
      return '找不到这条托管会话，DSH 不会新建另一条会话；请回到房间侧栏确认状态。';
    }
    if (agentBackend(selectedHostedSession) !== 'deepseek') {
      return '这条托管会话由 Codex 运行，DSH 不会新建另一条会话；请切换到 Codex 后打开。';
    }
    return '这条 DSH 托管会话不在当前设备或尚未建立，DSH 不会新建另一条会话；请回到房间侧栏查看或恢复。';
  }, [focusSessionId, selectedHostedSession, selectedHostedSessionKey, selectedPersonalDshSessionId]);
  const targetOrigin = useMemo(() => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }, [url]);

  const replaceFrameNotice = (notice: { kind: 'working' | 'error' | 'success'; text: string } | null, ttlMs?: number) => {
    if (frameNoticeTimerRef.current !== null) {
      window.clearTimeout(frameNoticeTimerRef.current);
      frameNoticeTimerRef.current = null;
    }
    setFrameNotice(notice);
    if (notice && ttlMs) {
      frameNoticeTimerRef.current = window.setTimeout(() => {
        frameNoticeTimerRef.current = null;
        setFrameNotice(null);
      }, ttlMs);
    }
  };

  const postFrameRequest = async (request: DshFrameRequest): Promise<void> => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || !targetOrigin) throw new Error('DSH 原生会话尚未就绪');
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('DSH 原生会话未响应'));
      }, DSH_FRAME_REQUEST_TIMEOUT_MS);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== frameWindow || event.origin !== targetOrigin) return;
        const data = event.data as DshFrameResponse | null;
        if (!data || typeof data !== 'object' || data.requestId !== request.requestId) return;
        if (data.type !== 'rocketx:dsh-ack' && data.type !== 'rocketx:dsh-error') return;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (data.type === 'rocketx:dsh-error') {
          reject(new Error(data.error || 'DSH 原生会话拒绝了请求'));
          return;
        }
        resolve();
      };
      window.addEventListener('message', onMessage);
      frameWindow.postMessage(request, targetOrigin);
    });
  };

  useEffect(() => {
    if (focusRequestKey) return;
    lastFocusedSessionIdRef.current = null;
  }, [focusRequestKey]);

  useEffect(() => {
    if (!desktopRuntime) return;

    let disposed = false;
    let activeController: DshController | null = null;

    setStatus('loading');
    setUrl('');
    setError('');
    setFrameLoaded(false);
    setBootComplete(false);
    replaceFrameNotice(null);

    void (async () => {
      try {
        const nextWorkspaceRoot = await resolveWorkspaceRoot();
        if (!nextWorkspaceRoot) throw new Error('未找到可用的 DSH 工作区');
        if (disposed) return;

        setWorkspaceRoot(nextWorkspaceRoot);
        activeController = new DshController(
          nextWorkspaceRoot,
          {
            onMux: () => undefined,
            onHost: () => undefined,
            onError: (reason) => {
              if (disposed) return;
              setError(reason.message);
              setStatus('error');
            },
            onExit: (code) => {
              if (disposed) return;
              setError(code === null ? 'DSH Web 已退出' : `DSH Web 已退出（${code}）`);
              setStatus('error');
            },
          },
          undefined,
          { connectionId: 'butler-web', mode: 'web' },
        );
        const nextUrl = await activeController.start();
        if (disposed) {
          await activeController.stop().catch(() => undefined);
          return;
        }
        setUrl(nextUrl);
        setStatus('ready');
      } catch (reason) {
        if (disposed) return;
        setError(errorMessage(reason));
        setStatus('error');
      }
    })();

    return () => {
      disposed = true;
      if (frameNoticeTimerRef.current !== null) {
        window.clearTimeout(frameNoticeTimerRef.current);
        frameNoticeTimerRef.current = null;
      }
      void activeController?.stop().catch(() => undefined);
    };
  }, [attempt, desktopRuntime]);

  useEffect(() => {
    if (!desktopRuntime || !frameLoaded || status !== 'ready' || !url) return;
    let cancelled = false;
    setBootComplete(false);
    if (selectedHostedSessionKey && !selectedPersonalDshSessionId && !focusSessionId) {
      replaceFrameNotice({ kind: 'error', text: focusUnavailableMessage ?? '当前托管会话无法在 DSH 中打开。' });
      setBootComplete(true);
      return;
    }
    void (async () => {
      try {
        replaceFrameNotice({
          kind: 'working',
          text: focusSessionId
            ? selectedPersonalDshSessionId
              ? '正在定位你的私人房间会话…'
              : '正在定位当前房间的托管会话…'
            : '正在打开新的 DSH 原生会话…',
        });
        if (focusSessionId) {
          await postFrameRequest({
            requestId: crypto.randomUUID(),
            type: 'rocketx:dsh-focus-session',
            sessionId: focusSessionId,
          });
          if (cancelled) return;
          lastFocusedSessionIdRef.current = focusRequestKey;
          replaceFrameNotice({
            kind: 'success',
            text: selectedPersonalDshSessionId ? '已打开你的私人房间会话。' : '已定位到当前房间的托管会话。',
          }, 2_500);
        } else {
          await postFrameRequest({
            requestId: crypto.randomUUID(),
            type: 'rocketx:dsh-open-new-session',
            workspacePath: workspaceRoot,
          });
          if (cancelled) return;
          lastFocusedSessionIdRef.current = null;
          replaceFrameNotice(null);
        }
      } catch (reason) {
        if (cancelled) return;
        replaceFrameNotice({ kind: 'error', text: errorMessage(reason) });
      } finally {
        if (!cancelled) setBootComplete(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    bootNonce,
    desktopRuntime,
    focusSessionId,
    focusUnavailableMessage,
    frameLoaded,
    selectedHostedSessionKey,
    selectedPersonalDshSessionId,
    status,
    targetOrigin,
    url,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!bootComplete || !frameLoaded || status !== 'ready' || !focusSessionId || !focusRequestKey) return;
    if (focusRequestKey === lastFocusedSessionIdRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        replaceFrameNotice({
          kind: 'working',
          text: selectedPersonalDshSessionId ? '正在切换到你的私人房间会话…' : '正在切换到当前房间的托管会话…',
        });
        await postFrameRequest({
          requestId: crypto.randomUUID(),
          type: 'rocketx:dsh-focus-session',
          sessionId: focusSessionId,
        });
        if (cancelled) return;
        lastFocusedSessionIdRef.current = focusRequestKey;
        replaceFrameNotice({
          kind: 'success',
          text: selectedPersonalDshSessionId ? '已打开你的私人房间会话。' : '已定位到当前房间的托管会话。',
        }, 2_500);
      } catch (reason) {
        if (cancelled) return;
        replaceFrameNotice({ kind: 'error', text: errorMessage(reason) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootComplete, focusRequestKey, focusSessionId, frameLoaded, selectedPersonalDshSessionId, status, targetOrigin]);

  return (
    <section className="dsh-web-host" aria-label="DSH 原生会话">
      {!desktopRuntime ? (
        <div className="codex-native-landing">
          <CircleAlert size={24} aria-hidden="true" />
          <h1>DSH 原生会话仅支持 RocketX 桌面端</h1>
          <p>当前 Web 版不提供本地 DSH Web 宿主；请在桌面端打开此视图。</p>
        </div>
      ) : status === 'ready' && url ? (
        <div className="relative h-full min-h-0">
          {frameNotice ? (
            <div
              aria-live="polite"
              className={`pointer-events-none absolute top-3 right-3 z-10 max-w-sm rounded-md px-3 py-2 text-xs shadow-lg ${
                frameNotice.kind === 'error'
                  ? 'bg-danger/90 text-white'
                  : frameNotice.kind === 'success'
                    ? 'bg-emerald-600/90 text-white'
                    : 'bg-surface-3/95 text-ink'
              }`}
            >
              {frameNotice.text}
            </div>
          ) : null}
          <iframe
            ref={iframeRef}
            title="DSH 原生会话"
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
            allow="clipboard-write"
            referrerPolicy="no-referrer"
            className="dsh-web-frame"
            onLoad={() => {
              lastFocusedSessionIdRef.current = null;
              setFrameLoaded(true);
              setBootNonce((value) => value + 1);
            }}
          />
        </div>
      ) : status === 'error' ? (
        <div className="codex-native-landing is-error">
          <CircleAlert size={24} aria-hidden="true" />
          <h1>DSH 原生会话启动失败</h1>
          <p>{error}</p>
          {workspaceRoot ? <p title={workspaceRoot}>{workspaceRoot}</p> : null}
          <div>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          </div>
        </div>
      ) : (
        <div className="codex-native-landing">
          <Loader2 size={24} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <h1>正在启动 DSH 原生会话</h1>
          <p>{workspaceRoot ? `工作区：${workspaceRoot}` : '正在解析 DSH 工作区。'}</p>
        </div>
      )}
    </section>
  );
}
