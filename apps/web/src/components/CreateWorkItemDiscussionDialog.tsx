import { Bot, ExternalLink, FolderOpen, Loader2, MessageSquarePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { commentWorkItem } from '../lib/ado';
import { getServerBase, rest } from '../lib/client';
import { defaultHostingBackend } from '../lib/agentHosting';
import {
  agentRoomSessionKey,
  environmentIsBusy,
  proposedAgentBranch,
  selectEnvironmentForProject,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { normalizeDiscussionName, useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import type { WorkItem } from '../stores/workbench';
import Dialog from './Dialog';
import { useI18n } from '../i18n';
import { compareLocaleText } from '../i18n/format';

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
  const { t, locale } = useI18n();
  const rooms = useChat((state) => state.rooms);
  const subscriptions = useChat((state) => state.subscriptions);
  const activeRid = useChat((state) => state.activeRid);
  const environments = useAgentEnvironments((state) => state.environments);
  const bindings = useAgentEnvironments((state) => state.bindings);
  const lastEnvironmentByProject = useAgentEnvironments((state) => state.lastEnvironmentByProject);
  const bindDiscussion = useAgentEnvironments((state) => state.bindDiscussion);

  const parentRooms = useMemo(
    // Rocket.Chat 明确拒绝嵌套讨论（`error-nested-discussion`，8.6 实测），
    // 所以父房间候选必须排除讨论本身（`prid` 非空）。
    () => Object.values(rooms)
      .filter((room) => (room.t === 'c' || room.t === 'p') && !room.prid && !!subscriptions[room._id])
      .sort((left, right) => compareLocaleText(roomLabel(left, left._id), roomLabel(right, right._id))),
    [rooms, subscriptions, locale],
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
  // 讨论展示名保留工作项编号与中文标题，预览和提交共用规范化规则。
  const [discussionName, setDiscussionName] = useState(() => normalizeDiscussionName(`#${item.id} ${item.title}`, `work-item-${item.id}`));
  const [startAgent, setStartAgent] = useState(true);
  const [writeBack, setWriteBack] = useState(false);
  const [busy, setBusy] = useState(false);

  const openExisting = async () => {
    if (!existing) return;
    await useChat.getState().openRoom(existing.discussionRid);
    useChat.getState().setPanel({ kind: 'agent', tmid: existing.sessionKey });
    onClose();
  };

  const create = async () => {
    const environment = environments.find((candidate) => candidate.id === environmentId);
    if (!parentRid) throw new Error(t('chat.wiDiscussion.selectParentError'));
    if (!environment) throw new Error(t('chat.wiDiscussion.selectEnvError'));
    if (environmentIsBusy(environment.id, bindings)) throw new Error(t('chat.wiDiscussion.envBusyError'));
    setBusy(true);
    let discussionRid = '';
    try {
      const resolvedName = normalizeDiscussionName(discussionName.trim() || `#${item.id} ${item.title}`, `work-item-${item.id}`);
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
      const assignee = item.assignedTo ? t('chat.wiDiscussion.summaryAssignee', { name: item.assignedTo }) : '';
      const summary = [
        t('chat.wiDiscussion.summaryHeader', { id: item.id, title: item.title, url: item.webUrl }),
        t('chat.wiDiscussion.summaryAdo', { project: item.project, state: item.state, assignee }),
        t('chat.wiDiscussion.summaryProject', { name: environment.name }),
        t('chat.wiDiscussion.summaryBranch', { branch }),
        '',
        t('chat.wiDiscussion.summaryFooter'),
      ].join('\n');
      await rest.sendMessage(room._id, summary);

      if (writeBack) {
        const base = getServerBase().replace(/\/+$/, '');
        const route = room.t === 'c' ? 'channel' : 'group';
        const href = `${base}/${route}/${encodeURIComponent(room.name ?? room._id)}`;
        await commentWorkItem(item.id, t('chat.wiDiscussion.adoComment', { href: escapeHtml(href), name: escapeHtml(resolvedName) }))
          .catch((error) => toast.error(error, t('chat.wiDiscussion.writeBackFailed')));
      }

      await useChat.getState().openRoom(room._id);
      if (startAgent) {
        try {
          const { useSharedAgent } = await import('../stores/sharedAgent');
          await useSharedAgent.getState().startSession(room._id, sessionKey, {
            backend: defaultHostingBackend(),
            workspaceRoot: environment.path,
            environmentId: environment.id,
            environmentName: environment.name,
            workItem: { id: item.id, project: item.project, title: item.title },
            proposedBranch: branch,
            baseBranch: environment.defaultBaseBranch,
          });
          useChat.getState().setPanel({ kind: 'agent', tmid: sessionKey });
        } catch (error) {
          toast.error(error, t('chat.wiDiscussion.agentStartFailed'));
        }
      }
      toast.success(t('chat.discussion.created', { name: resolvedName }));
      onClose();
    } catch (error) {
      toast.error(error, discussionRid ? t('chat.wiDiscussion.bindEnvFailed') : t('chat.wiDiscussion.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (existing) {
    return (
      <Dialog
        title={t('chat.wiDiscussion.existingTitle', { id: item.id })}
        hint={t('chat.wiDiscussion.existingHint')}
        onClose={onClose}
        footer={
          <>
            <button onClick={onClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2">{t('common.cancel')}</button>
            <button onClick={() => void openExisting()} className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white">
              <ExternalLink size={14} /> {t('chat.wiDiscussion.openExisting')}
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
      title={t('chat.wiDiscussion.createTitle', { id: item.id })}
      hint={t('chat.wiDiscussion.createHint')}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 disabled:opacity-50">{t('common.cancel')}</button>
          <button
            onClick={() => void create()}
            disabled={busy || !parentRid || !environmentId}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <MessageSquarePlus size={14} />}
            {busy ? t('chat.common.creating') : t('chat.discussion.createTitle')}
          </button>
        </>
      }
    >
      <div className="space-y-4 px-5 pb-3 pt-2">
        <label className="block text-xs text-ink-3">
          {t('chat.discussion.nameLabel')}
          <input value={discussionName} onChange={(event) => setDiscussionName(event.target.value)} maxLength={100} className={`mt-1 ${inputCls}`} />
        </label>
        <label className="block text-xs text-ink-3">
          {t('chat.wiDiscussion.parentGroupLabel')}
          <select value={parentRid} onChange={(event) => setParentRid(event.target.value)} className={`mt-1 ${inputCls}`}>
            {parentRooms.map((room) => <option key={room._id} value={room._id}>{roomLabel(room, room._id)}</option>)}
          </select>
          {parentRooms.length === 0 ? <span className="mt-1 block text-danger">{t('chat.discussion.noParentRoomsError')}</span> : null}
        </label>
        <label className="block text-xs text-ink-3">
          {t('chat.wiDiscussion.localEnvLabel')}
          <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} className={`mt-1 ${inputCls}`}>
            <option value="">{t('chat.wiDiscussion.selectIdleEnv')}</option>
            {environments.filter((environment) => environment.enabled).map((environment) => {
              const busyEnvironment = environmentIsBusy(environment.id, bindings);
              return <option key={environment.id} value={environment.id} disabled={busyEnvironment}>{environment.name}{busyEnvironment ? t('chat.wiDiscussion.envInUseSuffix') : ''}</option>;
            })}
          </select>
          {environmentId ? (
            <span className="mt-1 flex items-center gap-1 truncate text-xs text-ink-3">
              <FolderOpen size={12} /> {environments.find((environment) => environment.id === environmentId)?.path}
            </span>
          ) : null}
          {environments.length === 0 ? <span className="mt-1 block text-danger">{t('chat.wiDiscussion.noEnvsHint')}</span> : null}
        </label>
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={startAgent} onChange={(event) => setStartAgent(event.target.checked)} className="mt-0.5" />
          <span><span className="flex items-center gap-1 font-medium text-ink"><Bot size={12} /> {t('chat.wiDiscussion.startAgentTitle')}</span>{t('chat.wiDiscussion.startAgentDesc')}</span>
        </label>
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={writeBack} onChange={(event) => setWriteBack(event.target.checked)} className="mt-0.5" />
          <span><span className="font-medium text-ink">{t('chat.wiDiscussion.writeBackTitle')}</span><br />{t('chat.wiDiscussion.writeBackDesc')}</span>
        </label>
      </div>
    </Dialog>
  );
}
