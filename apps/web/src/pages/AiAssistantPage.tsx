import { Bot, Loader2, Search, Send, TerminalSquare } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getServerBase } from '../lib/client';
import { renderMarkdown } from '../lib/markdown';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import { useButler } from '../stores/butler';

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

export default function AiAssistantPage() {
  const config = useWorkbench((state) => state.config);
  const lastRefresh = useWorkbench((state) => state.lastRefresh);
  const refreshWorkbench = useWorkbench((state) => state.refresh);
  const lines = useButler((state) => state.lines);
  const activity = useButler((state) => state.activity);
  const running = useButler((state) => state.running);
  const butlerError = useButler((state) => state.error);
  const askButler = useButler((state) => state.ask);
  const routineDraft = useButler((state) => state.routineDraft);
  const confirmRoutineDraft = useButler((state) => state.confirmRoutineDraft);
  const dismissRoutineDraft = useButler((state) => state.dismissRoutineDraft);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // 预取工作台数据，AI 的 list_work_items/list_pull_requests/list_builds 工具直接读它
  useEffect(() => {
    if (config && !lastRefresh) void refreshWorkbench();
  }, [config, lastRefresh, refreshWorkbench]);

  // 打开页面和新内容到达时停在最新对话；用户滚上去阅读时不跟随（issue #90）
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines, activity, butlerError, routineDraft]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };

  /** 所有输入都交给 AI 大脑理解和回答，不做本地正则拆解（issue #89） */
  const submit = async (text = input) => {
    const value = text.trim();
    if (!value || running) return;
    setInput('');
    stickToBottom.current = true; // 发送后总是回到最新
    await askButler(value);
  };

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="min-w-0 flex-1 overflow-y-auto bg-surface-3">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col px-8 py-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xl font-semibold text-ink"><Bot size={20} className="text-primary" />AI</div>
            <p className="mt-1 text-sm text-ink-3">直接告诉我你想了解什么，我会先查证据再回答。</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button onClick={() => useUI.getState().setModule('codex')} title="执行间" aria-label="执行间" className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover">
              <TerminalSquare size={13} />执行间
            </button>
            <div className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-3">
              {config ? 'ADO 已连接' : 'ADO 未配置'} · {getServerBase() ? 'Rocket.Chat 已连接' : '当前站点'}
            </div>
          </div>
        </div>

        <div className="mt-6 flex-1 space-y-3 rounded-xl border border-line bg-surface p-5 shadow-sm">
          {lines.map((line) => (
            <div key={line.id} className={`flex gap-3 ${line.role === 'user' ? 'justify-end' : ''}`}>
              {line.role === 'assistant' ? <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary"><Bot size={15} /></div> : null}
              <div className={`max-w-[78%] rounded-xl px-3.5 py-2.5 text-sm leading-6 ${line.role === 'user' ? 'bg-primary text-white' : 'bg-fill-1 text-ink'}`}>
                {line.role === 'assistant' && !line.text.startsWith('📌') ? renderMarkdown(line.text) : line.text}
              </div>
            </div>
          ))}
          {butlerError ? <div className="ml-10 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{butlerError}</div> : null}
          {activity ? <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" />{activity}</div> : running ? <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" />正在处理请求…</div> : null}

          {routineDraft ? (
            <div className="ml-10 rounded-lg border border-primary/30 bg-primary-light/40 p-4">
              <div className="text-xs font-medium text-primary">例行事务草案</div>
              <div className="mt-2 font-medium text-ink">{routineDraft.name}</div>
              <div className="mt-1 text-sm text-ink-2">{routineDraft.time} · {routineDaysLabel(routineDraft.days)} · 技能：{routineDraft.skillName}</div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button onClick={dismissRoutineDraft} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover">取消</button>
                <button onClick={confirmRoutineDraft} className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover">确认启用</button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((prompt) => <button key={prompt} onClick={() => void submit(prompt)} disabled={running} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50">{prompt}</button>)}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-sm focus-within:border-primary">
          <Search size={17} className="ml-2 text-ink-3" />
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：搜索张三提到的发布问题；查询失败构建；还有哪些需要我处理的 PR…" className="h-10 min-w-0 flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-3" />
          <button type="submit" disabled={running || !input.trim()} className="flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm text-white hover:bg-primary-hover disabled:opacity-50"><Send size={14} />发送</button>
        </form>
      </div>
    </div>
  );
}
