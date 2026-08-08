import { useEffect, useRef, useState } from 'react';
import { normalizeAdoIdentityId, type ButlerActionKind } from '../lib/butlerActions';
import { useButler } from '../stores/butler';
import { transferConversationToCodexApp } from '../stores/butlerCodex';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { awaitLastTodoWrite, useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import CreateWorkItemDialog from './CreateWorkItemDialog';

const TITLES: Record<ButlerActionKind, string> = {
  reply: '回复草稿',
  send: '发送回复',
  todo: '待办草案',
  commitment: '承诺草案',
  ado: 'ADO 工作项草案',
  'ado-state': '修改 ADO 工作项状态',
  codex: 'Codex 交接草案',
};

export function ButlerActionCard() {
  const draft = useButler((state) => state.actionDraft);
  const lines = useButler((state) => state.lines);
  const update = useButler((state) => state.updateAction);
  const dismiss = useButler((state) => state.dismissAction);
  const begin = useButler((state) => state.beginAction);
  const failAction = useButler((state) => state.failAction);
  const complete = useButler((state) => state.completeAction);
  const runtimeCheckpoints = useButler((state) => state.runtimeCheckpoints);
  const [executing, setExecuting] = useState(false);
  const [adoOpen, setAdoOpen] = useState(false);
  const adoCreated = useRef(false);

  useEffect(() => {
    setExecuting(false);
    setAdoOpen(false);
    adoCreated.current = false;
  }, [draft?.id]);

  if (!draft) return null;

  const checkpoint = runtimeCheckpoints.find((item) => item.id === draft.checkpointId);
  const outcomeUnknown = draft.kind === 'ado-state'
    && checkpoint?.status === 'failed'
    && checkpoint.error?.retryable === false;

  const fail = async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = draft.kind !== 'ado-state'
      || !(await import('../lib/adoDirect')).isControlledWorkItemStateOutcomeUnknown(error);
    await failAction(message, retryable);
    toast.error(error, '动作执行失败');
    setExecuting(false);
  };

  const done = async (message: string) => {
    await complete(message);
    toast.success(message);
    setExecuting(false);
  };

  const confirm = async () => {
    if (executing) return;
    setExecuting(true);
    const authorization = await begin().catch((error) => ({
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (!authorization.allowed) {
      toast.error(authorization.reason ?? '动作预检未通过');
      setExecuting(false);
      return;
    }
    try {
      if (draft.kind === 'reply') {
        useChat.getState().setDraft(draft.rid!, draft.text.trim());
        await done('回复草稿已放入原会话编辑框，尚未发送');
        try {
          useUI.getState().setModule('messages');
          await useChat.getState().openRoom(draft.rid!);
        } catch (error) {
          toast.error(error, '回复草稿已保存，但无法打开原会话');
        }
        return;
      }
      if (draft.kind === 'send') {
        const result = await useChat.getState().send(draft.text.trim(), {
          rid: draft.rid!,
          clientId: draft.messageId!,
        });
        if (!result) throw new Error('回复发送失败');
        if (result.delivery === 'unknown') {
          throw new Error(result.reason ?? '发送结果暂时无法确认，请检查原会话后重试');
        }
        if (result.delivery === 'failed') throw new Error(result.reason ?? '回复发送失败');
        await done(result.delivery === 'lan' ? '已发送回复（局域网投递）' : '已发送回复');
        return;
      }
      if (draft.kind === 'todo') {
        const id = useTodos.getState().add({
          source: 'manual', title: draft.title.trim(), note: draft.text.trim(), due: draft.due || undefined,
        });
        await awaitLastTodoWrite();
        await done(`已创建待办 ${id}`);
        return;
      }
      if (draft.kind === 'commitment') {
        const id = useTodos.getState().add({
          source: 'manual', title: draft.title.trim(), note: draft.text.trim(),
          committedTo: draft.committedTo!.trim(), due: draft.due || undefined,
        });
        await awaitLastTodoWrite();
        await done(`已记录承诺 ${id}`);
        return;
      }
      if (draft.kind === 'ado-state') {
        const cfg = useWorkbench.getState().config;
        if (!cfg?.adoBase) throw new Error('请先在设置中配置 ADO 直连');
        const currentConfig = {
          adoBase: cfg.adoBase.trim().replace(/\/+$/, ''),
          pat: cfg.pat ?? '',
          auth: cfg.auth,
        };
        const { directGetIdentity, directSetWorkItemStateControlled } = await import('../lib/adoDirect');
        const currentIdentityId = normalizeAdoIdentityId((await directGetIdentity(currentConfig)).id);
        const draftIdentityId = normalizeAdoIdentityId(draft.adoIdentityId);
        if (!draftIdentityId) throw new Error('这张 ADO 状态确认卡缺少身份信息，请重新读取新卡。');
        if (!currentIdentityId) throw new Error('当前 ADO 身份缺少稳定 id，请重新读取新卡。');
        if (currentIdentityId.toLocaleLowerCase() !== draftIdentityId.toLocaleLowerCase()) {
          throw new Error('当前 ADO 身份已变化，请重新读取新卡并核对远端工作项后再确认。');
        }
        const result = await directSetWorkItemStateControlled(
          currentConfig,
          draft.workItemId!,
          draft.targetState!.trim(),
          {
            expectedRevision: draft.expectedRevision!,
            expectedState: draft.currentState!,
          },
        );
        useWorkbench.setState((state) => ({
          workItems: state.workItems.map((item) => item.id === result.item.id ? result.item : item),
        }));
        await done(result.changed
          ? `已把 ADO 工作项 #${draft.workItemId} 改为「${result.item.state}」`
          : `ADO 工作项 #${draft.workItemId} 已经是「${result.item.state}」`);
        return;
      }
      if (draft.kind === 'ado') {
        adoCreated.current = false;
        setAdoOpen(true);
        return;
      }
      const result = await transferConversationToCodexApp(lines.map(({ role, text }) => ({ role, text })));
      if (result === 'unavailable') throw new Error('无法打开 Codex App，也无法复制交接内容');
      await done(result === 'opened' ? '已打开 Codex App 并带入当前记录' : '已准备 Codex 交接内容');
    } catch (error) {
      await fail(error);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-primary/30 bg-primary-light/30 p-3" aria-label={TITLES[draft.kind]}>
        <div className="text-xs font-medium text-primary">
          {TITLES[draft.kind]} · {outcomeUnknown ? '结果待核对' : '等待确认'}
        </div>
        {draft.kind !== 'reply' && draft.kind !== 'send' && draft.kind !== 'ado-state' && draft.kind !== 'codex' ? (
          <input
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
            disabled={executing}
            aria-label="动作标题"
            className="mt-2 h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary"
          />
        ) : null}
        {draft.kind !== 'ado-state' && draft.kind !== 'codex' ? (
          <textarea
            value={draft.text}
            onChange={(event) => update({ text: event.target.value })}
            disabled={executing}
            aria-label="动作内容"
            rows={3}
            className="mt-2 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-sm leading-5 text-ink outline-none focus:border-primary"
          />
        ) : draft.kind === 'codex' ? (
          <p className="mt-2 text-sm text-ink-2">把当前管家对话完整交给 Codex App；确认前不会打开或复制任何内容。</p>
        ) : null}
        {draft.kind === 'ado-state' ? (
          <div className="mt-2 rounded-md border border-line bg-surface p-2.5 text-sm text-ink">
            <div className="font-medium">
              {draft.sources.find((source) => source.kind === 'work-item')?.webUrl ? (
                <a
                  href={draft.sources.find((source) => source.kind === 'work-item')?.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  #{draft.workItemId} {draft.title}
                </a>
              ) : <>#{draft.workItemId} {draft.title}</>}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-ink-2">
              <span>{draft.currentState}</span>
              <span aria-hidden="true">→</span>
              <input
                value={draft.targetState ?? ''}
                onChange={(event) => update({ targetState: event.target.value })}
                disabled={executing || outcomeUnknown}
                aria-label="目标状态"
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-primary"
              />
            </div>
            {outcomeUnknown ? (
              <p className="mt-2 text-xs text-danger" role="status">
                {checkpoint?.error?.message} 同一张卡不会再次写入；请先重新读取远端工作项，再生成新卡。
              </p>
            ) : (
              <p className="mt-2 text-xs text-ink-3">确认后才会写入 Azure DevOps；远端状态已变化时会停止并请你重新确认。</p>
            )}
          </div>
        ) : null}
        {draft.kind === 'commitment' ? (
          <input
            value={draft.committedTo ?? ''}
            onChange={(event) => update({ committedTo: event.target.value })}
            disabled={executing}
            placeholder="我答应给谁（必填）"
            aria-label="我答应给谁"
            className="mt-2 h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary"
          />
        ) : null}
        {draft.kind === 'todo' || draft.kind === 'commitment' ? (
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
            截止日期
            <input type="date" value={draft.due ?? ''} onChange={(event) => update({ due: event.target.value })} disabled={executing} className="h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink" />
          </label>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => void dismiss()} disabled={executing} className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover disabled:opacity-50">取消</button>
          <button type="button" onClick={() => void confirm()} disabled={executing || outcomeUnknown} className="rounded-md bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50">
            {executing ? '执行中…' : outcomeUnknown ? '需重新读取' : draft.kind === 'ado' ? '继续填写' : draft.kind === 'ado-state' ? '确认修改' : draft.kind === 'send' ? '确认发送' : '确认执行'}
          </button>
        </div>
      </div>
      {adoOpen ? (
        <CreateWorkItemDialog
          defaultTitle={draft.title}
          defaultDescription={draft.text}
          rid={draft.rid}
          onCreated={(created) => {
            adoCreated.current = true;
            void done(`已创建 ADO 工作项 #${created[0]?.id ?? ''}`);
          }}
          onClose={() => {
            setAdoOpen(false);
            if (!adoCreated.current) void fail(new Error('已取消 ADO 工作项草稿'));
          }}
        />
      ) : null}
    </>
  );
}
