import { useEffect, useState } from 'react';
import { Bot, Check, KeyRound, Loader2, Radar, Sparkles, Terminal, Globe, Server } from 'lucide-react';
import { useT, type MessageKey } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import {
  PI_API_PROTOCOL_OPTIONS,
  inferProtocolHintFromInput,
  parseConnectionSnippet,
} from '../lib/piProtocols';
import {
  PI_CONFIGURED_STORAGE_KEY,
  activateAiRuntimeProvider,
  persistAiRuntimeProvider,
} from '../lib/runtimeMode';
import {
  probePiEndpoint,
  scanLocalPiGateways,
  writePiConfig,
  type PiApiProtocol,
  type PiEndpointProbeResult,
  type PiLocalGatewayCandidate,
  type PiProviderPreset,
} from '../platform/desktopCommands';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

interface PresetConfig {
  id: PiProviderPreset;
  titleKey: MessageKey;
  descKey: MessageKey;
  icon: typeof Bot;
  baseUrl: string;
  defaultModel: string;
  keyRequired: boolean;
  placeholderKey?: string;
  placeholderKeyTextKey?: MessageKey;
}

const PRESETS: PresetConfig[] = [
  {
    id: 'deepseek',
    titleKey: 'butler.piOnboarding.preset.deepseekTitle',
    descKey: 'butler.piOnboarding.preset.deepseekDesc',
    icon: Sparkles,
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    keyRequired: true,
    placeholderKey: 'sk-...',
  },
  {
    id: 'anthropic',
    titleKey: 'butler.piOnboarding.preset.anthropicTitle',
    descKey: 'butler.piOnboarding.preset.anthropicDesc',
    icon: Bot,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5.5',
    keyRequired: true,
    placeholderKey: 'sk-ant-...',
  },
  {
    id: 'openai',
    titleKey: 'butler.piOnboarding.preset.openaiTitle',
    descKey: 'butler.piOnboarding.preset.openaiDesc',
    icon: Globe,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    keyRequired: true,
    placeholderKey: 'sk-...',
  },
  {
    id: 'ollama',
    titleKey: 'butler.piOnboarding.preset.ollamaTitle',
    descKey: 'butler.piOnboarding.preset.ollamaDesc',
    icon: Terminal,
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3-coder',
    keyRequired: false,
    placeholderKeyTextKey: 'butler.piOnboarding.preset.ollamaKeyPlaceholder',
  },
  {
    id: 'google',
    titleKey: 'butler.piOnboarding.preset.googleTitle',
    descKey: 'butler.piOnboarding.preset.googleDesc',
    icon: Globe,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-argon',
    keyRequired: true,
    placeholderKey: 'AIzaSy...',
  },
  {
    id: 'custom-openai',
    titleKey: 'butler.piOnboarding.preset.customTitle',
    descKey: 'butler.piOnboarding.preset.customDesc',
    icon: Server,
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'deepseek-v4-flash',
    keyRequired: false,
    placeholderKeyTextKey: 'butler.piOnboarding.preset.customKeyPlaceholder',
  },
  {
    id: 'openrouter',
    titleKey: 'butler.piOnboarding.preset.openrouterTitle',
    descKey: 'butler.piOnboarding.preset.openrouterDesc',
    icon: Globe,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    keyRequired: true,
    placeholderKey: 'sk-or-...',
  },
];

