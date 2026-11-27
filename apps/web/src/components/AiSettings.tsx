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
  probePiEndpoint,
  probePiRuntime,
  readPiConfig,
  scanLocalPiGateways,
  writePiConfig,
  type AcpAgentPreset,
  type AcpAgentProfile,
  type AcpDiscoveredCandidate,
  type PiApiProtocol,
  type PiConfigView,
  type PiEndpointProbeResult,
  type PiLocalGatewayCandidate,
  type PiProviderPreset,
  type PiRuntimeProbe,
} from '../platform/desktopCommands';
import {
  PI_API_PROTOCOL_OPTIONS,
  inferProtocolHintFromInput,
  mergeDiscoveredModels,
  parseConnectionSnippet,
} from '../lib/piProtocols';
import { ACP_PRESET_TEMPLATES, useAcpAgents } from '../stores/acpAgents';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ReverseMcpSettings from './ReverseMcpSettings';
import AgentBotSettings from './AgentBotSettings';
import { RadioGroup, Row } from './SettingControls';
import { useI18n, useT, type MessageKey, type TranslateParams } from '../i18n';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';
const secondaryButtonCls =
  'h-8 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50';
const primaryButtonCls =
  'h-8 rounded-md bg-primary px-3 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-50';

interface PiPresetMeta {
  id: PiProviderPreset;
  labelKey: MessageKey;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultExtraModels: string;
  keyOptional?: boolean;
  hintKey: MessageKey;
}

const PI_PRESETS: readonly PiPresetMeta[] = [
  {
    id: 'deepseek',
    labelKey: 'settings.ai.preset.deepseek.label',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    defaultExtraModels: 'deepseek-v4-pro,deepseek-chat,deepseek-reasoner',
    hintKey: 'settings.ai.preset.deepseek.hint',
  },
  {
    id: 'anthropic',
    labelKey: 'settings.ai.preset.anthropic.label',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5.5',
    defaultExtraModels: 'claude-opus-5.5,claude-haiku-5.5,claude-3-7-sonnet-20250219',
    hintKey: 'settings.ai.preset.anthropic.hint',
  },
  {
    id: 'openai',
    labelKey: 'settings.ai.preset.openai.label',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    defaultExtraModels: 'gpt-6-astra,gpt-6-luna,o3-mini,gpt-4.5-preview,gpt-4o',
    hintKey: 'settings.ai.preset.openai.hint',
  },
  {
    id: 'google',
    labelKey: 'settings.ai.preset.google.label',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-argon',
    defaultExtraModels: 'gemini-3.8-flash,gemini-2.5-pro,gemini-2.0-flash',
    hintKey: 'settings.ai.preset.google.hint',
  },
  {
    id: 'custom-openai',
    labelKey: 'settings.ai.preset.customOpenai.label',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'deepseek-v4-flash',
    defaultExtraModels: 'claude-sonnet-5.5,gpt-6.1-sol,deepseek-r1',
    keyOptional: true,
    hintKey: 'settings.ai.preset.customOpenai.hint',
  },
  {
    id: 'ollama',
    labelKey: 'settings.ai.preset.ollama.label',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3-coder',
    defaultExtraModels: 'qwen3:8b,qwen3.8-27b,deepseek-r1:8b,qwen2.5-coder:7b',
    keyOptional: true,
    hintKey: 'settings.ai.preset.ollama.hint',
  },
  {
    id: 'openrouter',
    labelKey: 'settings.ai.preset.openrouter.label',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    defaultExtraModels: 'anthropic/claude-sonnet-5.5,openai/gpt-6.1-sol,google/gemini-4-argon',
    hintKey: 'settings.ai.preset.openrouter.hint',
  },
];

function aiRuntimeLabelKey(provider: AiRuntimeProvider): MessageKey {
  return provider === 'pi' ? 'settings.ai.runtimePiName' : 'settings.ai.runtimeNoneName';
}

