import {
  Bot,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Search,
  Send,
  Share2,
  Square,
  TerminalSquare,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { getServerBase } from '../lib/client';
import { renderMarkdown } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { useAuth } from '../stores/auth';
import { useButler } from '../stores/butler';
import { transferConversationToCodexApp } from '../stores/butlerCodex';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import ButlerProcess from './ButlerProcess';

const QUICK_PROMPTS = [
  '搜索最近关于发布失败的消息',
  '查询我的未完成待办',
  '查询失败的构建',
  '还有哪些需要我处理的 PR',
];

function routineDaysLabel(days?: number[]): string {
  if (!days?.length) return '每天';
  return days.map((day) => `周${'日一二三四五六'[day] ?? day}`).join('、');
}

export default function ButlerConversation({ onCollapse }: { onCollapse: () => void }) {
  const userId = useAuth((state) => state.user?._id);
  const config = useWorkbench((state) => state.config);
  const lastRefresh = useWorkbench((state) => state.lastRefresh);
  const refreshWorkbench = useWorkbench((state) => state.refresh);
  const lines = useButler((state) => state.lines);
  const activity = useButler((state) => state.activity);
  const running = useButler((state) => state.running);
  const butlerError = useButler((state) => state.error);
  const steps = useButler((state) => state.steps);
  const askButler = useButler((state) => state.ask);
  const stopButler = useButler((state) => state.stop);
  const newConversation = useButler((state) => state.newConversation);
  const routineDraft = useButler((state) => state.routineDraft);
  const confirmRoutineDraft = useButler((state) => state.confirmRoutineDraft);
  const dismissRoutineDraft = useButler((state) => state.dismissRoutineDraft);
  const hydrateButler = useButler((state) => state.hydrate);
  const [input, setInput] = useState('');
  const [transferring, setTransferring] = useState(false);
  const hasConversation = lines.some((item) => item.role === 'user');

  const transferToCodex = async () => {
    setTransferring(true);
    try {
      await transferConversationToCodexApp(
        lines.map(({ role, text }) => ({ role, text })),
      );
      toast.success('已转移到 Codex，可在 Codex App / CLI 的会话列表里继续');
    } catch (error) {
      toast.error(error, '转移到 Codex 失败');
    } finally {
      setTransferring(false);
    }
  };

  useEffect(() => {
    if (userId) void hydrateButler();
  }, [hydrateButler, userId]);

  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    lines,
    activity,
    butlerError,
    routineDraft,
    steps,
  ]);

  useEffect(() => {
    if (config && !lastRefresh) void refreshWorkbench();
  }, [config, lastRefresh, refreshWorkbench]);

  const submit = async (text = input) => {
    const value = text.trim();
    if (!value || running) return;
    setInput('');
    stickToBottom.current = true;
    await askButler(value);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface-3">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line bg-surface px-6 py-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
            <Bot size={20} className="text-primary" />管家
          </h1>
          <p className="mt-1 text-xs text-ink-3">直接告诉我你想了解什么，我会先查证据再回答。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void transferToCodex()}
            disabled={running || transferring || !hasConversation}
            title="把当前对话转移到 Codex，在 Codex App / CLI 的会话列表里继续"
            className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover disabled:opacity-50"
          >
            {transferring ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />}
            转到 Codex
          </button>
          <button
            type="button"
            onClick={() => void newConversation()}
            disabled={running}
            title="清空当前对话并开启全新上下文"
            className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover disabled:opacity-50"
          >
            <MessageSquarePlus size={13} />新对话
          </button>
          <button
            type="button"
            onClick={() => useUI.getState().setModule('codex')}
            title="执行间"
            aria-label="执行间"
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
          >
            <TerminalSquare size={13} />执行间
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label="收起对话"
            className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover"
          >
            <ChevronDown size={13} />收起
          </button>
          <div className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-3">
            {config ? 'ADO 已连接' : 'ADO 未配置'} · {getServerBase() ? 'Rocket.Chat 已连接' : '当前站点'}
          </div>
        </div>
      </header>

      <main ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto min-h-full w-full max-w-5xl space-y-3 rounded-xl border border-line bg-surface p-5 shadow-sm">
          {/* 过程显示在它产出的那条回答上方(issue #99):
              最后一行是 assistant 时,步骤插在它前面——先看做了什么,再看结论 */}
          {(() => {
            const splitAt =
              lines.length > 0 && lines[lines.length - 1].role === 'assistant'
                ? lines.length - 1
                : lines.length;
            const renderLine = (line: (typeof lines)[number]) => (
              <div key={line.id} className={`flex gap-3 ${line.role === 'user' ? 'justify-end' : ''}`}>
                {line.role === 'assistant' ? (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
                    <Bot size={15} />
                  </div>
                ) : null}
                <div className={`max-w-[78%] rounded-xl px-3.5 py-2.5 text-sm leading-6 ${line.role === 'user' ? 'bg-primary text-white' : 'bg-fill-1 text-ink'}`}>
                  {line.role === 'assistant' && !line.text.startsWith('📌') ? renderMarkdown(line.text) : line.text}
                </div>
              </div>
            );
            return (
              <>
                {lines.slice(0, splitAt).map(renderLine)}
                <ButlerProcess steps={steps} running={running} className="ml-10" />
                {lines.slice(splitAt).map(renderLine)}
              </>
            );
          })()}
          {butlerError ? (
            <div className="ml-10 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{butlerError}</div>
          ) : null}
          {activity ? (
            <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" />{activity}</div>
          ) : running ? (
            <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" />正在处理请求…</div>
          ) : null}

          {routineDraft ? (
            <div className="ml-10 rounded-lg border border-primary/30 bg-primary-light/40 p-4">
              <div className="text-xs font-medium text-primary">例行事务草案</div>
              <div className="mt-2 font-medium text-ink">{routineDraft.name}</div>
              <div className="mt-1 text-sm text-ink-2">{routineDraft.time} · {routineDaysLabel(routineDraft.days)} · 技能：{routineDraft.skillName}</div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" onClick={dismissRoutineDraft} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover">取消</button>
                <button type="button" onClick={confirmRoutineDraft} className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover">确认启用</button>
              </div>
            </div>
          ) : null}
        </div>
      </main>

      <footer className="shrink-0 border-t border-line bg-surface px-6 py-3">
        <div className="mx-auto w-full max-w-5xl">
          <div className="mb-2 flex flex-wrap gap-2">
            {QUICK_PROMPTS.map((prompt) => (
              <button key={prompt} type="button" onClick={() => void submit(prompt)} disabled={running} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50">{prompt}</button>
            ))}
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-sm focus-within:border-primary">
            <Search size={17} className="ml-2 text-ink-3" />
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：搜索张三提到的发布问题；查询失败构建；还有哪些需要我处理的 PR…" className="h-10 min-w-0 flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-3" />
            {running ? (
              <button type="button" onClick={() => void stopButler()} className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover">
                <Square size={13} />停止
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()} className="flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm text-white hover:bg-primary-hover disabled:opacity-50"><Send size={14} />发送</button>
            )}
          </form>
        </div>
      </footer>
    </div>
  );
}
