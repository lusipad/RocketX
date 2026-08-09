import { open } from '@tauri-apps/plugin-dialog';
import { Bot, Check, ChevronLeft, Copy, FolderOpen, Loader2, Play, Share2, Square, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { permissionRequestSummary } from '../agent/safety';
import { autoHostEnvironmentId, setRoomAutoHosting } from '../lib/agentHosting';
import { isTauriRuntime } from '../lib/client';
import { useStickToBottom } from '../lib/stickToBottom';
import { toast } from '../stores/toast';
import { useChat } from '../stores/chat';
import { useSharedAgent } from '../stores/sharedAgent';
import { environmentIsBusy, proposedAgentBranch, useAgentEnvironments } from '../stores/agentEnvironments';
import PanelShell from './PanelShell';
import ButlerErrandInputCard from './ButlerErrandInputCard';

function approvalSummary(method: string, params: unknown): string {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.filter((part) => typeof part === 'string').join(' ');
  if (typeof value.fileChanges === 'object' && value.fileChanges !== null) {
    return Object.keys(value.fileChanges).join('\n');
  }
  const permissionLines = permissionRequestSummary(value.permissions ?? value.additionalPermissions);
  if (permissionLines.length > 0) return permissionLines.join('\n');
  if (typeof value.grantRoot === 'string') return `写入目录：${value.grantRoot}`;
  if (typeof value.reason === 'string') return value.reason;
  return method;
}

export default function AgentPanel() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string>();
  const [autoHost, setAutoHost] = useState(false);
  const panel = useChat((state) => state.rightPanel);
  const tmid = panel?.kind === 'agent' ? panel.tmid : null;
  const setPanel = useChat((state) => state.setPanel);
  const rid = useChat((state) => state.activeRid);
  const session = useSharedAgent((state) => (tmid ? state.sessions[tmid] : undefined));
  const binding = useAgentEnvironments((state) => state.bindings.find((item) => item.sessionKey === tmid && item.status === 'active'));
  const environments = useAgentEnvironments((state) => state.environments);
  const bindings = useAgentEnvironments((state) => state.bindings);
  const boundEnvironment = environments.find((item) => item.id === binding?.environmentId);
  const defaultEnvironment = environments.find(
    (environment) => environment.enabled && !environmentIsBusy(environment.id, bindings),
  );
  const selectedEnvironment = boundEnvironment ?? defaultEnvironment;
  const sessionTraces = useSharedAgent((state) => (tmid ? state.traces[tmid] : undefined));
  const allApprovals = useSharedAgent((state) => state.approvals);
  const allInputs = useSharedAgent((state) => state.inputs);
  const allMemberRequests = useSharedAgent((state) => state.memberRequests);
  const traces = sessionTraces ?? [];
  const approvals = useMemo(
    () => allApprovals.filter((item) => item.tmid === tmid),
    [allApprovals, tmid],
  );
  const inputs = useMemo(
    () => allInputs.filter((item) => item.tmid === tmid),
    [allInputs, tmid],
  );
  const members = useMemo(
    () => allMemberRequests.filter((item) => item.tmid === tmid),
    [allMemberRequests, tmid],
  );
  const globalError = useSharedAgent((state) => state.error);
  const start = useSharedAgent((state) => state.startSession);
  const approveMember = useSharedAgent((state) => state.approveMemberRequest);
  const resolveApproval = useSharedAgent((state) => state.resolveApproval);
  const resolveInput = useSharedAgent((state) => state.resolveInput);
  const setAccess = useSharedAgent((state) => state.setAccess);
  const resume = useSharedAgent((state) => state.resumeSession);
  const end = useSharedAgent((state) => state.endSession);
  const transferToCodexApp = useSharedAgent((state) => state.transferToCodexApp);
  const [transferring, setTransferring] = useState(false);
  const [resumingTmid, setResumingTmid] = useState<string | null>(null);
  const desktopRuntime = isTauriRuntime();
  // 托管运行时新过程不断追加：贴底跟随，滚上去查旧记录时不打扰（issue #90 同类）
  // 依赖用 store 里的原始引用，traces 的 `?? []` 每次渲染都是新数组
  const { scrollRef, onScroll } = useStickToBottom([sessionTraces]);

  useEffect(() => {
    setAutoHost(!!rid && !!autoHostEnvironmentId(rid));
  }, [rid, session?.environmentId]);

  if (!tmid || !rid) return null;
  const roomSession = tmid.startsWith('room:');
  const resuming = resumingTmid === tmid;
  const error = session?.lastError ?? (!session ? globalError : null);
  const statusLabel = session
    ? {
        starting: '正在启动',
        ready: '待命',
        running: '正在工作',
        'waiting-approval': '等待审批',
        interrupted: '已中断',
        ended: '已结束',
      }[session.status]
    : '';

  return (
    <PanelShell
      title={
        <span className="flex items-center gap-2">
          <button
            title="返回话题"
            onClick={() => setPanel({ kind: 'thread', mid: tmid })}
            className="rounded p-1 text-ink-2 hover:bg-fill-hover"
          >
            <ChevronLeft size={16} />
          </button>
          <Bot size={16} className="text-primary" />
          共享 Agent
        </span>
      }
    >
      {error ? <div className="border-b border-line bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div> : null}
      {!session || session.status === 'ended' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
            <Bot size={28} />
          </div>
          <div>
            <div className="font-medium text-ink">
              {binding
                ? `为工作项 #${binding.workItemId} 开启 AI 托管`
                : roomSession
                  ? '在当前任务开启 AI 托管'
                  : '在当前话题开启 AI 托管'}
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              AI 会从已有讨论继续理解上下文。只有明确的 @ai 指令才会回复；权限、审批和执行边界与 Codex 任务一致。
            </div>
          </div>
          {!desktopRuntime ? (
            <div className="rounded-md border border-line bg-fill-1 px-3 py-2 text-xs text-ink-3">
              共享 Agent 仅支持 RocketX 桌面端。
            </div>
          ) : (
            <>
              <button
                onClick={() =>
                  void open({ directory: true, multiple: false, title: '选择 Agent 工作区' }).then((path) => {
                    if (typeof path === 'string') setWorkspaceRoot(path);
                  })
                }
                className="flex max-w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-xs text-ink-2 hover:bg-fill-hover"
                title={workspaceRoot ?? selectedEnvironment?.path}
              >
                <FolderOpen size={14} />
                <span className="truncate">{workspaceRoot ?? selectedEnvironment?.name ?? '选择项目目录（可选）'}</span>
              </button>
              <button
                onClick={() => void start(rid, tmid, {
                  workspaceRoot: workspaceRoot ?? selectedEnvironment?.path,
                  replyTmid: tmid.startsWith('room:') ? undefined : tmid,
                  environmentId: workspaceRoot ? undefined : selectedEnvironment?.id,
                  environmentName: workspaceRoot ? undefined : selectedEnvironment?.name,
                  workItem: binding ? { id: binding.workItemId, project: binding.adoProject, title: binding.workItemTitle } : undefined,
                  proposedBranch: binding && selectedEnvironment
                    ? proposedAgentBranch(selectedEnvironment.branchPrefix, binding.workItemId, binding.workItemTitle)
                    : undefined,
                  baseBranch: selectedEnvironment?.defaultBaseBranch,
                }).catch(() => undefined)}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover"
              >
                <Play size={14} /> 开启 AI 托管
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3 border-b border-line p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-3">状态</span>
              <span className="rounded bg-fill-1 px-2 py-0.5 text-xs text-ink">{statusLabel}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">指挥范围</span>
              <button
                onClick={() =>
                  void setAccess(
                    tmid,
                    session.access === 'host-only' ? 'room-members' : 'host-only',
                  )
                }
                className="flex items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2"
              >
                <Users size={14} />
                {session.access === 'host-only' ? '仅自己' : '房间成员'}
              </button>
            </div>
            {session.codexThreadId ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-3">Codex 任务</span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    title={`复制 codex resume ${session.codexThreadId}，在 Codex 命令行里接着这次对话`}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`codex resume ${session.codexThreadId}`)
                        .then(() => toast.success('已复制。建议结束托管后再在 Codex 里继续，两边同时写同一次对话会打架'));
                    }}
                    className="flex min-w-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                  >
                    <Copy size={12} />
                    <span className="truncate">codex resume</span>
                  </button>
                  <button
                    title="在 Codex App 打开新任务并填好托管记录，由你按回车发出"
                    disabled={transferring || session.status === 'running'}
                    onClick={() => {
                      setTransferring(true);
                      void transferToCodexApp(tmid)
                        .then((result) => {
                          if (result === 'unavailable') {
                            throw new Error('无法打开 Codex App，也无法复制对话记录');
                          }
                          toast.success(
                            result === 'opened-existing'
                              ? '已在 Codex App 接续当前任务'
                              : result === 'opened'
                              ? '已打开 Codex App，完整记录已填入，请确认后发送'
                              : result === 'opened-with-copy'
                                ? '对话较长：已打开 Codex App 并复制完整记录，请粘贴后发送'
                                : 'Codex App 打开失败，完整记录已复制',
                          );
                        })
                        .catch((error) => toast.error(error, '在 Codex App 打开失败'))
                        .finally(() => setTransferring(false));
                    }}
                    className="flex shrink-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
                  >
                    {transferring ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                    在 Codex App 打开
                  </button>
                </div>
              </div>
            ) : null}
            <div className="truncate text-xs text-ink-3" title={session.workspaceRoots[0]}>
              {session.workspaceRoots[0]}
            </div>
            <label className="flex items-start gap-2 rounded-md bg-fill-1 px-2.5 py-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={autoHost}
                disabled={!session.environmentId}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setRoomAutoHosting(rid, enabled ? session.environmentId : undefined);
                  setAutoHost(enabled);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-ink">进入本房间时自动开启托管</span>
                <span className="mt-0.5 block text-xs text-ink-3">
                  仅在这台设备生效；已有其他人托管时不会抢占。
                </span>
              </span>
            </label>
            <div className="flex gap-2">
              {session.status === 'interrupted' ? (
                <button
                  disabled={resuming}
                  onClick={() => {
                    setResumingTmid(tmid);
                    void resume(tmid)
                      .catch((resumeError) => toast.error(resumeError, '恢复 AI 托管失败'))
                      .finally(() => setResumingTmid((current) => (current === tmid ? null : current)));
                  }}
                  className="flex flex-1 items-center justify-center gap-1 rounded border border-primary px-2 py-1.5 text-xs text-primary disabled:opacity-50"
                >
                  {resuming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {resuming ? '恢复中…' : '恢复'}
                </button>
              ) : null}
              <button
                disabled={resuming}
                onClick={() => void end(tmid)}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-line px-2 py-1.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
              >
                <Square size={12} /> 结束
              </button>
            </div>
          </div>

          {(members.length > 0 || approvals.length > 0 || inputs.length > 0) && (
            <div className="space-y-3 border-b border-line bg-warning-light/30 p-4">
              {members.map((request) => (
                <div key={request.id} className="rounded-md border border-line bg-surface-3 p-3 text-xs">
                  <div className="font-medium text-ink">@{request.command.username} 请求指挥 Agent</div>
                  <div className="mt-1 line-clamp-3 text-ink-3">{request.command.text}</div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void approveMember(request.id, true)}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> 放行本次任务
                    </button>
                    <button
                      onClick={() => void approveMember(request.id, false)}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> 拒绝
                    </button>
                  </div>
                </div>
              ))}
              {approvals.map((approval) => (
                <div key={approval.id} className="rounded-md border border-line bg-surface-3 p-3 text-xs">
                  <div className="font-medium text-ink">等你在这台电脑上批准</div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-ink-3">
                    {approvalSummary(approval.method, approval.params)}
                  </pre>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => void resolveApproval(approval.id, 'decline')}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> 拒绝
                    </button>
                    {approval.method.startsWith('item/') ? (
                      <button
                        onClick={() => void resolveApproval(approval.id, 'accept-session')}
                        className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                      >
                        <Check size={12} /> 本次任务允许
                      </button>
                    ) : null}
                    <button
                      onClick={() => void resolveApproval(approval.id, 'accept')}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> 允许一次
                    </button>
                  </div>
                </div>
              ))}
              {inputs.map((input) => (
                <ButlerErrandInputCard
                  key={input.id}
                  input={input}
                  onResolve={(response) => resolveInput(input.id, response)}
                />
              ))}
            </div>
          )}

          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-2 text-xs font-medium text-ink-2">它做了哪些操作</div>
            {traces.length === 0 ? (
              <div className="py-8 text-center text-xs text-ink-3">还没有人下过指令。在这个话题里发一条 @ai 开头的消息，它就开始干活。</div>
            ) : (
              <div className="space-y-2">
                {traces.map((item) => (
                  <div key={item.id} className="rounded bg-fill-1 px-2.5 py-2 text-xs text-ink-2">
                    <span className="mr-2 text-ink-3">{new Date(item.at).toLocaleTimeString()}</span>
                    {item.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </PanelShell>
  );
}
