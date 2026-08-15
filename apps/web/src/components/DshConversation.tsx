import { open } from '@tauri-apps/plugin-dialog';
import { Check, CircleAlert, FolderOpen, KeyRound, Loader2, PanelLeft, RefreshCw, Send, SlidersHorizontal, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { isTauriRuntime } from '../lib/client';
import {
  useDshWorkspace,
  type DshPendingApproval,
  type DshPendingQuestion,
  type DshQuestionAnswer,
} from '../stores/dshWorkspace';
import { toast } from '../stores/toast';
import type { DshMessage } from '../agent/dsh/project';
import { selectedModel, type DshModelSelection } from '../agent/dsh/config';
import DshConversationHistory from './DshConversationHistory';
import { workspaceLabel } from './DshConversationShared';
import Dialog from './Dialog';

function DshMessageBubble({ entry }: { entry: DshMessage }) {
  return (
    <article data-speaker={entry.role === 'system' ? 'assistant' : entry.role} className="codex-native-message">
      <span>{entry.role === 'assistant' ? 'DeepSeek' : entry.role === 'system' ? '系统' : '你'}</span>
      <div className="butler-conversation-markdown">
        {entry.streaming
          ? entry.text
          : entry.role === 'assistant' || entry.role === 'system' ? renderMarkdown(entry.text) : entry.text}
      </div>
    </article>
  );
}

function ApprovalCard({
  approval,
  respondApproval,
}: {
  approval: DshPendingApproval;
  respondApproval: (approved: boolean) => Promise<void>;
}) {
  return (
    <section className="codex-native-request" aria-label="DeepSeek 请求审批">
      <header>
        <CircleAlert size={15} aria-hidden="true" />
        <strong>DeepSeek 需要确认</strong>
      </header>
      <pre>{approval.reason || `运行工具：${approval.toolName}`}</pre>
      <footer>
        <button type="button" onClick={() => void respondApproval(false).catch((error) => toast.error(error, '无法提交审批'))}>
          拒绝
        </button>
        <button type="button" className="is-primary" onClick={() => void respondApproval(true).catch((error) => toast.error(error, '无法提交审批'))}>
          允许一次
        </button>
      </footer>
    </section>
  );
}

export function DshQuestionCard({
  question,
  respondQuestion,
}: {
  question: DshPendingQuestion;
  respondQuestion: (answers: DshQuestionAnswer[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const canSubmit = question.questions.every((item) => (
    (selected[item.id]?.length ?? 0) > 0 || !!custom[item.id]?.trim()
  ));

  const toggleOption = (questionId: string, label: string, multiSelect: boolean): void => {
    setSelected((current) => {
      const values = current[questionId] ?? [];
      if (!multiSelect) return { ...current, [questionId]: [label] };
      return {
        ...current,
        [questionId]: values.includes(label)
          ? values.filter((value) => value !== label)
          : [...values, label],
      };
    });
  };

  return (
    <form
      className="dsh-question-card"
      aria-label="DeepSeek 问题"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        const answers = question.questions.map((item): DshQuestionAnswer => ({
          id: item.id,
          selected: selected[item.id] ?? [],
          ...(custom[item.id]?.trim() ? { custom: custom[item.id].trim() } : {}),
        }));
        void respondQuestion(answers).catch((error) => toast.error(error, '无法提交回答'));
      }}
    >
      <header>
        <Check size={15} aria-hidden="true" />
        <strong>DeepSeek 需要更多信息</strong>
      </header>
      {question.questions.map((item) => (
        <fieldset key={item.id} className="dsh-question-field">
          <legend>{item.header || item.question}</legend>
          {item.header ? <p>{item.question}</p> : null}
          {item.detail ? <small>{item.detail}</small> : null}
          {item.options?.map((option) => (
            <label key={option.label}>
              <input
                type={item.multiSelect ? 'checkbox' : 'radio'}
                name={`dsh-question-${item.id}`}
                checked={(selected[item.id] ?? []).includes(option.label)}
                onChange={() => toggleOption(item.id, option.label, item.multiSelect === true)}
              />
              <span>{option.label}</span>
              {option.description ? <small>{option.description}</small> : null}
            </label>
          ))}
          <input
            type="text"
            value={custom[item.id] ?? ''}
            placeholder={item.options?.length ? '其他补充（可选）' : '请输入回答'}
            onChange={(event) => setCustom((current) => ({ ...current, [item.id]: event.target.value }))}
          />
        </fieldset>
      ))}
      <footer>
        <button type="submit" disabled={!canSubmit}>提交回答</button>
      </footer>
    </form>
  );
}

function CredentialCard({
  credentialConfigured,
  credentialWritable,
  setDeepSeekApiKey,
  clearDeepSeekApiKey,
}: {
  credentialConfigured: boolean;
  credentialWritable: boolean;
  setDeepSeekApiKey: (apiKey: string) => Promise<void>;
  clearDeepSeekApiKey: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await setDeepSeekApiKey(apiKey.trim());
      toast.success('DeepSeek API Key 已配置');
    } catch (error) {
      toast.error(error, '无法配置 DeepSeek API Key');
    } finally {
      setApiKey('');
      setSaving(false);
    }
  };

  return (
    <section className="dsh-credential-card" aria-label="DeepSeek 凭据">
      <header>
        <strong>DeepSeek API Key</strong>
        <span>{credentialConfigured ? '已配置' : '未配置'}</span>
      </header>
      {!credentialConfigured ? (
        <>
          <p>连接 DeepSeek 前需要先配置最小凭据。</p>
          <div>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              aria-label="DeepSeek API Key"
              placeholder="输入 DeepSeek API Key"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button type="button" disabled={!credentialWritable || saving || !apiKey.trim()} onClick={() => void save()}>
              {saving ? '配置中' : '配置'}
            </button>
          </div>
        </>
      ) : (
        <div className="dsh-credential-actions">
          <p>凭据已配置，不会显示到日志或活动列表。</p>
          <div>
            {credentialWritable ? (
              <>
                <button
                  type="button"
                  onClick={() => void clearDeepSeekApiKey().catch((error) => toast.error(error, '无法删除凭据'))}
                >
                  删除
                </button>
                <input
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  aria-label="新的 DeepSeek API Key"
                  placeholder="输入新的 DeepSeek API Key"
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <button type="button" disabled={saving || !apiKey.trim()} onClick={() => void save()}>
                  {saving ? '保存中' : '更换'}
                </button>
              </>
            ) : (
              <span>当前凭据不可由此视图修改</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function modelValue(selection: Pick<DshModelSelection, 'provider' | 'model'>): string {
  return JSON.stringify([selection.provider, selection.model]);
}

function parseModelValue(value: string): Pick<DshModelSelection, 'provider' | 'model'> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      ? { provider: parsed[0], model: parsed[1] }
      : null;
  } catch {
    return null;
  }
}

function DshConfigurationCard() {
  const configurationStatus = useDshWorkspace((state) => state.configurationStatus);
  const configurationError = useDshWorkspace((state) => state.configurationError);
  const configurationWritable = useDshWorkspace((state) => state.configurationWritable);
  const modelSelection = useDshWorkspace((state) => state.modelSelection);
  const modelGroups = useDshWorkspace((state) => state.modelGroups);
  const modelFailures = useDshWorkspace((state) => state.modelFailures);
  const agentPresets = useDshWorkspace((state) => state.agentPresets);
  const defaultAgentPreset = useDshWorkspace((state) => state.defaultAgentPreset);
  const permissionPresets = useDshWorkspace((state) => state.permissionPresets);
  const defaultPermissionPreset = useDshWorkspace((state) => state.defaultPermissionPreset);
  const activePermission = useDshWorkspace((state) => state.activePermission);
  const activeSessionId = useDshWorkspace((state) => state.activeSessionId);
  const sessions = useDshWorkspace((state) => state.sessions);
  const refreshConfiguration = useDshWorkspace((state) => state.refreshConfiguration);
  const selectModel = useDshWorkspace((state) => state.selectModel);
  const selectAgentPreset = useDshWorkspace((state) => state.selectAgentPreset);
  const selectPermissionPreset = useDshWorkspace((state) => state.selectPermissionPreset);
  const [saving, setSaving] = useState<'model' | 'agent' | 'permission' | null>(null);
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const currentModel = selectedModel(modelGroups, modelSelection);
  const permissionOptions = activePermission?.options.length ? activePermission.options : permissionPresets;
  const permissionValue = activePermission?.currentValue ?? defaultPermissionPreset ?? '';
  const loading = configurationStatus === 'connecting';

  const save = async (
    kind: 'model' | 'agent' | 'permission',
    action: () => Promise<void>,
    success: string,
  ): Promise<void> => {
    setSaving(kind);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(error, '无法更新 DeepSeek 配置');
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="dsh-configuration-card" aria-label="DeepSeek 运行配置">
      <header>
        <div>
          <SlidersHorizontal size={15} aria-hidden="true" />
          <strong>DeepSeek 运行配置</strong>
        </div>
        <button
          type="button"
          disabled={loading || saving !== null}
          onClick={() => void refreshConfiguration().catch((error) => toast.error(error, '无法刷新 DeepSeek 配置'))}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" />
          刷新
        </button>
      </header>
      <p>直接读写 DSH 原生配置；AI 托管创建的新会话也使用这些默认值。</p>

      <div className="dsh-configuration-grid">
        <label>
          <span>模型与提供方</span>
          <select
            aria-label="DeepSeek 模型与提供方"
            value={modelSelection ? modelValue(modelSelection) : ''}
            disabled={loading || saving !== null || modelGroups.length === 0}
            onChange={(event) => {
              const next = parseModelValue(event.target.value);
              if (!next) return;
              const model = modelGroups.find((group) => group.id === next.provider)
                ?.models.find((entry) => entry.id === next.model);
              void save('model', () => selectModel({
                ...next,
                ...(model?.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
              }), 'DeepSeek 模型已切换');
            }}
          >
            {!modelSelection ? <option value="">选择模型</option> : null}
            {modelSelection && !currentModel ? (
              <option value={modelValue(modelSelection)}>{modelSelection.provider} / {modelSelection.model}</option>
            ) : null}
            {modelGroups.map((group) => (
              <optgroup key={group.id} label={`${group.name} (${group.id})`}>
                {group.models.map((model) => (
                  <option key={model.id} value={modelValue({ provider: group.id, model: model.id })}>{model.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <small>切换当前会话，并由 DSH 保存为后续会话默认模型。</small>
        </label>

        <label>
          <span>推理强度</span>
          <select
            aria-label="DeepSeek 推理强度"
            value={modelSelection?.reasoningEffort ?? ''}
            disabled={loading || saving !== null || !modelSelection || !currentModel?.reasoning?.efforts.length}
            onChange={(event) => {
              if (!modelSelection) return;
              void save('model', () => selectModel({
                provider: modelSelection.provider,
                model: modelSelection.model,
                ...(event.target.value ? { reasoningEffort: event.target.value } : {}),
              }), 'DeepSeek 推理强度已切换');
            }}
          >
            <option value="">提供方默认</option>
            {currentModel?.reasoning?.efforts.map((effort) => (
              <option key={effort.id} value={effort.id}>{effort.name}</option>
            ))}
          </select>
          <small>选项由当前模型适配器提供；没有公布时保持提供方默认。</small>
        </label>

        <label>
          <span>Agent preset</span>
          <select
            aria-label="DeepSeek Agent preset"
            value={defaultAgentPreset ?? ''}
            disabled={loading || saving !== null || !configurationWritable || agentPresets.length === 0}
            onChange={(event) => void save('agent', () => selectAgentPreset(event.target.value), 'DeepSeek Agent preset 已保存')}
          >
            {agentPresets.filter((preset) => !preset.broken).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name || preset.id}{preset.trust === 'user' ? '（本地）' : ''}
              </option>
            ))}
          </select>
          <small>
            后续会话使用该 preset；当前空白会话同步切换
            {activeSession?.agentPreset ? `，当前为 ${activeSession.agentPreset}` : ''}。
          </small>
        </label>

        <label>
          <span>权限与审批</span>
          <select
            aria-label="DeepSeek 权限与审批"
            value={permissionValue}
            disabled={loading || saving !== null || !configurationWritable || permissionOptions.length === 0}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'danger-full-access' && !window.confirm('完全访问会关闭逐项审批，并允许 DSH 访问工作区外的文件。确认继续？')) return;
              void save('permission', () => selectPermissionPreset(next), 'DeepSeek 权限 preset 已保存');
            }}
          >
            {permissionValue === 'custom' ? <option value="custom" disabled>自定义</option> : null}
            {permissionOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
          <small>同时更新当前会话和后续会话默认；审批请求仍在 RocketX 中处理。</small>
        </label>
      </div>

      {!configurationWritable && configurationStatus === 'ready' ? <p role="status">当前 DSH 设置只读。</p> : null}
      {modelFailures.length > 0 ? (
        <details>
          <summary>{modelFailures.length} 个提供方目录读取失败</summary>
          {modelFailures.map((failure) => <p key={failure.id}>{failure.name}：{failure.message}</p>)}
        </details>
      ) : null}
      {configurationError ? <p role="alert">{configurationError}</p> : null}
    </section>
  );
}

async function chooseWorkspaceDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error('网页版没有本地 DeepSeek 执行面，请使用 RocketX 桌面端');
  const path = await open({ directory: true, multiple: false, title: '选择 DeepSeek 工作区' });
  return typeof path === 'string' ? path : null;
}

export default function DshConversation() {
  const status = useDshWorkspace((state) => state.status);
  const error = useDshWorkspace((state) => state.error);
  const workspaceRoot = useDshWorkspace((state) => state.workspaceRoot);
  const sessions = useDshWorkspace((state) => state.sessions);
  const activeSessionId = useDshWorkspace((state) => state.activeSessionId);
  const messages = useDshWorkspace((state) => state.messages);
  const activities = useDshWorkspace((state) => state.activities);
  const pendingApproval = useDshWorkspace((state) => state.pendingApproval);
  const pendingQuestion = useDshWorkspace((state) => state.pendingQuestion);
  const queuedMessages = useDshWorkspace((state) => state.queuedMessages);
  const isRunning = useDshWorkspace((state) => state.isRunning);
  const credentialConfigured = useDshWorkspace((state) => state.credentialConfigured);
  const credentialWritable = useDshWorkspace((state) => state.credentialWritable);
  const setWorkspaceRoot = useDshWorkspace((state) => state.setWorkspaceRoot);
  const connect = useDshWorkspace((state) => state.connect);
  const refresh = useDshWorkspace((state) => state.refresh);
  const send = useDshWorkspace((state) => state.send);
  const cancel = useDshWorkspace((state) => state.cancel);
  const respondApproval = useDshWorkspace((state) => state.respondApproval);
  const respondQuestion = useDshWorkspace((state) => state.respondQuestion);
  const setDeepSeekApiKey = useDshWorkspace((state) => state.setDeepSeekApiKey);
  const clearDeepSeekApiKey = useDshWorkspace((state) => state.clearDeepSeekApiKey);
  const modelSelection = useDshWorkspace((state) => state.modelSelection);
  const modelGroups = useDshWorkspace((state) => state.modelGroups);
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyCloseRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) ?? null, [activeSessionId, sessions]);
  const currentModel = selectedModel(modelGroups, modelSelection);
  const currentProvider = modelGroups.find((group) => group.id === modelSelection?.provider);
  const currentReasoning = currentModel?.reasoning?.efforts.find((effort) => effort.id === modelSelection?.reasoningEffort);
  const modelSummary = modelSelection
    ? `${currentProvider?.name ?? modelSelection.provider} / ${currentModel?.name ?? modelSelection.model}${modelSelection.reasoningEffort ? ` · ${currentReasoning?.name ?? modelSelection.reasoningEffort}` : ''}`
    : '未选择';
  const latestActivity = activities.at(-1);
  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    messages, activities, queuedMessages, pendingApproval, pendingQuestion, error,
  ]);

  const closeHistory = useCallback((): void => {
    setHistoryOpen(false);
    requestAnimationFrame(() => historyButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!workspaceRoot || status !== 'idle') return;
    void connect().catch(() => undefined);
  }, [connect, status, workspaceRoot]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(180, Math.max(48, textarea.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    if (!historyOpen) return;
    requestAnimationFrame(() => historyCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeHistory();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeHistory, historyOpen]);

  const chooseWorkspace = async (): Promise<void> => {
    try {
      const path = await chooseWorkspaceDirectory();
      if (!path) return;
      await setWorkspaceRoot(path);
      await connect();
    } catch (reason) {
      toast.error(reason, '无法设置 DeepSeek 工作区');
    }
  };

  const submit = async (): Promise<void> => {
    const value = input.trim();
    if (!value) return;
    setInput('');
    stickToBottom.current = true;
    try {
      await send(value);
    } catch (reason) {
      setInput(value);
      toast.error(reason, '消息没有发出');
    }
  };

  return (
    <div className="dsh-conversation-layout">
      <DshConversationHistory />
      {historyOpen ? (
        <div className="butler-conversation-mobile-drawer">
          <button type="button" tabIndex={-1} aria-label="关闭任务列表" className="butler-conversation-mobile-backdrop" onClick={closeHistory} />
          <div ref={historyPanelRef} role="dialog" aria-modal="true" aria-label="DeepSeek 会话列表" className="butler-conversation-mobile-panel">
            <button ref={historyCloseRef} type="button" aria-label="关闭任务列表" className="butler-conversation-mobile-close" onClick={closeHistory}>
              <X size={17} aria-hidden="true" />
            </button>
            <div className="h-full" onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest('button')) closeHistory();
            }}>
              <DshConversationHistory onNavigate={closeHistory} />
            </div>
          </div>
        </div>
      ) : null}

      <section className="butler-conversation-pane" aria-label="DeepSeek 任务">
        <header className="butler-conversation-header">
          <div className="min-w-0">
            <span>{workspaceRoot ? workspaceLabel(workspaceRoot) : 'DeepSeek'}</span>
            <h2>{activeSession?.title || 'DeepSeek 会话'}</h2>
            {workspaceRoot ? <p title={workspaceRoot}>{workspaceRoot}</p> : null}
            {workspaceRoot ? <div className="dsh-model-summary">DeepSeek 模型：{modelSummary}</div> : null}
          </div>
          <div className="butler-conversation-header-actions">
            <button
              ref={historyButtonRef}
              type="button"
              aria-label="打开 DeepSeek 会话列表"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(true)}
              className="butler-conversation-mobile-switcher"
            >
              <PanelLeft size={15} aria-hidden="true" />
              会话
            </button>
            {credentialConfigured === true ? (
              <>
                <button
                  type="button"
                  className="codex-native-refresh"
                  aria-pressed={configurationOpen}
                  disabled={status !== 'ready'}
                  onClick={() => setConfigurationOpen((open) => !open)}
                >
                  <SlidersHorizontal size={14} aria-hidden="true" />
                  配置
                </button>
                <button
                  type="button"
                  className="codex-native-refresh"
                  aria-pressed={credentialOpen}
                  disabled={status !== 'ready'}
                  onClick={() => setCredentialOpen((open) => !open)}
                >
                  <KeyRound size={14} aria-hidden="true" />
                  凭据
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="codex-native-refresh"
              disabled={!workspaceRoot || status === 'connecting'}
              onClick={() => void refresh().catch((reason) => toast.error(reason, '无法刷新 DeepSeek'))}
            >
              {status === 'connecting'
                ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <RefreshCw size={14} aria-hidden="true" />}
              刷新
            </button>
          </div>
        </header>

        {configurationOpen ? (
          <Dialog
            title="DeepSeek 运行配置"
            hint="直接读写 DSH 原生配置；AI 托管创建的新会话也使用这些默认值。"
            width={720}
            onClose={() => setConfigurationOpen(false)}
          >
            <div className="px-5 pb-5">
              <DshConfigurationCard />
            </div>
          </Dialog>
        ) : null}

        <main ref={scrollRef} onScroll={onScroll} className="codex-native-transcript">
          {!workspaceRoot ? (
            <div className="codex-native-landing">
              <span><FolderOpen size={24} aria-hidden="true" /></span>
              <h1>先选择 DeepSeek 工作区</h1>
              <p>先选择一个本地项目目录，再启动 DeepSeek 会话。</p>
              <button type="button" onClick={() => void chooseWorkspace()}>
                <FolderOpen size={15} aria-hidden="true" />
                选择文件夹
              </button>
            </div>
          ) : status === 'connecting' ? (
            <div className="codex-native-landing">
              <Loader2 size={24} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <h1>正在连接 DeepSeek</h1>
              <p>正在读取会话、消息和待处理交互。</p>
            </div>
          ) : credentialConfigured === false ? (
            <div className="codex-native-transcript-inner">
              <CredentialCard
                credentialConfigured={false}
                credentialWritable={credentialWritable}
                setDeepSeekApiKey={setDeepSeekApiKey}
                clearDeepSeekApiKey={clearDeepSeekApiKey}
              />
            </div>
          ) : status === 'error' && error && messages.length === 0 ? (
            <div className="codex-native-landing is-error">
              <CircleAlert size={24} aria-hidden="true" />
              <h1>DeepSeek 连接失败</h1>
              <p>{error}</p>
              <div>
                <button type="button" onClick={() => void connect().catch((reason) => toast.error(reason, '无法连接 DeepSeek'))}>重试连接</button>
                <button type="button" onClick={() => void chooseWorkspace()}>更换工作区</button>
              </div>
            </div>
          ) : messages.length === 0 && !activeSessionId && !credentialOpen && !configurationOpen ? (
            <div className="codex-native-landing">
              <span><Check size={24} aria-hidden="true" /></span>
              <h1>开始一个 DeepSeek 会话</h1>
              <p>这里独立展示消息流、审批卡、问题表单和运行活动。</p>
            </div>
          ) : (
            <div className="codex-native-transcript-inner">
              {credentialOpen ? (
                <CredentialCard
                  credentialConfigured
                  credentialWritable={credentialWritable}
                  setDeepSeekApiKey={setDeepSeekApiKey}
                  clearDeepSeekApiKey={clearDeepSeekApiKey}
                />
              ) : null}
              {pendingApproval ? <ApprovalCard approval={pendingApproval} respondApproval={respondApproval} /> : null}
              {pendingQuestion ? <DshQuestionCard key={pendingQuestion.rpcId} question={pendingQuestion} respondQuestion={respondQuestion} /> : null}

              {messages.map((message) => <DshMessageBubble key={message.id} entry={message} />)}

              {queuedMessages.length > 0 ? (
                <section className="dsh-queue" aria-label="DeepSeek 待处理消息">
                  <strong>等待 DeepSeek 处理</strong>
                  {queuedMessages.map((message) => (
                    <div key={message.id}>
                      <small>{message.placement === 'steering' ? '即将补充到当前步骤' : '已排队'}</small>
                      <p>{message.text}</p>
                    </div>
                  ))}
                </section>
              ) : null}

              {activities.length > 0 ? (
                <details className="codex-native-activities" aria-label="DeepSeek 活动">
                  <summary>
                    <span>{isRunning ? '运行中' : '最近活动'}</span>
                    <small className="codex-native-activity-latest">{latestActivity?.title}</small>
                    <small className="codex-native-activity-count">{activities.length} 项活动</small>
                    <RefreshCw size={13} aria-hidden="true" />
                  </summary>
                  <div>
                    {activities.map((activity) => (
                      <div key={activity.id} className="codex-native-activity" data-status={activity.status}>
                        {activity.status === 'failed'
                          ? <CircleAlert size={13} aria-hidden="true" />
                          : activity.status === 'completed'
                            ? <Check size={13} aria-hidden="true" />
                            : <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        <span>
                          <strong>{activity.title}</strong>
                          {activity.summary ? <small>{activity.summary}</small> : null}
                          {activity.detail ? <pre>{activity.detail}</pre> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              {error ? <div className="codex-native-inline-error" role="alert">{error}</div> : null}
            </div>
          )}
        </main>

        <footer className="butler-conversation-footer codex-native-footer">
          <div className="codex-native-composer">
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              aria-label="给 DeepSeek 的消息"
              placeholder={isRunning ? '向当前 DeepSeek 会话补充信息' : '给 DeepSeek 一个任务'}
              disabled={credentialConfigured !== true || !workspaceRoot || status !== 'ready'}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit();
              }}
            />
            <div className="codex-native-composer-bar">
              <div>
                <span className="dsh-composer-hint">
                  {!workspaceRoot
                    ? '先选择 DeepSeek 工作区'
                    : status === 'connecting'
                      ? '正在连接 DeepSeek'
                      : credentialConfigured === true
                        ? '审批与问题会在当前视图处理'
                        : '先配置 DeepSeek API Key'}
                </span>
              </div>
              <div>
                {isRunning ? (
                  <button
                    type="button"
                    aria-label="停止 DeepSeek 会话"
                    className="codex-native-stop"
                    onClick={() => void cancel().catch((reason) => toast.error(reason, '无法停止会话'))}
                  >
                    <Square size={13} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="发送给 DeepSeek"
                  disabled={!input.trim() || credentialConfigured !== true || !workspaceRoot || status !== 'ready'}
                  onClick={() => void submit()}
                >
                  <Send size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}
