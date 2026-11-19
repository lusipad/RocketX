import { useEffect, useState } from 'react';
import { isTauri } from '../lib/http';
import { getAiRuntimeStartupResolution } from '../lib/aiRuntimeBootstrap';
import {
  PI_CONFIGURED_STORAGE_KEY,
  activateAiRuntimeProvider,
  getAiRuntimeProvider,
  persistAiRuntimeProvider,
  readConfiguredAiRuntimeProvider,
  runtimeFeatures,
  type AiRuntimeProvider,
} from '../lib/runtimeMode';
import {
  ocrBackendLabel,
  probeImageOcrRuntime,
  type ImageOcrRuntimeProbe,
} from '../lib/imageOcr';
import {
  probePiRuntime,
  readPiConfig,
  writePiConfig,
  type AcpAgentPreset,
  type AcpAgentProfile,
  type AcpDiscoveredCandidate,
  type PiConfigView,
  type PiProviderPreset,
  type PiRuntimeProbe,
} from '../platform/desktopCommands';
import { ACP_PRESET_TEMPLATES, useAcpAgents } from '../stores/acpAgents';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ReverseMcpSettings from './ReverseMcpSettings';
import AgentBotSettings from './AgentBotSettings';
import { RadioGroup, Row } from './SettingControls';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';
const secondaryButtonCls =
  'h-8 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50';
const primaryButtonCls =
  'h-8 rounded-md bg-primary px-3 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-50';

interface PiPresetMeta {
  id: PiProviderPreset;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultExtraModels: string;
  keyOptional?: boolean;
  hint: string;
}

const PI_PRESETS: readonly PiPresetMeta[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    defaultExtraModels: 'deepseek-v4-pro,deepseek-chat,deepseek-reasoner',
    hint: '直连 DeepSeek 官方 API，支持 V4 Flash/Pro 与 R1/V3 兼容推理',
  },
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5.5',
    defaultExtraModels: 'claude-opus-5.5,claude-haiku-5.5,claude-3-7-sonnet-20250219',
    hint: '使用 Anthropic Messages API，支持 Claude 5.5 全系与 3.7 Sonnet 混合推理',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    defaultExtraModels: 'gpt-6-astra,gpt-6-luna,o3-mini,gpt-4.5-preview,gpt-4o',
    hint: '使用 OpenAI API Key，支持 GPT-6 系列并行智能体与 o3-mini 高速推理',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-argon',
    defaultExtraModels: 'gemini-3.8-flash,gemini-2.5-pro,gemini-2.0-flash',
    hint: '使用 Google AI Studio Key，支持 Gemini 4 Argon 与 2M+ 超大上下文',
  },
  {
    id: 'custom-openai',
    label: '企业 / 兼容网关',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'deepseek-v4-flash',
    defaultExtraModels: 'claude-sonnet-5.5,gpt-6.1-sol,deepseek-r1',
    keyOptional: true,
    hint: '对接企业内网 vLLM / OneAPI / LiteLLM 等兼容网关（免密网关可留空 Key）',
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3-coder',
    defaultExtraModels: 'qwen3:8b,qwen3.8-27b,deepseek-r1:8b,qwen2.5-coder:7b',
    keyOptional: true,
    hint: '本地离线免密运行，自动探测本机拉取的 Qwen 3 Coder / DeepSeek R1',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    defaultExtraModels: 'anthropic/claude-sonnet-5.5,openai/gpt-6.1-sol,google/gemini-4-argon',
    hint: '通过单一 API Key 聚合切换全球各大主流旗舰大模型',
  },
];

function aiRuntimeLabel(provider: AiRuntimeProvider): string {
  return provider === 'pi' ? 'Pi' : '无 AI';
}

