import { useState } from 'react';
import { Bot, Check, KeyRound, Loader2, Sparkles, Terminal, Globe, Server } from 'lucide-react';
import { isTauriRuntime } from '../lib/client';
import {
  PI_CONFIGURED_STORAGE_KEY,
  activateAiRuntimeProvider,
  persistAiRuntimeProvider,
} from '../lib/runtimeMode';
import {
  writePiConfig,
  type PiProviderPreset,
} from '../platform/desktopCommands';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

interface PresetConfig {
  id: PiProviderPreset;
  title: string;
  desc: string;
  icon: typeof Bot;
  baseUrl: string;
  defaultModel: string;
  keyRequired: boolean;
  placeholderKey: string;
}

const PRESETS: PresetConfig[] = [
  {
    id: 'deepseek',
    title: 'DeepSeek 官方',
    desc: '最新 V4 Flash / Pro 与 R1 推理',
    icon: Sparkles,
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    keyRequired: true,
    placeholderKey: 'sk-...',
  },
  {
    id: 'anthropic',
    title: 'Claude 官方',
    desc: 'Claude 5.5 / 3.7 混合深度推理',
    icon: Bot,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5.5',
    keyRequired: true,
    placeholderKey: 'sk-ant-...',
  },
  {
    id: 'openai',
    title: 'OpenAI 官方',
    desc: 'GPT-6.1 Sol / o3-mini 高速推理',
    icon: Globe,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    keyRequired: true,
    placeholderKey: 'sk-...',
  },
  {
    id: 'ollama',
    title: 'Ollama 本地',
    desc: 'Qwen 3 Coder / DeepSeek R1 离线免密',
    icon: Terminal,
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3-coder',
    keyRequired: false,
    placeholderKey: '免密，留空即可',
  },
  {
    id: 'google',
    title: 'Google 官方',
    desc: 'Gemini 4 Argon / 3.8 Flash 超大上下文',
    icon: Globe,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-argon',
    keyRequired: true,
    placeholderKey: 'AIzaSy...',
  },
  {
    id: 'custom-openai',
    title: '企业 / 兼容网关',
    desc: '自建 vLLM / OneAPI / LiteLLM',
    icon: Server,
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'deepseek-v4-flash',
    keyRequired: false,
    placeholderKey: '如网关免密可留空',
  },
  {
    id: 'openrouter',
    title: 'OpenRouter',
    desc: '聚合全球主流旗舰大模型',
    icon: Globe,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    keyRequired: true,
    placeholderKey: 'sk-or-...',
  },
];

export default function PiQuickOnboardingCard() {
  const [selectedPresetId, setSelectedPresetId] = useState<PiProviderPreset>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-v4-flash');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentPreset = PRESETS.find((p) => p.id === selectedPresetId) ?? PRESETS[0];

  const handleSelectPreset = (preset: PresetConfig) => {
    setSelectedPresetId(preset.id);
    setBaseUrl(preset.baseUrl);
    setModel(preset.defaultModel);
  };

  const handleActivate = async () => {
    if (!isTauriRuntime()) {
      toast.error('网页版不支持本地 Pi 进程，请使用 RocketX 桌面端');
      return;
    }
    const trimmedKey = apiKey.trim();
    if (currentPreset.keyRequired && !trimmedKey) {
      toast.error('请输入 API Key');
      return;
    }

    setSaving(true);
    try {
      await writePiConfig({
        provider: selectedPresetId,
        baseUrl: baseUrl.trim(),
        ...(trimmedKey ? { apiKey: trimmedKey } : { apiKey: '' }),
        defaultModel: model.trim() || currentPreset.defaultModel,
        extraModels: selectedPresetId === 'deepseek'
          ? ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']
          : selectedPresetId === 'anthropic'
            ? ['claude-opus-5.5', 'claude-haiku-5.5', 'claude-3-7-sonnet-20250219']
            : selectedPresetId === 'openai'
              ? ['gpt-6-astra', 'gpt-6-luna', 'o3-mini', 'gpt-4.5-preview']
              : selectedPresetId === 'google'
                ? ['gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']
                : selectedPresetId === 'openrouter'
                  ? ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-4-argon']
                  : selectedPresetId === 'ollama'
                    ? ['qwen3:8b', 'qwen3.8-27b', 'deepseek-r1:8b']
                    : ['claude-sonnet-5.5', 'gpt-6.1-sol', 'deepseek-r1'],
      });

      try {
        localStorage.setItem(PI_CONFIGURED_STORAGE_KEY, '1');
      } catch {
        // 忽略受限
      }

      persistAiRuntimeProvider('pi');
      activateAiRuntimeProvider('pi');
      useUI.setState({ aiRuntimeProvider: 'pi' });

      await useCodexWorkspace.getState().reconnectRuntime();

      toast.success('AI 引擎就绪，开始对话吧！');
    } catch (err) {
      toast.error(err, '启用失败，请检查配置');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl rounded-2xl border border-line bg-surface-4 p-6 shadow-card transition-all">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Bot size={24} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-ink">快速启用 AI 管家</h2>
          <p className="text-xs text-ink-3">
            RocketX 已内置本地 Pi 运行时与动态工具桥，配置好模型即可开启离线/私有任务。
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {/* Preset Selector */}
        <div>
          <label className="mb-2 block text-xs font-medium text-ink-2">选择模型来源</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PRESETS.map((preset) => {
              const active = preset.id === selectedPresetId;
              const Icon = preset.icon;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleSelectPreset(preset)}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all ${
                    active
                      ? 'border-primary bg-primary-light/70 text-primary shadow-raise'
                      : 'border-line bg-surface-2/80 text-ink hover:border-line-hover hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex w-full items-center justify-between">
                    <Icon size={16} />
                    {active ? <Check size={14} className="text-primary" /> : null}
                  </div>
                  <span className="text-xs font-semibold">{preset.title}</span>
                  <span className="text-xs text-ink-3 leading-snug line-clamp-2">{preset.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* API Key Input */}
        <div>
          <div className="flex items-center justify-between">
            <label className="mb-1.5 block text-xs font-medium text-ink-2">
              API Key {currentPreset.keyRequired ? <span className="text-danger">*</span> : <span className="text-ink-4">（选填）</span>}
            </label>
            {selectedPresetId === 'deepseek' ? (
              <a
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                获取 Key <Globe size={11} />
              </a>
            ) : null}
          </div>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-ink-3">
              <KeyRound size={14} />
            </div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={currentPreset.placeholderKey}
              className="h-9 w-full rounded-xl border border-line bg-surface-3 pl-9 pr-3 text-xs text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </div>
        </div>

        {/* Advanced Options Accordion */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="text-xs text-ink-3 hover:text-ink font-medium"
          >
            {showAdvanced ? '收起自定义端点与模型' : '展开自定义端点与模型 (Base URL / Model)'}
          </button>

          {showAdvanced ? (
            <div className="mt-3 space-y-3 rounded-xl border border-line bg-fill-1/50 p-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-2">API Base URL</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://..."
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-2">模型名称</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* Submit Button */}
        <div className="pt-2">
          <button
            type="button"
            disabled={saving || (currentPreset.keyRequired && !apiKey.trim())}
            onClick={() => void handleActivate()}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary text-xs font-semibold text-white shadow-raise transition hover:bg-primary-hover active:scale-[0.99] disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
                正在初始化引擎…
              </>
            ) : (
              <>
                <Sparkles size={15} />
                立即启用并开始对话
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
