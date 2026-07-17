import { open } from '@tauri-apps/plugin-dialog';
import {
  Bot,
  Check,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  Send,
  Shield,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { permissionRequestSummary } from '../agent/safety';
import { getServerBase } from '../lib/client';
import { isTauri } from '../lib/http';
import { useAuth } from '../stores/auth';
import { useLocalCodex } from '../stores/localCodex';

const STATUS_LABEL = {
  idle: '未运行',
  starting: '启动中',
  ready: '已就绪',
  running: '执行中',
  'waiting-approval': '等待审批',
  interrupted: '已中断',
} as const;

function approvalSummary(method: string, params: unknown): string {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.filter((item) => typeof item === 'string').join(' ');
  if (typeof value.fileChanges === 'object' && value.fileChanges !== null) return Object.keys(value.fileChanges).join('\n');
  const permissions = permissionRequestSummary(value.permissions ?? value.additionalPermissions);
  if (permissions.length) return permissions.join('\n');
  if (typeof value.grantRoot === 'string') return `写入目录：${value.grantRoot}`;
  if (typeof value.reason === 'string') return value.reason;
  return method;
}

export default function CodexPage() {
  const userId = useAuth((state) => state.user?._id ?? 'guest');
  const workspaceRoot = useLocalCodex((state) => state.workspaceRoot);
  const threadId = useLocalCodex((state) => state.threadId);
  const sandboxMode = useLocalCodex((state) => state.sandboxMode);
  const status = useLocalCodex((state) => state.status);
  const messages = useLocalCodex((state) => state.messages);
  const traces = useLocalCodex((state) => state.traces);
  const approvals = useLocalCodex((state) => state.approvals);
  const error = useLocalCodex((state) => state.error);
  const hydrate = useLocalCodex((state) => state.hydrate);
  const setWorkspaceRoot = useLocalCodex((state) => state.setWorkspaceRoot);
  const setSandboxMode = useLocalCodex((state) => state.setSandboxMode);
  const startNew = useLocalCodex((state) => state.startNew);
  const resume = useLocalCodex((state) => state.resume);
  const send = useLocalCodex((state) => state.send);
  const resolveApproval = useLocalCodex((state) => state.resolveApproval);
  const stop = useLocalCodex((state) => state.stop);
  const [input, setInput] = useState('');
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => hydrate(`${getServerBase() || 'same-origin'}:${userId}`), [hydrate, userId]);

  const active = status !== 'idle' && status !== 'interrupted';
  const canSend = status === 'ready' && !!input.trim();

  const chooseWorkspace = async () => {
    const path = await open({ directory: true, multiple: false, title: '选择 Codex 本地工作目录' });
    if (typeof path === 'string') setWorkspaceRoot(path);
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || status !== 'ready') return;
    setInput('');
    await send(text).catch(() => setInput(text));
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-surface-3">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-8 py-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xl font-semibold text-ink"><TerminalSquare size={20} className="text-primary" />执行间</div>
            <p className="mt-1 text-sm text-ink-3">管家的本地执行工房：在指定本地目录中运行 Codex 会话；由 Codex 原生沙箱和审批控制命令与文件修改。</p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-2">
            <span className={`h-2 w-2 rounded-full ${status === 'ready' ? 'bg-success' : status === 'running' || status === 'waiting-approval' ? 'bg-warning' : 'bg-ink-3'}`} />
            {STATUS_LABEL[status]}
          </div>
        </div>

        {!isTauri ? (
          <div className="mt-6 rounded-lg border border-warning/30 bg-warning-light p-4 text-sm text-warning">Codex 本地工作区只在 RocketX 桌面端可用。</div>
        ) : null}
        {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}

        <div className="mt-6 grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="space-y-4 rounded-xl border border-line bg-surface p-4 shadow-sm">
            <div>
              <div className="text-xs font-medium text-ink-2">本地工作目录</div>
              <button onClick={() => void chooseWorkspace()} disabled={!isTauri || active} title={workspaceRoot} className="mt-2 flex w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-left text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-60">
                <FolderOpen size={14} className="shrink-0 text-primary" />
                <span className="truncate">{workspaceRoot || '选择项目目录'}</span>
              </button>
              <p className="mt-2 text-2xs leading-4 text-ink-3">该目录会直接作为本机 Codex 工作目录，并按当前账号记住。</p>
            </div>

            <div className="border-t border-line pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink-2">安全模式</span>
                <button onClick={() => setSandboxMode(sandboxMode === 'read-only' ? 'workspace-write' : 'read-only')} disabled={status === 'running' || status === 'waiting-approval'} className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${sandboxMode === 'read-only' ? 'bg-success-light text-success' : 'bg-warning-light text-warning'}`}>
                  <Shield size={12} />{sandboxMode === 'read-only' ? '只读' : '工作区可写'}
                </button>
              </div>
              <p className="mt-2 text-2xs leading-4 text-ink-3">请只选择允许 Codex 读取的目录；网络默认关闭，写入模式仅允许当前工作区。</p>
            </div>

            <div className="space-y-2 border-t border-line pt-4">
              {status === 'idle' && threadId ? <button onClick={() => void resume().catch(() => undefined)} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-white hover:bg-primary-hover"><Play size={14} />恢复会话</button> : null}
              {(status === 'idle' || status === 'interrupted') ? <button onClick={() => void startNew().catch(() => undefined)} disabled={!workspaceRoot} className={`${threadId ? 'border border-line bg-surface-2 text-ink' : 'bg-primary text-white'} flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-fill-hover disabled:opacity-50`}><Plus size={14} />新建会话</button> : null}
              {status === 'interrupted' && threadId ? <button onClick={() => void resume().catch(() => undefined)} className="flex w-full items-center justify-center gap-2 rounded-md border border-primary px-3 py-2 text-sm text-primary"><Play size={14} />重新连接</button> : null}
              {active ? <button onClick={() => void stop().catch(() => undefined)} className="flex w-full items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-ink-2 hover:bg-fill-hover"><Square size={13} />停止进程</button> : null}
            </div>

            {threadId ? <div className="truncate border-t border-line pt-4 text-2xs text-ink-3" title={threadId}>线程：{threadId}</div> : null}
            <button onClick={() => setShowTrace((value) => !value)} className="w-full text-left text-xs text-primary">{showTrace ? '隐藏' : '查看'}本地过程（{traces.length}）</button>
            {showTrace ? <div className="max-h-52 space-y-1 overflow-y-auto rounded bg-fill-1 p-2">{traces.length ? traces.map((trace) => <div key={trace.id} className="text-2xs leading-4 text-ink-3"><span className="mr-1">{new Date(trace.at).toLocaleTimeString()}</span>{trace.text}</div>) : <div className="text-2xs text-ink-3">暂无过程记录</div>}</div> : null}
          </aside>

          <main className="flex min-h-[520px] min-w-0 flex-col rounded-xl border border-line bg-surface shadow-sm">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              {messages.length === 0 ? (
                <div className="flex h-full min-h-72 flex-col items-center justify-center text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary"><Bot size={28} /></div>
                  <div className="mt-4 font-medium text-ink">{status === 'ready' ? 'Codex 已就绪' : '选择目录并启动本地会话'}</div>
                  <div className="mt-1 max-w-md text-xs leading-5 text-ink-3">可以直接聊天，也可以让 Codex 阅读代码、运行测试或修改当前目录；只选择你允许它读取的工作目录。</div>
                </div>
              ) : messages.map((message) => (
                <div key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}>
                  {message.role === 'assistant' ? <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary"><Bot size={15} /></div> : null}
                  <div className={`max-w-[82%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm leading-6 ${message.role === 'user' ? 'bg-primary text-white' : 'bg-fill-1 text-ink'}`}>{message.text}</div>
                </div>
              ))}
              {status === 'running' ? <div className="flex items-center gap-2 text-xs text-ink-3"><Loader2 size={14} className="animate-spin" />Codex 正在执行…</div> : null}
              {approvals.map((approval) => (
                <div key={approval.id} className="rounded-lg border border-warning/40 bg-warning-light/40 p-4">
                  <div className="text-sm font-medium text-ink">等待审批</div>
                  <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs text-ink-2">{approvalSummary(approval.method, approval.params)}</pre>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => resolveApproval(approval.id, true)} className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-white"><Check size={12} />允许本次</button>
                    <button onClick={() => resolveApproval(approval.id, false)} className="flex items-center gap-1 rounded border border-line bg-surface px-3 py-1.5 text-xs text-ink-2"><X size={12} />拒绝</button>
                  </div>
                </div>
              ))}
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="flex items-end gap-2 border-t border-line p-3">
              <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} disabled={status !== 'ready'} rows={2} placeholder={status === 'ready' ? '输入 Codex 指令，Enter 发送，Shift+Enter 换行' : '先启动或恢复会话'} className="min-h-12 min-w-0 flex-1 resize-none rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-primary disabled:opacity-60" />
              <button type="submit" disabled={!canSend} className="flex h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm text-white hover:bg-primary-hover disabled:opacity-50"><Send size={14} />发送</button>
            </form>
          </main>
        </div>
      </div>
    </div>
  );
}
