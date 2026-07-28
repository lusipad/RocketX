import {
  ChevronDown,
  Loader2,
  Send,
  Share2,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { useAuth } from '../stores/auth';
import { butlerRecapAgoLabel, butlerSessionRecap, useButler } from '../stores/butler';
import {
  BUTLER_BOUNDARY_NOTE,
  BUTLER_SCENE_PROMPTS,
  butlerSlashQuery,
  filterButlerSlashOptions,
} from '../lib/butlerPrompts';
import { transferConversationToCodexApp } from '../stores/butlerCodex';
import { toast } from '../stores/toast';
import { useWorkbench } from '../stores/workbench';
import ButlerSlashMenu, { useSlashMenu } from './ButlerSlashMenu';
import ButlerProcess from './ButlerProcess';
import ButlerSources from './ButlerSources';
import ButlerConclusionActions from './ButlerConclusionActions';
import ButlerArtifactsPanel from './ButlerArtifactsPanel';
import ButlerConversationHistory from './ButlerConversationHistory';
import ButlerErrandCard from './ButlerErrandCard';
import ButlerErrandRunCard from './ButlerErrandRunCard';
import { ButlerActionCard, ButlerMessageActions } from './ButlerActions';
import ButlerImagePicker, {
  ButlerImageAttachments,
  ButlerImagePreviews,
  pasteButlerImages,
} from './ButlerImagePicker';
import ButlerSessionSwitcher from './ButlerSessionSwitcher';
import ButlerToolApprovals from './ButlerToolApprovals';
import type { ButlerImageInput } from '../lib/butlerImages';
import { useButlerArtifacts } from '../stores/butlerArtifacts';

const RECAP_GAP_MS = 30 * 60 * 1000;

function routineDaysLabel(days?: number[]): string {
  if (!days?.length) return '每天';
  return days.map((day) => `周${'日一二三四五六'[day] ?? day}`).join('、');
}

export default function ButlerConversation({
  embedded = false,
}: {
  embedded?: boolean;
}) {
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
  const routineDraft = useButler((state) => state.routineDraft);
  const errandDraft = useButler((state) => state.errandDraft);
  const errands = useButler((state) => state.errands);
  const runtimeCheckpoints = useButler((state) => state.runtimeCheckpoints);
  const actionDraft = useButler((state) => state.actionDraft);
  const confirmRoutineDraft = useButler((state) => state.confirmRoutineDraft);
  const dismissRoutineDraft = useButler((state) => state.dismissRoutineDraft);
  const hydrateButler = useButler((state) => state.hydrate);
  const context = useButler((state) => state.context);
  const hydrateArtifacts = useButlerArtifacts((state) => state.hydrate);
  const captureArtifactLine = useButlerArtifacts((state) => state.captureLine);
  const artifacts = useButlerArtifacts((state) => state.artifacts);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ButlerImageInput[]>([]);
  const [transferring, setTransferring] = useState(false);
  const hasConversation = lines.some((item) => item.role === 'user');
  // 打 / 唤起能力菜单：选中只填输入框不发送（例句里的人名编号是占位符）
  const slashQuery = butlerSlashQuery(input);
  const slashOptions = useMemo(
    () => (slashQuery === null ? [] : filterButlerSlashOptions(slashQuery)),
    [slashQuery],
  );
  const slash = useSlashMenu(slashOptions);
  const pickSlashOption = (option: { prompt: string }): void => {
    setInput(option.prompt);
    slash.dismiss();
  };
  const sessions = useButler((state) => state.sessions);
  const activeSessionId = useButler((state) => state.activeSessionId);
  const activeSummary = sessions.find((session) => session.id === activeSessionId);
  // 锚定在「进入这个会话时」：updatedAt 走 500ms 防抖落盘，而 lines 是实时的，
  // 不锚就会把用户刚发出的那句话当成「3 天前你问的」显示出来。本轮一有新提问就撤卡。
  const askCount = lines.reduce((count, item) => count + (item.role === 'user' ? 1 : 0), 0);
  const [recapAnchor, setRecapAnchor] = useState<{ sessionId: string; askCount: number } | null>(null);
  if (recapAnchor?.sessionId !== activeSessionId) setRecapAnchor({ sessionId: activeSessionId, askCount });
  const recap = hasConversation
    && activeSummary
    && recapAnchor?.sessionId === activeSessionId
    && recapAnchor.askCount === askCount
    && Date.now() - activeSummary.updatedAt > RECAP_GAP_MS
    ? butlerSessionRecap(lines)
    : null;
  const routineCheckpoint = routineDraft
    ? runtimeCheckpoints.find((item) => item.id === routineDraft.checkpointId)
    : undefined;

  const transferToCodex = async () => {
    setTransferring(true);
    try {
      const result = await transferConversationToCodexApp(
        lines.map(({ role, text }) => ({ role, text })),
      );
      if (result === 'unavailable') throw new Error('无法打开 Codex App，也无法复制对话记录');
      toast.success(
        result === 'opened'
          ? '已打开 Codex App，完整记录已填入，请确认后发送'
          : result === 'opened-with-copy'
            ? '对话较长：已打开 Codex App 并复制完整记录，请粘贴后发送'
            : 'Codex App 打开失败，完整记录已复制',
      );
    } catch (error) {
      toast.error(error, '在 Codex App 打开失败');
    } finally {
      setTransferring(false);
    }
  };

  useEffect(() => {
    if (userId) void hydrateButler();
  }, [hydrateButler, userId]);

  useEffect(() => {
    hydrateArtifacts();
  }, [hydrateArtifacts]);

  useEffect(() => {
    for (const conversationLine of lines) captureArtifactLine(conversationLine);
  }, [captureArtifactLine, lines]);

  // 漏一个就等于那张卡不存在：它渲染在消息之后，不触发自动滚动就永远在视口下方。
  // 真机上「从桌面页派活」因此整条链路静默失败——卡片在，只是没人看得见。
  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    lines,
    activity,
    butlerError,
    routineDraft,
    errandDraft,
    errands,
    runtimeCheckpoints,
    actionDraft,
    steps,
  ]);

  useEffect(() => {
    if (config && !lastRefresh) void refreshWorkbench();
  }, [config, lastRefresh, refreshWorkbench]);

  const submit = async (text = input) => {
    const value = text.trim();
    if ((!value && !images.length) || running) return;
    const submittedImages = images;
    setInput('');
    setImages([]);
    stickToBottom.current = true;
    await askButler(value, undefined, submittedImages);
  };

  return (
    <div className={`butler-conversation-layout ${embedded ? 'bg-transparent' : 'bg-surface'}`}>
      <ButlerConversationHistory />
      <div className="butler-conversation-pane">
        <header className="butler-conversation-header">
          <div className="min-w-0">
            <span>完整对话</span>
            <h2>{activeSummary?.title || '新对话'}</h2>
            <p>
              {context ? `当前工作面：${context.label}` : '多轮讨论留在这里，结论会写回今天的纸。'}
            </p>
          </div>
          <div className="butler-conversation-header-actions">
            <div className="butler-conversation-mobile-switcher">
              <ButlerSessionSwitcher compact />
            </div>
            <div className="butler-conversation-session-actions">
              <ButlerSessionSwitcher compact actionsOnly />
            </div>
            <button
              type="button"
              onClick={() => void transferToCodex()}
              disabled={running || transferring || !hasConversation}
              aria-label="在 Codex App 打开"
              title="在 Codex App 打开新对话并填好当前完整记录，由你按回车发出"
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-40"
            >
              {transferring ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <Share2 size={13} />}
              Codex
            </button>
          </div>
        </header>

        {errands.some((errand) => !errand.archivedAt) ? (
          <details className="group shrink-0 border-b border-line/70 px-6">
            <summary className="mx-auto flex max-w-[840px] cursor-pointer list-none items-center justify-between py-2 text-xs text-ink-3 hover:text-ink">
              <span>{errands.filter((errand) => !errand.archivedAt).length} 件在办</span>
              <ChevronDown
                size={13}
                className="transition-transform motion-reduce:transition-none group-open:rotate-180"
              />
            </summary>
            <div className="mx-auto max-h-[36vh] max-w-[840px] overflow-y-auto pb-4">
              <ButlerErrandRunCard />
            </div>
          </details>
        ) : null}

        <main ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto min-h-full w-full max-w-[840px] space-y-5">
            <ButlerArtifactsPanel
              onContinue={(title) => setInput(`继续加工成果“${title}”：`)}
            />

          {recap && activeSummary ? (
            <div className="sticky top-0 z-10 border-l border-primary/45 bg-surface py-1 pl-4 text-xs leading-5 text-ink-2">
              <span className="font-medium text-ink">上回说到</span>
              （{butlerRecapAgoLabel(activeSummary.updatedAt)}）：你问「{recap.lastAsk}」
              {recap.lastReply ? <>，我答到「{recap.lastReply}」</> : null}。接着说就能继续。
            </div>
          ) : null}
          {!hasConversation && (
            <details className="group text-xs text-ink-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 hover:text-ink">
                可以这样问
                <ChevronDown
                  size={13}
                  className="transition-transform motion-reduce:transition-none group-open:rotate-180"
                />
              </summary>
              <div className="mt-2 flex flex-col items-start gap-1">
                {BUTLER_SCENE_PROMPTS.map((item) => (
                  <button
                    key={item.scene}
                    type="button"
                    onClick={() => setInput(item.prompt)}
                    className="py-1 text-left text-xs text-ink-2 hover:text-ink"
                  >
                    <span className="mr-2 text-ink-3">{item.scene}</span>
                    {item.prompt}
                  </button>
                ))}
                <div className="mt-2 border-t border-line pt-2 text-xs text-ink-3">{BUTLER_BOUNDARY_NOTE}</div>
              </div>
            </details>
          )}
          {/* 过程显示在它产出的那条回答上方(issue #99):
              最后一行是 assistant 时,步骤插在它前面——先看做了什么,再看结论 */}
          {(() => {
            const splitAt =
              lines.length > 0 && lines[lines.length - 1].role === 'assistant'
                ? lines.length - 1
                : lines.length;
            const renderLine = (line: (typeof lines)[number]) => {
              const mine = line.role === 'user';
              const artifact = artifacts.find((candidate) => candidate.sourceLineId === line.id);
              return (
                <article
                  key={line.id}
                  data-speaker={line.role}
                  aria-label={mine ? '你说' : '管家说'}
                  className={`flex pb-3 ${mine ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`flex min-w-0 flex-col ${
                      mine ? 'max-w-[82%] items-end sm:max-w-[68%]' : 'max-w-[88%] items-start sm:max-w-[82%]'
                    }`}
                  >
                    <div className="mb-1 text-[11px] font-medium text-ink-3">
                      {mine ? '你' : '管家'}
                    </div>
                    <div
                      className={`min-w-0 break-words rounded-lg px-3 py-2 text-sm leading-7 text-ink ${
                        mine ? 'rounded-tr-sm bg-bubble-mine' : 'rounded-tl-sm bg-bubble-other/60'
                      }`}
                    >
                      {artifact ? (
                        <div className="butler-artifact-message">
                          <span>已生成{artifact.kind === 'draft' ? '草稿' : artifact.kind === 'diff' ? '变更' : artifact.kind === 'checklist' ? '清单' : '报告'}成果</span>
                          <strong>{artifact.title}</strong>
                          <small>完整内容、来源和版本已放在上方成果工作面。</small>
                        </div>
                      ) : line.role === 'assistant' ? (
                        <ButlerSources sources={line.sources} text={line.text}>
                          {(renderLink) => line.text.startsWith('📌')
                            ? line.text
                            : renderMarkdown(line.text, undefined, renderLink)}
                        </ButlerSources>
                      ) : line.text}
                      {line.role === 'user' ? <ButlerImageAttachments attachments={line.attachments} /> : null}
                      {line.role === 'assistant' ? <ButlerConclusionActions line={line} disabled={running} /> : null}
                      <ButlerMessageActions line={line} disabled={running} />
                    </div>
                  </div>
                </article>
              );
            };
            return (
              <>
                {lines.slice(0, splitAt).map(renderLine)}
                <ButlerProcess steps={steps} running={running} className="border-l-2 border-primary/35 pl-4" />
                {lines.slice(splitAt).map(renderLine)}
              </>
            );
          })()}
          {butlerError ? (
            <div className="border-l border-danger pl-4 text-sm text-danger">{butlerError}</div>
          ) : null}
          {activity ? (
            <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />{activity}</div>
          ) : running ? (
            <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />正在处理请求…</div>
          ) : null}

          <ButlerToolApprovals />

          {routineDraft ? (
            <div className="border-l border-primary/45 pl-4">
              <div className="text-xs font-medium text-primary">例行事务草案</div>
              <div className="mt-2 font-medium text-ink">{routineDraft.name}</div>
              <div className="mt-1 text-sm text-ink-2">{routineDraft.time} · {routineDaysLabel(routineDraft.days)} · 技能：{routineDraft.skillName}</div>
              {routineCheckpoint?.error ? (
                <div className="mt-1 text-xs text-danger">{routineCheckpoint.error.message}</div>
              ) : null}
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" onClick={() => void dismissRoutineDraft()} className="h-7 rounded px-2 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink">取消</button>
                <button type="button" onClick={() => void confirmRoutineDraft()} className="h-7 rounded bg-primary px-2.5 text-xs text-white hover:bg-primary-hover">确认启用</button>
              </div>
            </div>
          ) : null}
          <ButlerErrandCard />
          <ButlerActionCard />
          </div>
        </main>

        <footer className="butler-conversation-footer">
          <div className="mx-auto w-full max-w-[840px]">
            <form
              aria-label="发送消息给管家"
              onSubmit={(event) => { event.preventDefault(); void submit(); }}
              className="butler-conversation-composer"
            >
            <ButlerSlashMenu
              options={slashOptions}
              activeIndex={slash.activeIndex}
              onPick={pickSlashOption}
              onHover={slash.setActiveIndex}
            />
            <div className="min-w-0 flex-1">
              <ButlerImagePreviews images={images} onChange={setImages} />
              <div className="flex items-end">
                <ButlerImagePicker images={images} onChange={setImages} disabled={running} />
                <textarea
                  rows={2}
                  value={input}
                  onChange={(event) => { setInput(event.target.value); slash.reopen(); }}
                  onKeyDown={(event) => {
                    if (slash.handleKeyDown(event, pickSlashOption)) return;
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  onBlur={() => slash.dismiss()}
                  onPaste={(event) => void pasteButlerImages(event, images, setImages)}
                  aria-label="给管家发消息"
                  placeholder="给管家发消息……"
                  className="min-h-12 w-full min-w-0 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-ink outline-none placeholder:text-ink-3"
                />
              </div>
            </div>
            {running ? (
              <button type="button" aria-label="停止回答" title="停止回答" onClick={() => void stopButler()} className="flex h-8 w-8 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink">
                <Square size={12} />
              </button>
            ) : (
              <button type="submit" aria-label="发送" title="发送" disabled={!input.trim() && !images.length} className="flex h-8 w-8 items-center justify-center rounded text-primary hover:bg-primary-light disabled:text-ink-3/40"><Send size={14} /></button>
            )}
            </form>
            <p>Enter 发送 · Shift + Enter 换行</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