export default function AiSettings() {
  const t = useT();
  const [activeAiRuntime, setActiveAiRuntime] = useState<AiRuntimeProvider>(getAiRuntimeProvider);
  const startupResolution = getAiRuntimeStartupResolution();
  const [selectedAiRuntime, setSelectedAiRuntime] = useState<AiRuntimeProvider>(
    () => readConfiguredAiRuntimeProvider() ?? getAiRuntimeProvider(),
  );
  const [ocrRuntime, setOcrRuntime] = useState<ImageOcrRuntimeProbe>();
  const [piProbe, setPiProbe] = useState<PiRuntimeProbe | null>(null);
  const [piConfig, setPiConfig] = useState<PiConfigView | null>(null);
  const [piProvider, setPiProvider] = useState<PiProviderPreset>('deepseek');
  const [piApiProtocol, setPiApiProtocol] = useState<PiApiProtocol>('auto');
  const [piBaseUrl, setPiBaseUrl] = useState('https://api.deepseek.com/v1');
  const [piApiKeyInput, setPiApiKeyInput] = useState('');
  const [piDefaultModel, setPiDefaultModel] = useState('deepseek-chat');
  const [piExtraModels, setPiExtraModels] = useState('deepseek-reasoner');
  const [piSaving, setPiSaving] = useState(false);
  const [piProbing, setPiProbing] = useState(false);
  const [endpointProbing, setEndpointProbing] = useState(false);
  const [endpointProbeResult, setEndpointProbeResult] = useState<PiEndpointProbeResult | null>(null);
  const [localGateways, setLocalGateways] = useState<PiLocalGatewayCandidate[]>([]);
  const [scanningLocalGateways, setScanningLocalGateways] = useState(false);
  const [showMoreProtocols, setShowMoreProtocols] = useState(false);

  const openButlerConversation = useUI((state) => state.openButlerConversation);

  useEffect(() => {
    if (!isTauri || !runtimeFeatures().ocr) return;
    void probeImageOcrRuntime().then(setOcrRuntime, (error) => {
      setOcrRuntime({ reason: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const refreshLocalGateways = async () => {
    if (!isTauri) return;
    setScanningLocalGateways(true);
    try {
      const found = await scanLocalPiGateways();
      setLocalGateways(found);
    } catch {
      // Ignore transient local port scan errors.
    } finally {
      setScanningLocalGateways(false);
    }
  };

  const refreshPiStatus = async () => {
    if (!isTauri) return;
    setPiProbing(true);
    try {
      const [cfg, probe] = await Promise.all([readPiConfig(), probePiRuntime()]);
      setPiConfig(cfg);
      setPiProvider(cfg.provider);
      const nextProto = cfg.apiProtocol ?? 'auto';
      setPiApiProtocol(nextProto);
      if (nextProto === 'mistral-conversations' || nextProto === 'bedrock-converse-stream') {
        setShowMoreProtocols(true);
      }
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
    void refreshLocalGateways();
  }, []);

  const applyPiPreset = (presetId: PiProviderPreset) => {
    const meta = PI_PRESETS.find((item) => item.id === presetId);
    setPiProvider(presetId);
    setPiApiProtocol('auto');
    setEndpointProbeResult(null);
    if (!meta) return;
    setPiBaseUrl(meta.defaultBaseUrl);
    setPiDefaultModel(meta.defaultModel);
    setPiExtraModels(meta.defaultExtraModels);
  };

  const applyLocalGateway = (gateway: PiLocalGatewayCandidate) => {
    const nextProvider: PiProviderPreset = gateway.id === 'ollama' ? 'ollama' : 'custom-openai';
    setPiProvider(nextProvider);
    setPiBaseUrl(gateway.baseUrl);
    setPiApiProtocol(gateway.protocol);
    setEndpointProbeResult(null);
    if (gateway.models.length > 0) {
      const merged = mergeDiscoveredModels(
        piDefaultModel,
        piExtraModels,
        gateway.models,
        gateway.models[0],
      );
      setPiDefaultModel(merged.defaultModel);
      setPiExtraModels(merged.extraModels);
    }
    toast.success(t('settings.ai.localGatewayApplied', { name: gateway.label }));
  };

  const handleProbeEndpoint = async () => {
    if (!isTauri) {
      toast.error(t('settings.ai.piDesktopOnly'));
      return;
    }
    const targetUrl = piBaseUrl.trim() || activePiPresetMeta.defaultBaseUrl;
    setEndpointProbing(true);
    try {
      const result = await probePiEndpoint({
        baseUrl: targetUrl,
        apiKey: piApiKeyInput.trim() || undefined,
        provider: piProvider,
        apiProtocol: piApiProtocol,
        preferredModel: piDefaultModel.trim() || undefined,
      });
      setEndpointProbeResult(result);
      if (result.normalizedBaseUrl) {
        setPiBaseUrl(result.normalizedBaseUrl);
      }
      if (result.detectedProtocol) {
        setPiApiProtocol(result.detectedProtocol);
        if (
          result.detectedProtocol === 'mistral-conversations'
          || result.detectedProtocol === 'bedrock-converse-stream'
        ) {
          setShowMoreProtocols(true);
        }
      }
      if (result.discoveredModels.length > 0) {
        const merged = mergeDiscoveredModels(
          piDefaultModel,
          piExtraModels,
          result.discoveredModels,
          result.suggestedModel,
        );
        setPiDefaultModel(merged.defaultModel);
        setPiExtraModels(merged.extraModels);
      }
      if (result.ok) {
        toast.success(
          t('settings.ai.endpointProbeSuccess', {
            protocol: result.detectedProtocol,
            count: result.discoveredModels.length,
          }),
        );
      } else {
        toast.error(result.summary || t('settings.ai.endpointProbeEmpty'));
      }
    } catch (error) {
      toast.error(error, t('settings.ai.endpointProbeFailed'));
    } finally {
      setEndpointProbing(false);
    }
  };

  const savePiConfiguration = async (activateNow: boolean) => {
    if (!isTauri) {
      toast.error(t('settings.ai.piDesktopOnly'));
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
        apiProtocol: piApiProtocol,
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
      setPiApiProtocol(saved.apiProtocol ?? piApiProtocol);
      setPiBaseUrl(saved.baseUrl);
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
        toast.success(t('settings.ai.piSavedAndEnabled'));
      } else {
        toast.success(t('settings.ai.piSaved'));
      }
    } catch (error) {
      toast.error(error, t('settings.ai.piSaveFailed'));
    } finally {
      setPiSaving(false);
    }
  };

  const selectAiRuntime = (provider: AiRuntimeProvider): void => {
    setSelectedAiRuntime(persistAiRuntimeProvider(provider));
  };
  const activeAiRuntimeLabel = t(aiRuntimeLabelKey(activeAiRuntime));
  const startupModeHint = startupResolution.source === 'automatic'
    ? t('settings.ai.startupModeAuto')
    : startupResolution.source === 'full-default'
      ? t('settings.ai.startupModeDefault')
      : '';
  const explicitRuntimeUnavailable = startupResolution.source === 'explicit-unavailable'
    && selectedAiRuntime === startupResolution.configured;
  const activePiPresetMeta = PI_PRESETS.find((item) => item.id === piProvider) ?? PI_PRESETS[0];
  const localProtocolHint = inferProtocolHintFromInput(piBaseUrl, piApiKeyInput);
  const activeProtocolMeta = PI_API_PROTOCOL_OPTIONS.find((item) => item.id === piApiProtocol)
    ?? PI_API_PROTOCOL_OPTIONS[0];
  const visibleProtocolOptions = showMoreProtocols
    ? PI_API_PROTOCOL_OPTIONS
    : PI_API_PROTOCOL_OPTIONS.filter((item) => item.primary || item.id === piApiProtocol);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t('settings.ai.runtimeHeading')}</h2>
        <div className="rounded-lg bg-surface px-4 shadow-raise">
          <Row label={t('settings.ai.backendLabel')} hint={t('settings.ai.backendHint')}>
            <div className="space-y-2">
              <RadioGroup
                value={selectedAiRuntime}
                options={[
                  {
                    key: 'pi',
                    label: t('settings.ai.runtimePiOptionLabel'),
                    hint: t('settings.ai.runtimePiOptionHint'),
                  },
                  {
                    key: 'none',
                    label: t('settings.ai.runtimeNoneName'),
                    hint: t('settings.ai.runtimeNoneOptionHint'),
                  },
                ]}
                onChange={selectAiRuntime}
              />
              <p className="text-xs leading-5 text-ink-3">
                {t('settings.ai.currentRuntimeStatus', {
                  runtime: activeAiRuntimeLabel,
                  modeHint: startupModeHint,
                })}
              </p>
              {explicitRuntimeUnavailable ? (
                <p className="text-xs font-medium leading-5 text-warning" role="status">
                  {t('settings.ai.explicitUnavailable', {
                    runtime: t(aiRuntimeLabelKey(selectedAiRuntime)),
                    reason: startupResolution.reason ? ` ${startupResolution.reason}` : '',
                  })}
                </p>
              ) : selectedAiRuntime !== activeAiRuntime ? (
                <p className="text-xs font-medium text-warning" role="status">
                  {t('settings.ai.pendingRestartSwitch', {
                    runtime: t(aiRuntimeLabelKey(selectedAiRuntime)),
                  })}
                </p>
              ) : null}
            </div>
          </Row>
        </div>
      </section>

      {selectedAiRuntime === 'pi' || activeAiRuntime === 'pi' ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('settings.ai.piSectionHeading')}</h2>
          <div className="rounded-lg bg-surface px-4 shadow-raise">
            <Row label={t('settings.ai.piStatusLabel')} hint={t('settings.ai.piStatusHint')}>
              <div className="space-y-2 text-sm text-ink-2">
                <p>
                  {piProbe?.ready
                    ? t('settings.ai.piReady', {
                        version: piProbe.version ?? '1.5.0',
                        node: piProbe.nodeVersion
                          ? t('settings.ai.piReadyNode', { version: piProbe.nodeVersion })
                          : '',
                      })
                    : piProbe?.reason || t('settings.ai.piProbing')}
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
                    {piProbing ? t('settings.ai.reprobing') : t('settings.ai.reprobe')}
                  </button>
                  {activeAiRuntime === 'pi' ? (
                    <button
                      type="button"
                      onClick={() => openButlerConversation()}
                      className={secondaryButtonCls}
                    >
                      {t('settings.ai.openButler')}
                    </button>
                  ) : null}
                </div>
              </div>
            </Row>

            <Row label={t('settings.ai.providerPresetLabel')} hint={t(activePiPresetMeta.hintKey)}>
              <div className="space-y-2.5">
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
                      {t(preset.labelKey)}
                    </button>
                  ))}
                </div>

                {localGateways.length > 0 || scanningLocalGateways ? (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-xs">
                    <span className="font-medium text-ink-2">
                      {scanningLocalGateways
                        ? t('settings.ai.scanningLocalGateways')
                        : t('settings.ai.localGatewaysFound')}
                    </span>
                    {localGateways.map((gw) => (
                      <button
                        key={gw.id}
                        type="button"
                        onClick={() => applyLocalGateway(gw)}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/15"
                        title={`${gw.baseUrl} · ${gw.protocol}`}
                      >
                        <span>{gw.label}</span>
                        <span className="text-ink-3">({gw.protocol})</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => void refreshLocalGateways()}
                      disabled={scanningLocalGateways}
                      className="ml-auto text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                    >
                      {t('settings.ai.rescanLocalGateways')}
                    </button>
                  </div>
                ) : (
                  <div>
                    <button
                      type="button"
                      onClick={() => void refreshLocalGateways()}
                      className="text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                    >
                      {t('settings.ai.scanLocalGateways')}
                    </button>
                  </div>
                )}
              </div>
            </Row>

            <Row label={t('settings.ai.baseUrlLabel')} hint={t('settings.ai.baseUrlHint')}>
              <div className="max-w-2xl space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={t('settings.ai.baseUrlAriaLabel')}
                    value={piBaseUrl}
                    onChange={(event) => {
                      const snippet = parseConnectionSnippet(event.target.value);
                      if (snippet) {
                        setPiProvider('custom-openai');
                        setPiBaseUrl(snippet.baseUrl);
                        setPiApiKeyInput(snippet.apiKey);
                        if (snippet.model) setPiDefaultModel(snippet.model);
                        return;
                      }
                      setPiBaseUrl(event.target.value);
                    }}
                    placeholder={activePiPresetMeta.defaultBaseUrl}
                    className={`${inputCls} flex-1 min-w-60`}
                  />
                  <button
                    type="button"
                    onClick={() => void handleProbeEndpoint()}
                    disabled={endpointProbing}
                    className={secondaryButtonCls}
                  >
                    {endpointProbing
                      ? t('settings.ai.probingEndpoint')
                      : t('settings.ai.probeEndpoint')}
                  </button>
                </div>

                {localProtocolHint.protocol !== 'auto' && piApiProtocol === 'auto' ? (
                  <p className="text-xs text-ink-3">
                    {t('settings.ai.instantProtocolHint', { protocol: localProtocolHint.protocol })}
                  </p>
                ) : null}

                {endpointProbeResult ? (
                  <div className="space-y-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${
                          endpointProbeResult.ok
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-warning/15 text-warning'
                        }`}
                      >
                        {endpointProbeResult.detectedProtocol}
                      </span>
                      <span className="text-ink-3">
                        {endpointProbeResult.latencyMs}ms
                      </span>
                      <span className="text-ink-2">{endpointProbeResult.summary}</span>
                    </div>

                    {endpointProbeResult.supportedProtocols.length > 1 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-ink-3">{t('settings.ai.supportedProtocolsLabel')}</span>
                        {endpointProbeResult.supportedProtocols.map((proto) => (
                          <button
                            key={proto}
                            type="button"
                            onClick={() => setPiApiProtocol(proto)}
                            className={`rounded-full border px-2 py-0.5 text-xs transition ${
                              piApiProtocol === proto
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-line bg-surface text-ink-2 hover:text-ink'
                            }`}
                          >
                            {proto}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {endpointProbeResult.discoveredModels.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-ink-3">{t('settings.ai.discoveredModelsLabel')}</span>
                        {endpointProbeResult.discoveredModels.slice(0, 8).map((modelId) => (
                          <button
                            key={modelId}
                            type="button"
                            onClick={() => setPiDefaultModel(modelId)}
                            className={`rounded-full border px-2 py-0.5 font-mono text-xs transition ${
                              piDefaultModel === modelId
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-line bg-surface text-ink-2 hover:text-ink'
                            }`}
                          >
                            {modelId}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Row>

            <Row label={t('settings.ai.protocolLabel')} hint={t(activeProtocolMeta.descKey)}>
              <div className="flex flex-wrap items-center gap-1.5">
                {visibleProtocolOptions.map((proto) => (
                  <button
                    key={proto.id}
                    type="button"
                    onClick={() => setPiApiProtocol(proto.id)}
                    className={`h-8 rounded-md border px-2.5 text-xs font-medium transition ${
                      piApiProtocol === proto.id
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-line bg-surface text-ink-2 hover:bg-fill-hover hover:text-ink'
                    }`}
                  >
                    {t(proto.labelKey)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowMoreProtocols((prev) => !prev)}
                  className="h-8 rounded-md px-2 text-xs text-ink-3 hover:text-ink"
                >
                  {showMoreProtocols
                    ? t('settings.ai.hideMoreProtocols')
                    : t('settings.ai.showMoreProtocols')}
                </button>
              </div>
            </Row>

            <Row
              label={t('settings.ai.apiKeyLabel')}
              hint={
                activePiPresetMeta.keyOptional
                  ? t('settings.ai.apiKeyHintOptional')
                  : t('settings.ai.apiKeyHintRequired')
              }
            >
              <div className="max-w-2xl space-y-1.5">
                <input
                  type="password"
                  aria-label="Pi API Key"
                  value={piApiKeyInput}
                  onChange={(event) => {
                    const snippet = parseConnectionSnippet(event.target.value);
                    if (snippet) {
                      setPiProvider('custom-openai');
                      setPiBaseUrl(snippet.baseUrl);
                      setPiApiKeyInput(snippet.apiKey);
                      if (snippet.model) setPiDefaultModel(snippet.model);
                      return;
                    }
                    setPiApiKeyInput(event.target.value);
                  }}
                  placeholder={
                    piConfig?.hasApiKey
                      ? t('settings.ai.apiKeySavedPlaceholder', { hint: piConfig.apiKeyHint ?? '••••' })
                      : activePiPresetMeta.keyOptional
                        ? t('settings.ai.apiKeyOptionalPlaceholder')
                        : 'sk-...'
                  }
                  className={inputCls}
                />
                {piConfig?.hasApiKey ? (
                  <p className="text-xs text-ink-3">
                    {t('settings.ai.apiKeySavedNote', {
                      hint: piConfig.apiKeyHint ?? t('settings.ai.apiKeyConfiguredFallback'),
                    })}
                  </p>
                ) : null}
              </div>
            </Row>

            <Row label={t('settings.ai.modelsLabel')} hint={t('settings.ai.modelsHint')}>
              <div className="max-w-2xl space-y-2">
                <input
                  aria-label={t('settings.ai.defaultModelAriaLabel')}
                  value={piDefaultModel}
                  onChange={(event) => setPiDefaultModel(event.target.value)}
                  placeholder={t('settings.ai.defaultModelPlaceholder')}
                  className={inputCls}
                />
                <input
                  aria-label={t('settings.ai.extraModelsAriaLabel')}
                  value={piExtraModels}
                  onChange={(event) => setPiExtraModels(event.target.value)}
                  placeholder={t('settings.ai.extraModelsPlaceholder')}
                  className={inputCls}
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={piSaving || !piDefaultModel.trim()}
                    onClick={() => void savePiConfiguration(true)}
                    className={primaryButtonCls}
                  >
                    {piSaving ? t('settings.account.saving') : t('settings.ai.saveAndEnablePi')}
                  </button>
                  <button
                    type="button"
                    disabled={piSaving || !piDefaultModel.trim()}
                    onClick={() => void savePiConfiguration(false)}
                    className={secondaryButtonCls}
                  >
                    {t('settings.ai.saveOnly')}
                  </button>
                </div>
              </div>
            </Row>
            <Row label={t('settings.ai.ocrLabel')} hint={t('settings.ai.ocrHint')}>
              <div className="space-y-2 text-sm text-ink-2">
                <p>
                  {ocrRuntime?.backend
                    ? ocrRuntime.backend === 'pp-ocrv5'
                      ? t('settings.ai.ocrBackendPp')
                      : ocrBackendLabel(ocrRuntime.backend)
                    : t('settings.ai.ocrProbing')}
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
          {t('settings.ai.noneNotice')}
        </section>
      ) : null}

      <AcpClientsSettingsSection />

      {activeAiRuntime !== 'none' ? <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t('settings.ai.externalIntegrations')}</h2>
        <div className="space-y-6 rounded-lg bg-surface p-4 shadow-raise">
          <ReverseMcpSettings />
          <AgentBotSettings />
        </div>
      </section> : null}
    </div>
  );
}

type AcpNotice = { key: MessageKey; params?: TranslateParams } | { raw: string };

function AcpClientsSettingsSection() {
  const { t, tp } = useI18n();
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
  const [notice, setNotice] = useState<AcpNotice | null>(null);

  const unadoptedCount = discovered.filter((c) => !c.alreadyRegistered).length;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const startPresetAdd = (targetPreset: AcpAgentPreset) => {
    const tpl = ACP_PRESET_TEMPLATES.find((item) => item.preset === targetPreset);
    setEditingId(null);
    setPreset(targetPreset);
    setName(tpl?.name || t('settings.ai.acp.customNameFallback'));
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
      setNotice({ key: 'settings.ai.acp.missingNameOrCommand' });
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
      setNotice({ key: 'settings.ai.acp.savedNotice', params: { name: saved.name } });
    } catch (err) {
      setNotice({ raw: err instanceof Error ? err.message : String(err) });
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
          ? t('settings.ai.acp.discoveredWithVersion', { version: cand.version })
          : t('settings.ai.acp.discoveredDefault'),
      });
      setNotice({ key: 'settings.ai.acp.adoptedNotice', params: { name: saved.name } });
    } catch (err) {
      setNotice({ raw: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleAdoptAll = async () => {
    setAdoptingAll(true);
    setNotice(null);
    try {
      const added = await adoptAllDiscoveredAgents();
      setNotice(
        added.length > 0
          ? {
              raw: tp(
                added.length,
                'settings.ai.acp.adoptedAllOne',
                'settings.ai.acp.adoptedAllOther',
                { count: added.length },
              ),
            }
          : { key: 'settings.ai.acp.allAlreadyRegistered' },
      );
    } catch (err) {
      setNotice({ raw: err instanceof Error ? err.message : String(err) });
    } finally {
      setAdoptingAll(false);
    }
  };

  const noticeText = notice ? ('raw' in notice ? notice.raw : t(notice.key, notice.params)) : null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('settings.ai.acp.heading')}</h2>
          <p className="text-xs text-ink-3">
            {t('settings.ai.acp.subheading')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={discovering}
            onClick={() => void discoverLocalAgents()}
            className="rounded-lg border border-line bg-surface-4 px-2.5 py-1 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
          >
            {discovering ? t('settings.ai.acp.scanning') : t('settings.ai.acp.rescan')}
          </button>
          {unadoptedCount > 0 ? (
            <button
              type="button"
              disabled={adoptingAll}
              onClick={() => void handleAdoptAll()}
              className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
            >
              {adoptingAll ? t('settings.ai.acp.adopting') : t('settings.ai.acp.adoptAll', { count: unadoptedCount })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => startPresetAdd('codex-acp')}
            className="rounded-lg border border-line bg-surface-4 px-2.5 py-1 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover"
          >
            {t('settings.ai.acp.addClient')}
          </button>
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-line bg-surface-4 p-4 shadow-raise">
        {noticeText ? (
          <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
            {noticeText}
          </div>
        ) : null}

        {discovered.length > 0 ? (
          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-ink">
              <span>{t('settings.ai.acp.discoveredHeader', { count: discovered.length })}</span>
              {unadoptedCount > 0 ? (
                <button
                  type="button"
                  disabled={adoptingAll}
                  onClick={() => void handleAdoptAll()}
                  className="text-primary hover:underline disabled:opacity-50"
                >
                  {t('settings.ai.acp.adoptAll', { count: unadoptedCount })}
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
                      {t('settings.ai.acp.alreadyRegistered')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleAdopt(cand)}
                      className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-hover"
                    >
                      {t('settings.ai.acp.adopt')}
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
                {editingId ? t('settings.ai.acp.editTitle') : t('settings.ai.acp.addTitle')}
              </span>
              <button
                type="button"
                onClick={() => {
                  setEditorOpen(false);
                  setEditingId(null);
                }}
                className="text-xs text-ink-3 hover:text-ink"
              >
                {t('common.cancel')}
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
                placeholder={t('settings.ai.acp.namePlaceholder')}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
              />
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t('settings.ai.acp.commandPlaceholder')}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-primary"
              />
              <input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder={t('settings.ai.acp.argsPlaceholder')}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-primary"
              />
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t('settings.ai.acp.cwdPlaceholder')}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
              />
            </div>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.ai.acp.descPlaceholder')}
              className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={autoApproveSafeReads}
                  onChange={(e) => setAutoApproveSafeReads(e.target.checked)}
                />
                {t('settings.ai.acp.autoApproveSafeReads')}
              </label>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? t('settings.ai.acp.saving') : t('settings.ai.acp.saveConfig')}
              </button>
            </div>
          </div>
        ) : null}

        {agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-ink-3">
            {t('settings.ai.acp.emptyState')}
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
                            ? probe.version
                              ? t('settings.ai.acp.readyWithVersion', { version: probe.version })
                              : t('settings.ai.acp.ready')
                            : probe.reason || t('settings.ai.acp.unavailable')}
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
                      {t('settings.ai.acp.probeAction')}
                    </button>
                    <button
                      type="button"
                      onClick={() => openAcpHub(agent.id)}
                      className="rounded bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25"
                    >
                      {t('settings.ai.acp.openHub')}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(agent)}
                      className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeAgent(agent.id)}
                      className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                    >
                      {t('settings.ai.acp.removeAction')}
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