export default function PiQuickOnboardingCard() {
  const t = useT();
  const [selectedPresetId, setSelectedPresetId] = useState<PiProviderPreset>('deepseek');
  const [apiProtocol, setApiProtocol] = useState<PiApiProtocol>('auto');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-v4-flash');
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<PiEndpointProbeResult | null>(null);
  const [localGateways, setLocalGateways] = useState<PiLocalGatewayCandidate[]>([]);

  const currentPreset = PRESETS.find((p) => p.id === selectedPresetId) ?? PRESETS[0];
  const instantHint = inferProtocolHintFromInput(baseUrl, apiKey);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void scanLocalPiGateways()
      .then((found) => {
        if (!cancelled) setLocalGateways(Array.isArray(found) ? found : []);
      })
      .catch(() => {
        // Ignore transient local gateway scan failures.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectPreset = (preset: PresetConfig) => {
    setSelectedPresetId(preset.id);
    setApiProtocol('auto');
    setBaseUrl(preset.baseUrl);
    setModel(preset.defaultModel);
    setProbeResult(null);
    setDiscoveredModels([]);
    if (preset.id === 'custom-openai') {
      setShowAdvanced(true);
    }
  };

  const handleApplyGateway = (gateway: PiLocalGatewayCandidate) => {
    setSelectedPresetId(gateway.id === 'ollama' ? 'ollama' : 'custom-openai');
    setBaseUrl(gateway.baseUrl);
    setApiProtocol(gateway.protocol);
    setDiscoveredModels(gateway.models);
    if (gateway.models.length > 0) {
      setModel(gateway.models[0]);
    }
    setProbeResult(null);
    setShowAdvanced(true);
  };

  const handleProbeEndpoint = async () => {
    if (!isTauriRuntime()) {
      toast.error(t('butler.piOnboarding.desktopOnly'));
      return;
    }
    setProbing(true);
    try {
      const result = await probePiEndpoint({
        baseUrl: baseUrl.trim() || currentPreset.baseUrl,
        apiKey: apiKey.trim() || undefined,
        provider: selectedPresetId,
        apiProtocol,
        preferredModel: model.trim() || undefined,
      });
      setProbeResult(result);
      if (result.normalizedBaseUrl) {
        setBaseUrl(result.normalizedBaseUrl);
      }
      if (result.detectedProtocol) {
        setApiProtocol(result.detectedProtocol);
      }
      if (result.discoveredModels.length > 0) {
        setDiscoveredModels(result.discoveredModels);
        if (result.suggestedModel) {
          setModel(result.suggestedModel);
        } else {
          setModel(result.discoveredModels[0]);
        }
      }
      if (result.ok) {
        toast.success(
          t('butler.piOnboarding.probeSuccess', { protocol: result.detectedProtocol }),
        );
      } else {
        toast.error(result.summary || t('butler.piOnboarding.probeFailed'));
      }
    } catch (err) {
      toast.error(err, t('butler.piOnboarding.probeFailed'));
    } finally {
      setProbing(false);
    }
  };

  const handleActivate = async () => {
    if (!isTauriRuntime()) {
      toast.error(t('butler.piOnboarding.desktopOnly'));
      return;
    }
    const trimmedKey = apiKey.trim();
    if (currentPreset.keyRequired && !trimmedKey) {
      toast.error(t('butler.piOnboarding.enterApiKey'));
      return;
    }

    setSaving(true);
    try {
      const fallbackExtras = selectedPresetId === 'deepseek'
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
                  : ['claude-sonnet-5.5', 'gpt-6.1-sol', 'deepseek-r1'];
      const chosenModel = model.trim() || currentPreset.defaultModel;
      const mergedExtras = discoveredModels.length > 0
        ? discoveredModels.filter((m) => m !== chosenModel).slice(0, 12)
        : fallbackExtras;

      await writePiConfig({
        provider: selectedPresetId,
        apiProtocol,
        baseUrl: baseUrl.trim(),
        ...(trimmedKey ? { apiKey: trimmedKey } : { apiKey: '' }),
        defaultModel: chosenModel,
        extraModels: mergedExtras,
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

      toast.success(t('butler.piOnboarding.readyToast'));
    } catch (err) {
      toast.error(err, t('butler.piOnboarding.enableFailed'));
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
          <h2 className="text-base font-semibold text-ink">{t('butler.piOnboarding.heading')}</h2>
          <p className="text-xs text-ink-3">
            {t('butler.piOnboarding.subtitle')}
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {localGateways.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-primary/25 bg-primary-light/40 px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-ink">
              <Radar size={13} className="text-primary" />
              {t('butler.piOnboarding.localDetected')}
            </span>
            {localGateways.map((gw) => (
              <button
                key={gw.id}
                type="button"
                onClick={() => handleApplyGateway(gw)}
                className="rounded-full border border-primary/30 bg-surface px-2.5 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/10"
              >
                {gw.label} ({gw.protocol})
              </button>
            ))}
          </div>
        ) : null}

        {/* Preset Selector */}
        <div>
          <label className="mb-2 block text-xs font-medium text-ink-2">{t('butler.piOnboarding.selectProvider')}</label>
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
                  <span className="text-xs font-semibold">{t(preset.titleKey)}</span>
                  <span className="text-xs text-ink-3 leading-snug line-clamp-2">{t(preset.descKey)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* API Key Input */}
        <div>
          <div className="flex items-center justify-between">
            <label className="mb-1.5 block text-xs font-medium text-ink-2">
              API Key {currentPreset.keyRequired ? <span className="text-danger">*</span> : <span className="text-ink-4">{t('butler.piOnboarding.optional')}</span>}
            </label>
            {selectedPresetId === 'deepseek' ? (
              <a
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                {t('butler.piOnboarding.getKey')} <Globe size={11} />
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
              onChange={(e) => {
                const snippet = parseConnectionSnippet(e.target.value);
                if (snippet) {
                  setSelectedPresetId('custom-openai');
                  setBaseUrl(snippet.baseUrl);
                  setApiKey(snippet.apiKey);
                  if (snippet.model) setModel(snippet.model);
                  setShowAdvanced(true);
                  return;
                }
                setApiKey(e.target.value);
              }}
              placeholder={currentPreset.placeholderKeyTextKey ? t(currentPreset.placeholderKeyTextKey) : currentPreset.placeholderKey}
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
            {showAdvanced ? t('butler.piOnboarding.hideAdvanced') : t('butler.piOnboarding.showAdvanced')}
          </button>

          {showAdvanced ? (
            <div className="mt-3 space-y-3 rounded-xl border border-line bg-fill-1/50 p-3">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-ink-2">API Base URL</label>
                  {instantHint.protocol !== 'auto' && apiProtocol === 'auto' ? (
                    <span className="text-xs text-primary">
                      {t('butler.piOnboarding.instantProtocolHint', { protocol: instantHint.protocol })}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => {
                      const snippet = parseConnectionSnippet(e.target.value);
                      if (snippet) {
                        setSelectedPresetId('custom-openai');
                        setBaseUrl(snippet.baseUrl);
                        setApiKey(snippet.apiKey);
                        if (snippet.model) setModel(snippet.model);
                        return;
                      }
                      setBaseUrl(e.target.value);
                    }}
                    placeholder="https://..."
                    className="h-8 flex-1 rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    disabled={probing}
                    onClick={() => void handleProbeEndpoint()}
                    className="h-8 shrink-0 rounded-xl border border-line bg-surface-3 px-2.5 text-xs font-medium text-ink transition hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {probing
                      ? t('butler.piOnboarding.probingEndpoint')
                      : t('butler.piOnboarding.probeEndpoint')}
                  </button>
                </div>
                {probeResult ? (
                  <p className="mt-1.5 text-xs text-ink-3">
                    {probeResult.summary} ({probeResult.latencyMs}ms)
                  </p>
                ) : null}
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-2">
                  {t('butler.piOnboarding.protocolLabel')}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PI_API_PROTOCOL_OPTIONS.filter((opt) => opt.primary || opt.id === apiProtocol).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setApiProtocol(opt.id)}
                      className={`rounded-lg border px-2 py-1 text-xs font-medium transition ${
                        apiProtocol === opt.id
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-line bg-surface-3 text-ink-2 hover:text-ink'
                      }`}
                    >
                      {opt.shortLabel}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-ink-2">{t('butler.piOnboarding.modelName')}</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                {discoveredModels.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {discoveredModels.slice(0, 6).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModel(m)}
                        className={`rounded-full border px-2 py-0.5 font-mono text-xs transition ${
                          model === m
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-line bg-surface-3 text-ink-2 hover:text-ink'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : null}
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
                {t('butler.piOnboarding.initializing')}
              </>
            ) : (
              <>
                <Sparkles size={15} />
                {t('butler.piOnboarding.activateButton')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
