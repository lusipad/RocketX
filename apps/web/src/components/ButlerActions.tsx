import { Bot, CalendarClock, CheckSquare, Code2, MessageSquareReply, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { auditButlerAction, type ButlerActionKind } from '../lib/butlerActions';
import { useButler, type ButlerLine } from '../stores/butler';
import { transferConversationToCodexApp } from '../stores/butlerCodex';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';
import CreateWorkItemDialog from './CreateWorkItemDialog';

const ACTIONS: Array<{ kind: ButlerActionKind; label: string; icon: typeof Send }> = [
  { kind: 'reply', label: '拟回复', icon: MessageSquareReply },
  { kind: 'todo', label: '转待办', icon: CheckSquare },
  { kind: 'commitment', label: '记承诺', icon: CalendarClock },
  { kind: 'ado', label: '建 ADO', icon: Bot },
  { kind: 'codex', label: '交给 Codex', icon: Code2 },
];

const TITLES: Record<ButlerActionKind, string> = {
  reply: '回复草稿',
  todo: '待办草案',
  commitment: '承诺草案',
  ado: 'ADO 工作项草案',
  codex: 'Codex 交接草案',
};

export function ButlerMessageActions({ line, disabled = false }: { line: ButlerLine; disabled?: boolean }) {
  const propose = useButler((state) => state.proposeAction);
  if (
    line.role !== 'assistant'
    || line.text.startsWith('我是你的管家')
    || line.text.startsWith('📌')
    || line.text.startsWith('✅')
  ) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1 opacity-80 transition hover:opacity-100" aria-label="把结论变成动作">
      {ACTIONS.map(({ kind, label, icon: Icon }) => (
        <button
          key={kind}
          type="button"
          disabled={disabled}
          onClick={() => propose(kind, line.id)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-40"
        >
          <Icon size={10} />{label}
        </button>
      ))}
    </div>
  );
}

export function ButlerActionCard() {
  const draft = useButler((state) => state.actionDraft);
  const lines = useButler((state) => state.lines);
  const update = useButler((state) => state.updateAction);
  const dismiss = useButler((state) => state.dismissAction);
  const complete = useButler((state) => state.completeAction);
  const [executing, setExecuting] = useState(false);
  const [adoOpen, setAdoOpen] = useState(false);

  useEffect(() => {
    setExecuting(false);
    setAdoOpen(false);
  }, [draft?.id]);

  if (!draft) return null;

  const fail = async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await auditButlerAction(draft.kind, 'failed', draft, message).catch(() => undefined);
    toast.error(error, '动作执行失败');
    setExecuting(false);
  };

  const done = async (message: string) => {
    await auditButlerAction(draft.kind, 'executed', draft).catch(() => undefined);
    complete(message);
    toast.success(message);
    setExecuting(false);
  };

  const confirm = async () => {
    if (executing) return;
    if (!draft.text.trim() && draft.kind !== 'codex') return;
    if (draft.kind === 'reply' && !draft.rid) {
      toast.error('这条结论没有可回复的 Rocket.Chat 房间');
      return;
    }
    if (draft.kind === 'commitment' && !draft.committedTo?.trim()) {
      toast.error('请填写“我答应给谁”');
      return;
    }
    setExecuting(true);
    try {
      if (draft.kind === 'reply') {
        useChat.getState().setDraft(draft.rid!, draft.text.trim());
        await done('回复草稿已放入原会话编辑框，尚未发送');
        useUI.getState().setModule('messages');
        await useChat.getState().openRoom(draft.rid!);
        return;
      }
      if (draft.kind === 'todo') {
        const id = useTodos.getState().add({
          source: 'manual', title: draft.title.trim(), note: draft.text.trim(), due: draft.due || undefined,
        });
        await done(`已创建待办 ${id}`);
        return;
      }
      if (draft.kind === 'commitment') {
        const id = useTodos.getState().add({
          source: 'manual', title: draft.title.trim(), note: draft.text.trim(),
          committedTo: draft.committedTo!.trim(), due: draft.due || undefined,
        });
        await done(`已记录承诺 ${id}`);
        return;
      }
      if (draft.kind === 'ado') {
        setAdoOpen(true);
        setExecuting(false);
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
        <div className="text-xs font-medium text-primary">{TITLES[draft.kind]} · 等待确认</div>
        {draft.kind !== 'reply' && draft.kind !== 'codex' ? (
          <input
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
            aria-label="动作标题"
            className="mt-2 h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary"
          />
        ) : null}
        {draft.kind !== 'codex' ? (
          <textarea
            value={draft.text}
            onChange={(event) => update({ text: event.target.value })}
            aria-label="动作内容"
            rows={3}
            className="mt-2 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-sm leading-5 text-ink outline-none focus:border-primary"
          />
        ) : <p className="mt-2 text-sm text-ink-2">把当前 Butler 对话完整交给 Codex App；确认前不会打开或复制任何内容。</p>}
        {draft.kind === 'commitment' ? (
          <input
            value={draft.committedTo ?? ''}
            onChange={(event) => update({ committedTo: event.target.value })}
            placeholder="我答应给谁（必填）"
            aria-label="我答应给谁"
            className="mt-2 h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary"
          />
        ) : null}
        {draft.kind === 'todo' || draft.kind === 'commitment' ? (
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
            截止日期
            <input type="date" value={draft.due ?? ''} onChange={(event) => update({ due: event.target.value })} className="h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink" />
          </label>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={dismiss} disabled={executing} className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover disabled:opacity-50">取消</button>
          <button type="button" onClick={() => void confirm()} disabled={executing} className="rounded-md bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50">
            {executing ? '执行中…' : draft.kind === 'ado' ? '继续填写' : '确认执行'}
          </button>
        </div>
      </div>
      {adoOpen ? (
        <CreateWorkItemDialog
          defaultTitle={draft.title}
          defaultDescription={draft.text}
          rid={draft.rid}
          onCreated={(created) => void done(`已创建 ADO 工作项 #${created[0]?.id ?? ''}`)}
          onClose={() => setAdoOpen(false)}
        />
      ) : null}
    </>
  );
}