export default function AiSettings() {
  const [activeAiRuntime, setActiveAiRuntime] = useState<AiRuntimeProvider>(getAiRuntimeProvider);
  const startupResolution = getAiRuntimeStartupResolution();
  const [selectedAiRuntime, setSelectedAiRuntime] = useState<AiRuntimeProvider>(
    () => readConfiguredAiRuntimeProvider() ?? getAiRuntimeProvider(),
  );
  const [ocrRuntime, setOcrRuntime] = useState<ImageOcrRuntimeProbe>();
  const [piProbe, setPiProbe] = useState<PiRuntimeProbe | null>(null);
  const [piConfig, setPiConfig] = useState<PiConfigView | null>(null);
  const [piProvider, setPiProvider] = useState<PiProviderPreset>('deepseek');
  const [piBaseUrl, setPiBaseUrl] = useState('https://api.deepseek.com/v1');
  const [piApiKeyInput, setPiApiKeyInput] = useState('');
  const [piDefaultModel, setPiDefaultModel] = useState('deepseek-chat');
  const [piExtraModels, setPiExtraModels] = useState('deepseek-reasoner');
  const [piSaving, setPiSaving] = useState(false);
  const [piProbing, setPiProbing] = useState(false);

  const openButlerConversation = useUI((state) => state.openButlerConversation);

  useEffect(() => {
    if (!isTauri || !runtimeFeatures().ocr) return;
    void probeImageOcrRuntime().then(setOcrRuntime, (error) => {
      setOcrRuntime({ reason: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const refreshPiStatus = async () => {
    if (!isTauri) return;
    setPiProbing(true);
    try {
      const [cfg, probe] = await Promise.all([readPiConfig(), probePiRuntime()]);
      setPiConfig(cfg);
      setPiProvider(cfg.provider);
      setPiBaseUrl(cfg.baseUrl);
      setPiDefaultModel(cfg.defaultModel);
      setPiExtraModels(cfg.extraModels.join(', '));
      setPiProbe(probe);
    } catch (error) {
      setPiProbe({
        ready: false,
        configuredProvider: 'deepseek',
        defaultModel: 'deepseek-chat',
        hasCredentials: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPiProbing(false);
    }
  };

  useEffect(() => {
    if (!isTauri) return;
    void refreshPiStatus();
  }, []);

  const applyPiPreset = (presetId: PiProviderPreset) => {
    const meta = PI_PRESETS.find((item) => item.id === presetId);
    setPiProvider(presetId);
    if (!meta) return;
    setPiBaseUrl(meta.defaultBaseUrl);
    setPiDefaultModel(meta.defaultModel);
    setPiExtraModels(meta.defaultExtraModels);
  };

  const savePiConfiguration = async (activateNow: boolean) => {
    if (!isTauri) {
      toast.error('网页版不支持本地 Pi 进程，请使用 RocketX 桌面端');
      return;
    }
    setPiSaving(true);
    try {
      const trimmedKey = piApiKeyInput.trim();
      const extraModels = piExtraModels
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      const saved = await writePiConfig({
        provider: piProvider,
        baseUrl: piBaseUrl.trim(),
        ...(trimmedKey === '-'
          ? { apiKey: '' }
          : trimmedKey
            ? { apiKey: trimmedKey }
            : {}),
        defaultModel: piDefaultModel.trim(),
        extraModels,
      });
      setPiConfig(saved);
      setPiApiKeyInput('');
      try {
        localStorage.setItem(PI_CONFIGURED_STORAGE_KEY, '1');
      } catch {
        // 忽略存储限制
      }
      const probe = await probePiRuntime();
      setPiProbe(probe);

      if (activateNow) {
        persistAiRuntimeProvider('pi');
        activateAiRuntimeProvider('pi');
        setSelectedAiRuntime('pi');
        setActiveAiRuntime('pi');
        useUI.setState({ aiRuntimeProvider: 'pi' });
        await useCodexWorkspace.getState().reconnectRuntime();
        toast.success('Pi 配置已保存并立即启用');
      } else {
        toast.success('Pi 模型与凭据配置已保存');
      }
    } catch (error) {
      toast.error(error, '保存 Pi 配置失败');
    } finally {
      setPiSaving(false);
    }
  };

  const selectAiRuntime = (provider: AiRuntimeProvider): void => {
    setSelectedAiRuntime(persistAiRuntimeProvider(provider));
  };
  const activeAiRuntimeLabel = aiRuntimeLabel(activeAiRuntime);
  const startupModeHint = startupResolution.source === 'automatic'
    ? '（按本机可用性自动判断）'
    : startupResolution.source === 'full-default'
      ? '（默认）'
      : '';
  const explicitRuntimeUnavailable = startupResolution.source === 'explicit-unavailable'
    && selectedAiRuntime === startupResolution.configured;
  const activePiPresetMeta = PI_PRESETS.find((item) => item.id === piProvider) ?? PI_PRESETS[0];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">AI 运行时</h2>
        <div className="rounded-lg bg-surface px-4 shadow-raise">
          <Row label="执行后端" hint="全局仅内建 Pi 通用引擎，主管家、房间侧栏和 AI 托管共用该选择；本地第三方客户端统一通过 ACP 管理。">
            <div className="space-y-2">
              <RadioGroup
                value={selectedAiRuntime}
                options={[
                  {
                    key: 'pi',
                    label: 'Pi（内建通用引擎）',
                    hint: '原生三栏工作台与统一托管引擎，支持 DeepSeek / 内网网关 / Ollama / OpenAI / Claude',
                  },
                  { key: 'none', label: '无 AI', hint: '不启动本地 AI；仍可查看已有托管记录' },
                ]}
                onChange={selectAiRuntime}
              />
              <p className="text-xs leading-5 text-ink-3">
                当前运行：{activeAiRuntimeLabel}{startupModeHint}。修改后重启 RocketX 生效（下方 Pi 配置支持保存后立即启用）。
              </p>
              {explicitRuntimeUnavailable ? (
                <p className="text-xs font-medium leading-5 text-warning" role="status">
                  {aiRuntimeLabel(selectedAiRuntime)} 选择已保留，但当前运行时不可用，本次未启用 AI。
                  {startupResolution.reason ? ` ${startupResolution.reason}` : ''}
                  {' '}修复后重启 RocketX 即可继续使用。
                </p>
              ) : selectedAiRuntime !== activeAiRuntime ? (
                <p className="text-xs font-medium text-warning" role="status">
                  已保存，重启后切换为 {aiRuntimeLabel(selectedAiRuntime)}。
                </p>
              ) : null}
            </div>
          </Row>
        </div>
      </section>

      {selectedAiRuntime === 'pi' || activeAiRuntime === 'pi' ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink">Pi 内建通用引擎</h2>
          <div className="rounded-lg bg-surface px-4 shadow-raise">
            <Row label="运行状态" hint="Pi 复用 RocketX 原生三栏工作台、统一看板、受控审批与动态工具桥。">
              <div className="space-y-2 text-sm text-ink-2">
                <p>
                  {piProbe?.ready
                    ? `已就绪 · Pi v${piProbe.version ?? '1.5.0'}${piProbe.nodeVersion ? ` · Node ${piProbe.nodeVersion}` : ''}`
                    : piProbe?.reason || '正在检测本地 Pi 运行时…'}
                </p>
                {piProbe?.packagePath ? (
                  <p className="break-all font-mono text-xs leading-5 text-ink-3">{piProbe.packagePath}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshPiStatus()}
                    disabled={piProbing}
                    className={secondaryButtonCls}
                  >
                    {piProbing ? '检测中…' : '重新检测'}
                  </button>
                  {activeAiRuntime === 'pi' ? (
                    <button
                      type="button"
                      onClick={() => openButlerConversation()}
                      className={secondaryButtonCls}
                    >
                      打开 AI 管家开始对话
                    </button>
                  ) : null}
                </div>
              </div>
            </Row>

            <Row label="服务商预设" hint={activePiPresetMeta.hint}>
              <div className="flex flex-wrap gap-1.5">
                {PI_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPiPreset(preset.id)}
                    className={`h-8 rounded-md border px-2.5 text-xs font-medium transition ${
                      piProvider === preset.id
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-line bg-surface text-ink-2 hover:bg-fill-hover hover:text-ink'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="接口地址" hint="OpenAI 兼容网关通常以 /v1 结尾；Anthropic 填 https://api.anthropic.com。">
              <div className="max-w-2xl">
                <input
                  aria-label="Pi Base URL"
                  value={piBaseUrl}
                  onChange={(event) => setPiBaseUrl(event.target.value)}
                  placeholder={activePiPresetMeta.defaultBaseUrl}
                  className={inputCls}
                />
              </div>
            </Row>

            <Row
              label="API Key"
              hint={
                activePiPresetMeta.keyOptional
                  ? '本地 Ollama 或免密内网网关可留空；如需鉴权请填写密钥。'
                  : '密钥仅保存在本机应用数据目录，不会上传到聊天服务器。'
              }
            >
              <div className="max-w-2xl space-y-1.5">
                <input
                  type="password"
                  aria-label="Pi API Key"
                  value={piApiKeyInput}
                  onChange={(event) => setPiApiKeyInput(event.target.value)}
                  placeholder={
                    piConfig?.hasApiKey
                      ? `已保存密钥（${piConfig.apiKeyHint ?? '••••'}），留空保持不变，输入 - 清空`
                      : activePiPresetMeta.keyOptional
                        ? '免密可留空'
                        : 'sk-...'
                  }
                  className={inputCls}
                />
                {piConfig?.hasApiKey ? (
                  <p className="text-xs text-ink-3">
                    当前已保存本机凭据：{piConfig.apiKeyHint ?? '已配置'}
                  </p>
                ) : null}
              </div>
            </Row>

            <Row label="模型列表" hint="默认模型用于新对话；备选模型可在对话底部模型菜单中随时切换。">
              <div className="max-w-2xl space-y-2">
                <input
                  aria-label="Pi 默认模型"
                  value={piDefaultModel}
                  onChange={(event) => setPiDefaultModel(event.target.value)}
                  placeholder="默认模型 ID，例如 deepseek-chat"
                  className={inputCls}
                />
                <input
                  aria-label="Pi 备选模型"
                  value={piExtraModels}
                  onChange={(event) => setPiExtraModels(event.target.value)}
                  placeholder="备选模型 ID（逗号分隔，例如 deepseek-reasoner, qwen-max）"
                  className={inputCls}
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={piSaving || !piDefaultModel.trim()}
                    onClick={() => void savePiConfiguration(true)}
                    className={primaryButtonCls}
                  >
                    {piSaving ? '保存中…' : '保存配置并立即启用 Pi'}
                  </button>
                  <button
                    type="button"
                    disabled={piSaving || !piDefaultModel.trim()}
                    onClick={() => void savePiConfiguration(false)}
                    className={secondaryButtonCls}
                  >
                    仅保存配置
                  </button>
                </div>
              </div>
            </Row>
            <Row label="图片文字识别" hint="增强资源存在时使用 PP-OCRv5，否则使用系统识别。">
              <div className="space-y-2 text-sm text-ink-2">
                <p>
                  {ocrRuntime?.backend ? ocrBackendLabel(ocrRuntime.backend) : '正在检测识别引擎…'}
                  {ocrRuntime?.resourceRoot ? ` · ${ocrRuntime.resourceRoot}` : ''}
                </p>
                {ocrRuntime?.reason ? <p className="text-xs leading-5 text-ink-3">{ocrRuntime.reason}</p> : null}
              </div>
            </Row>
          </div>
        </section>
      ) : null}

      {activeAiRuntime === 'none' ? (
        <section className="rounded-lg bg-surface px-4 py-3 text-sm leading-6 text-ink-2 shadow-raise">
          当前启动未启用 AI。聊天、工作台和普通协作能力保持可用。
        </section>
      ) : null}

      <AcpClientsSettingsSection />

      {activeAiRuntime !== 'none' ? <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">外部集成</h2>
        <div className="space-y-6 rounded-lg bg-surface p-4 shadow-raise">
          <ReverseMcpSettings />
          <AgentBotSettings />
        </div>
      </section> : null}
    </div>
  );
}

function AcpClientsSettingsSection() {
  const agents = useAcpAgents((s) => s.agents);
  const discovered = useAcpAgents((s) => s.discovered);
  const probes = useAcpAgents((s) => s.probes);
  const discovering = useAcpAgents((s) => s.discovering);
  const hydrate = useAcpAgents((s) => s.hydrate);
  const discoverLocalAgents = useAcpAgents((s) => s.discoverLocalAgents);
  const adoptAllDiscoveredAgents = useAcpAgents((s) => s.adoptAllDiscoveredAgents);
  const upsertAgent = useAcpAgents((s) => s.upsertAgent);
  const removeAgent = useAcpAgents((s) => s.removeAgent);
  const probeAgent = useAcpAgents((s) => s.probeAgent);
  const openAcpHub = useUI((s) => s.openAcpHub);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preset, setPreset] = useState<AcpAgentPreset>('codex-acp');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [cwd, setCwd] = useState('');
  const [description, setDescription] = useState('');
  const [autoApproveSafeReads, setAutoApproveSafeReads] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adoptingAll, setAdoptingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const unadoptedCount = discovered.filter((c) => !c.alreadyRegistered).length;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const startPresetAdd = (targetPreset: AcpAgentPreset) => {
    const tpl = ACP_PRESET_TEMPLATES.find((t) => t.preset === targetPreset);
    setEditingId(null);
    setPreset(targetPreset);
    setName(tpl?.name || '自定义 ACP 客户端');
    setCommand(tpl?.command || '');
    setArgsText((tpl?.args || []).join(' '));
    setCwd('');
    setDescription(tpl?.description || '');
    setAutoApproveSafeReads(tpl?.defaultAutoApproveSafeReads ?? true);
    setEditorOpen(true);
    setNotice(null);
  };

  const startEdit = (agent: AcpAgentProfile) => {
    setEditingId(agent.id);
    setPreset((agent.preset as AcpAgentPreset) || 'custom');
    setName(agent.name);
    setCommand(agent.command);
    setArgsText(agent.args.join(' '));
    setCwd(agent.cwd || '');
    setDescription(agent.description || '');
    setAutoApproveSafeReads(agent.autoApproveSafeReads);
    setEditorOpen(true);
    setNotice(null);
  };

  const handleSave = async () => {
    if (!name.trim() || !command.trim()) {
      setNotice('请填写客户端名称与启动命令。');
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await upsertAgent({
        id: editingId,
        name: name.trim(),
        preset,
        command: command.trim(),
        args: argsText
          .trim()
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        cwd: cwd.trim() || null,
        description: description.trim() || null,
        enabled: true,
        autoApproveSafeReads,
      });
      setEditorOpen(false);
      setEditingId(null);
      setNotice(`已保存 ACP 客户端：${saved.name}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAdopt = async (cand: AcpDiscoveredCandidate) => {
    setNotice(null);
    try {
      const saved = await upsertAgent({
        name: cand.name,
        preset: cand.preset,
        command: cand.resolvedPath || cand.command,
        args: cand.args,
        enabled: true,
        autoApproveSafeReads: true,
        description: cand.version
          ? `自动探测发现 (${cand.version})`
          : '自动探测发现的本地 ACP 客户端',
      });
      setNotice(`已接入本地 ACP 客户端：${saved.name}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAdoptAll = async () => {
    setAdoptingAll(true);
    setNotice(null);
    try {
      const added = await adoptAllDiscoveredAgents();
      setNotice(
        added.length > 0
          ? `已一键接入 ${added.length} 个本地 ACP 客户端。`
          : '所有探测到的本地客户端均已注册。',
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setAdoptingAll(false);
    }
  };

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">ACP 本地 Agent 客户端管理</h2>
          <p className="text-xs text-ink-3">
            自动识别或接入本地 Codex、Antigravity、Claude Code、Kimi Code、Copilot、Gemini CLI 与 DSH，并在 ACP 工作台协同执行
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={discovering}
            onClick={() => void discoverLocalAgents()}
            className="rounded-lg border border-line bg-surface-4 px-2.5 py-1 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
          >
            {discovering ? '扫描中...' : '重新扫描本机'}
          </button>
          {unadoptedCount > 0 ? (
            <button
              type="button"
              disabled={adoptingAll}
              onClick={() => void handleAdoptAll()}
              className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
            >
              {adoptingAll ? '接入中...' : `全部接入 (${unadoptedCount})`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => startPresetAdd('codex-acp')}
            className="rounded-lg border border-line bg-surface-4 px-2.5 py-1 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover"
          >
            新增客户端
          </button>
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-line bg-surface-4 p-4 shadow-raise">
        {notice ? (
          <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
            {notice}
          </div>
        ) : null}

        {discovered.length > 0 ? (
          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-ink">
              <span>探测到的本地 ACP 客户端 ({discovered.length})</span>
              {unadoptedCount > 0 ? (
                <button
                  type="button"
                  disabled={adoptingAll}
                  onClick={() => void handleAdoptAll()}
                  className="text-primary hover:underline disabled:opacity-50"
                >
                  全部接入 ({unadoptedCount})
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {discovered.map((cand) => (
                <div
                  key={`${cand.preset}-${cand.command}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-4 px-3 py-2 text-xs shadow-raise"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{cand.name}</div>
                    <div className="truncate text-ink-3">
                      {cand.version || cand.resolvedPath || cand.command}
                    </div>
                  </div>
                  {cand.alreadyRegistered ? (
                    <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                      已注册
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleAdopt(cand)}
                      className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-hover"
                    >
                      接入
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {editorOpen ? (
          <div className="space-y-2.5 rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-ink">
                {editingId ? '编辑 ACP 客户端' : '添加 ACP 客户端'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setEditorOpen(false);
                  setEditingId(null);
                }}
                className="text-xs text-ink-3 hover:text-ink"
              >
                取消
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ACP_PRESET_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.preset}
                  type="button"
                  onClick={() => {
                    setPreset(tpl.preset);
                    if (!editingId) {
                      setName(tpl.name);
                      setCommand(tpl.command);
                      setArgsText(tpl.args.join(' '));
                      setDescription(tpl.description);
                      setAutoApproveSafeReads(tpl.defaultAutoApproveSafeReads);
                    }
                  }}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    preset === tpl.preset
                      ? 'border-primary/40 bg-primary/10 font-medium text-primary'
                      : 'border-line bg-surface text-ink-3'
                  }`}
                >
                  {tpl.preset}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="显示名称"
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
              />
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="可执行命令或路径"
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-primary"
              />
              <input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="启动参数（空格分隔）"
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-primary"
              />
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="默认工作目录（可选）"
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
              />
            </div>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="客户端描述（可选）"
              className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={autoApproveSafeReads}
                  onChange={(e) => setAutoApproveSafeReads(e.target.checked)}
                />
                自主模式下自动放行安全只读操作
              </label>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>
        ) : null}

        {agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-ink-3">
            尚未注册本地 ACP 客户端。可点击上方「自动探测本地客户端」或选择预设模板添加。
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => {
              const probe = probes[agent.id];
              return (
                <div
                  key={agent.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{agent.name}</span>
                      <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-ink-3">
                        {agent.preset}
                      </span>
                      {probe ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            probe.ready
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                              : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                          }`}
                        >
                          {probe.ready
                            ? `可用 ${probe.version ? `(${probe.version})` : ''}`
                            : probe.reason || '不可用'}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-ink-3">
                      {agent.command} {agent.args.join(' ')}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void probeAgent(agent.id)}
                      className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                    >
                      探测
                    </button>
                    <button
                      type="button"
                      onClick={() => openAcpHub(agent.id)}
                      className="rounded bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25"
                    >
                      在工作台打开
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(agent)}
                      className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeAgent(agent.id)}
                      className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                    >
                      移除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
