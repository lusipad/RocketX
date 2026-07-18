import { Bot, ExternalLink, FolderOpen, Loader2, MessageSquarePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { commentWorkItem } from '../lib/ado';
import { getServerBase, rest } from '../lib/client';
import {
  agentRoomSessionKey,
  environmentIsBusy,
  proposedAgentBranch,
  selectEnvironmentForProject,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import type { WorkItem } from '../stores/workbench';
import Dialog from './Dialog';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

function roomLabel(room: { fname?: string; name?: string }, rid: string): string {
  return room.fname || room.name || rid;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

export default function CreateWorkItemDiscussionDialog({
  item,
  onClose,
}: {
  item: WorkItem;
  onClose: () => void;
}) {
  const rooms = useChat((state) => state.rooms);
  const subscriptions = useChat((state) => state.subscriptions);
  const activeRid = useChat((state) => state.activeRid);
  const environments = useAgentEnvironments((state) => state.environments);
  const bindings = useAgentEnvironments((state) => state.bindings);
  const lastEnvironmentByProject = useAgentEnvironments((state) => state.lastEnvironmentByProject);
  const bindDiscussion = useAgentEnvironments((state) => state.bindDiscussion);

  const parentRooms = useMemo(
    () => Object.values(rooms)
      .filter((room) => (room.t === 'c' || room.t === 'p') && !room.prid && !!subscriptions[room._id])
      .sort((left, right) => roomLabel(left, left._id).localeCompare(roomLabel(right, right._id), 'zh-CN')),
    [rooms, subscriptions],
  );
  const defaultParent = parentRooms.some((room) => room._id === activeRid) ? activeRid! : parentRooms[0]?._id ?? '';
  const defaultEnvironment = selectEnvironmentForProject(
    environments,
    bindings,
    item.project,
    lastEnvironmentByProject,
  );
  const existing = bindings.find(
    (binding) => binding.status === 'active' && binding.adoProject === item.project && binding.workItemId === item.id,
  );
  const [parentRid, setParentRid] = useState(defaultParent);
  const [environmentId, setEnvironmentId] = useState(defaultEnvironment?.id ?? '');
  const [discussionName, setDiscussionName] = useState(`#${item.id} ${item.title}`.slice(0, 100));
  const [startAgent, setStartAgent] = useState(true);
  const [writeBack, setWriteBack] = useState(true);
  const [busy, setBusy] = useState(false);

  const openExisting = async () => {
    if (!existing) return;
    await useChat.getState().openRoom(existing.discussionRid);
    useChat.getState().setPanel({ kind: 'agent', tmid: existing.sessionKey });
    onClose();
  };

  const create = async () => {
    const environment = environments.find((candidate) => candidate.id === environmentId);
    if (!parentRid) throw new Error('请选择所属工作群');
    if (!environment) throw new Error('请选择空闲的本地环境');
    if (environmentIsBusy(environment.id, bindings)) throw new Error('所选本地环境已被其他活动讨论占用');
    setBusy(true);
    let discussionRid = '';
    try {
      const resolvedName = discussionName.trim() || `#${item.id} ${item.title}`;
      const room = await rest.createDiscussion(parentRid, resolvedName);
      discussionRid = room._id;
      useChat.setState((state) => ({ rooms: { ...state.rooms, [room._id]: room } }));
      const sessionKey = agentRoomSessionKey(room._id);
      bindDiscussion({
        workItemId: item.id,
        adoProject: item.project,
        workItemTitle: item.title,
        parentRid,
        discussionRid: room._id,
        sessionKey,
        environmentId: environment.id,
      });
      const branch = proposedAgentBranch(environment.branchPrefix, item.id, item.title);
      const summary = [
        `🤖 **工作项讨论已建立：[#${item.id} ${item.title}](${item.webUrl})**`,
        `ADO：${item.project} · ${item.state}${item.assignedTo ? ` · 负责人 ${item.assignedTo}` : ''}`,
        `本地项目：${environment.name} · 默认只读`,
        `计划分支：\`${branch}\`（首次获准修改时由 AI 创建）`,
        '',
        '房间成员使用 `@ai` 提问；本地目录、命令和审批只在代码宿主的 RocketChat X 中显示。',
      ].join('\n');
      await rest.sendMessage(room._id, summary);

      if (writeBack) {
        const base = getServerBase().replace(/\/+$/, '');
        const route = room.t === 'c' ? 'channel' : 'group';
        const href = `${base}/${route}/${encodeURIComponent(room.name ?? room._id)}`;
        await commentWorkItem(item.id, `RocketX 已创建工作项讨论：<a href="${escapeHtml(href)}">${escapeHtml(resolvedName)}</a>`)
          .catch((error) => toast.error(error, '讨论已创建，但写回 ADO 失败'));
      }

      await useChat.getState().openRoom(room._id);
      if (startAgent) {
        try {
          const { useSharedAgent } = await import('../stores/sharedAgent');
          await useSharedAgent.getState().startSession(room._id, sessionKey, {
            workspaceRoot: environment.path,
            environmentId: environment.id,
            environmentName: environment.name,
            workItem: { id: item.id, project: item.project, title: item.title },
            proposedBranch: branch,
            baseBranch: environment.defaultBaseBranch,
          });
          useChat.getState().setPanel({ kind: 'agent', tmid: sessionKey });
        } catch (error) {
          toast.error(error, '讨论已创建并绑定环境，但本地 Agent 启动失败');
        }
      }
      toast.success(`已创建讨论「${resolvedName}」`);
      onClose();
    } catch (error) {
      toast.error(error, discussionRid ? '讨论已创建，但绑定本地环境失败' : '创建工作项讨论失败');
    } finally {
      setBusy(false);
    }
  };

  if (existing) {
    return (
      <Dialog
        title={`工作项 #${item.id} 已有讨论`}
        hint="同一工作项默认只保留一个活动讨论，避免上下文和执行结果分散。"
        onClose={onClose}
        footer={
          <>
            <button onClick={onClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2">取消</button>
            <button onClick={() => void openExisting()} className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white">
              <ExternalLink size={13} /> 进入已有讨论
            </button>
          </>
        }
      >
        <div className="px-5 pb-4 text-sm text-ink-2">#{item.id} {item.title}</div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`为 #${item.id} 创建讨论`}
      hint="创建 Rocket.Chat 原生 Discussion，并在本机绑定一个独占的共享 Agent 环境。"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 disabled:opacity-50">取消</button>
          <button
            onClick={() => void create()}
            disabled={busy || !parentRid || !environmentId}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <MessageSquarePlus size={14} />}
            {busy ? '创建中…' : '创建讨论'}
          </button>
        </>
      }
    >
      <div className="space-y-4 px-5 pb-3 pt-2">
        <label className="block text-xs text-ink-3">
          讨论名称
          <input value={discussionName} onChange={(event) => setDiscussionName(event.target.value)} maxLength={100} className={`mt-1 ${inputCls}`} />
        </label>
        <label className="block text-xs text-ink-3">
          所属工作群
          <select value={parentRid} onChange={(event) => setParentRid(event.target.value)} className={`mt-1 ${inputCls}`}>
            {parentRooms.map((room) => <option key={room._id} value={room._id}>{roomLabel(room, room._id)}</option>)}
          </select>
          {parentRooms.length === 0 ? <span className="mt-1 block text-danger">当前没有可创建讨论的频道或群组</span> : null}
        </label>
        <label className="block text-xs text-ink-3">
          本地环境
          <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} className={`mt-1 ${inputCls}`}>
            <option value="">选择空闲环境</option>
            {environments.filter((environment) => environment.enabled).map((environment) => {
              const busyEnvironment = environmentIsBusy(environment.id, bindings);
              return <option key={environment.id} value={environment.id} disabled={busyEnvironment}>{environment.name}{busyEnvironment ? '（使用中）' : ''}</option>;
            })}
          </select>
          {environmentId ? (
            <span className="mt-1 flex items-center gap-1 truncate text-2xs text-ink-3">
              <FolderOpen size={11} /> {environments.find((environment) => environment.id === environmentId)?.path}
            </span>
          ) : null}
          {environments.length === 0 ? <span className="mt-1 block text-danger">请先到“设置 → AI”添加本地环境</span> : null}
        </label>
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={startAgent} onChange={(event) => setStartAgent(event.target.checked)} className="mt-0.5" />
          <span><span className="flex items-center gap-1 font-medium text-ink"><Bot size={12} /> 创建后启动只读 Agent</span>其他成员可以在原版 Rocket.Chat 中使用 @ai，写入仍由本机审批。</span>
        </label>
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={writeBack} onChange={(event) => setWriteBack(event.target.checked)} className="mt-0.5" />
          <span><span className="font-medium text-ink">将讨论链接写回 ADO 工作项</span><br />只写一条可追溯链接，不同步本地路径。</span>
        </label>
      </div>
    </Dialog>
  );
}
