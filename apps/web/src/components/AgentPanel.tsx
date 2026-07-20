import { open } from '@tauri-apps/plugin-dialog';
import { Bot, Check, ChevronLeft, Copy, FolderOpen, Loader2, Play, Share2, Shield, Square, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { permissionRequestSummary } from '../agent/safety';
import { autoHostEnvironmentId, setRoomAutoHosting } from '../lib/agentHosting';
import { useStickToBottom } from '../lib/stickToBottom';
import { toast } from '../stores/toast';
import { useChat } from '../stores/chat';
import { useSharedAgent } from '../stores/sharedAgent';
import { environmentIsBusy, proposedAgentBranch, useAgentEnvironments } from '../stores/agentEnvironments';
import PanelShell from './PanelShell';

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
  const allMemberRequests = useSharedAgent((state) => state.memberRequests);
  const traces = sessionTraces ?? [];
  const approvals = useMemo(
    () => allApprovals.filter((item) => item.tmid === tmid),
    [allApprovals, tmid],
  );
  const members = useMemo(
    () => allMemberRequests.filter((item) => item.tmid === tmid),
    [allMemberRequests, tmid],
  );
  const error = useSharedAgent((state) => state.error);
  const start = useSharedAgent((state) => state.startSession);
  const approveMember = useSharedAgent((state) => state.approveMemberRequest);
  const resolveApproval = useSharedAgent((state) => state.resolveApproval);
  const setSandboxMode = useSharedAgent((state) => state.setSandboxMode);
  const setAccess = useSharedAgent((state) => state.setAccess);
  const resume = useSharedAgent((state) => state.resumeSession);
  const end = useSharedAgent((state) => state.endSession);
  const transferToCodexApp = useSharedAgent((state) => state.transferToCodexApp);
  const [transferring, setTransferring] = useState(false);
  // 托管运行时新过程不断追加：贴底跟随，滚上去查旧记录时不打扰（issue #90 同类）
  // 依赖用 store 里的原始引用，traces 的 `?? []` 每次渲染都是新数组
  const { scrollRef, onScroll } = useStickToBottom([sessionTraces]);

  useEffect(() => {
    setAutoHost(!!rid && !!autoHostEnvironmentId(rid));
  }, [rid, session?.environmentId]);

  if (!tmid || !rid) return null;
  const roomSession = tmid.startsWith('room:');

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
          <Bot size={17} className="text-primary" />
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
                  ? '在当前会话开启 AI 托管'
                  : '在当前话题开启 AI 托管'}
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              AI 会从已有讨论继续理解上下文。默认只读，只有明确的 @ai 指令才会回复，写入仍需本机审批。
            </div>
          </div>
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
            <Play size={15} /> 开启 AI 托管
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-3 border-b border-line p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-3">状态</span>
              <span className="rounded bg-fill-1 px-2 py-0.5 text-xs text-ink">{session.status}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">安全模式</span>
              <button
                onClick={() =>
                  void setSandboxMode(
                    tmid,
                    session.sandboxMode === 'read-only' ? 'workspace-write' : 'read-only',
                  )
                }
                className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                  session.sandboxMode === 'read-only'
                    ? 'bg-success-light text-success'
                    : 'bg-warning-light text-warning'
                }`}
              >
                <Shield size={13} />
                {session.sandboxMode === 'read-only' ? '只读' : '工作区可写'}
              </button>
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
                <Users size={13} />
                {session.access === 'host-only' ? '仅自己' : '房间成员'}
              </button>
            </div>
            {session.codexThreadId ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-3">Codex 线程</span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    title={`复制 codex resume ${session.codexThreadId}，可在 Codex CLI 里继续该线程`}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`codex resume ${session.codexThreadId}`)
                        .then(() => toast.success('已复制。建议结束托管后再在 Codex 里继续，避免两端同时写同一线程'));
                    }}
                    className="flex min-w-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                  >
                    <Copy size={12} />
                    <span className="truncate">codex resume</span>
                  </button>
                  <button
                    title="在 Codex App 打开新对话并带入托管记录"
                    disabled={transferring || session.status === 'running'}
                    onClick={() => {
                      setTransferring(true);
                      void transferToCodexApp(tmid)
                        .then((result) => {
                          if (result === 'unavailable') {
                            throw new Error('无法打开 Codex App，也无法复制对话记录');
                          }
                          toast.success(
                            result === 'opened'
                              ? '已打开 Codex App，完整记录已填入，请确认后发送'
                              : result === 'opened-with-copy'
                                ? '对话较长：已打开 Codex App 并复制完整记录，请粘贴后发送'
                                : 'Codex App 打开失败，完整记录已复制',
                          );
                        })
                        .catch((error) => toast.error(error, '转移到 Codex 失败'))
                        .finally(() => setTransferring(false));
                    }}
                    className="flex shrink-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
                  >
                    {transferring ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                    转到 Codex App
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
                <span className="mt-0.5 block text-2xs text-ink-3">
                  仅在这台设备生效；已有其他人托管时不会抢占。
                </span>
              </span>
            </label>
            <div className="flex gap-2">
              {session.status === 'interrupted' ? (
                <button
                  onClick={() => void resume(tmid)}
                  className="flex flex-1 items-center justify-center gap-1 rounded border border-primary px-2 py-1.5 text-xs text-primary"
                >
                  <Play size={13} /> 恢复
                </button>
              ) : null}
              <button
                onClick={() => void end(tmid)}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-line px-2 py-1.5 text-xs text-ink-2 hover:bg-fill-hover"
              >
                <Square size={12} /> 结束
              </button>
            </div>
          </div>

          {(members.length > 0 || approvals.length > 0) && (
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
                      <Check size={12} /> 放行本会话
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
                  <div className="font-medium text-ink">等待宿主审批</div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-ink-3">
                    {approvalSummary(approval.method, approval.params)}
                  </pre>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void resolveApproval(approval.id, true)}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> 允许
                    </button>
                    <button
                      onClick={() => void resolveApproval(approval.id, false)}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> 拒绝
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-2 text-xs font-medium text-ink-2">本地过程</div>
            {traces.length === 0 ? (
              <div className="py-8 text-center text-xs text-ink-3">等待话题中的 Agent 指令</div>
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
