import { ChevronDown, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  AI_CAPABILITIES,
  loadAiSettings,
  saveAiSettings,
  type AiProviderConfig,
  type AiSettings,
} from '../kernel/ai/config';
import { deleteAiSecret, setAiSecret } from '../kernel/ai/secrets';
import { testAiProvider } from '../kernel/ai/runtime';
import {
  BUTLER_CODEX_EFFORTS,
  codexBrainAvailability,
  getButlerBrain,
  getButlerCodexSettings,
  setButlerBrain,
  setButlerCodexSettings,
  type ButlerBrainKind,
  type ButlerCodexSettings,
} from '../lib/butlerBrain';
import {
  getAgentHostingCodexSettings,
  setAgentHostingCodexSettings,
} from '../lib/agentHostingSettings';
import {
  DEFAULT_PERSONA,
  getPersona,
  resetPersona,
  setPersona,
} from '../lib/butlerProfile';
import {
  AXIS_META,
  DEFAULT_AXES,
  loadPersonality,
  savePersonality,
  type PersonalityAxes,
} from '../lib/butlerPersonality';
import { isTauri } from '../lib/http';
import { toast } from '../stores/toast';
import ReverseMcpSettings from './ReverseMcpSettings';
import AgentBotSettings from './AgentBotSettings';
import LocalAgentEnvironmentsSettings from './LocalAgentEnvironmentsSettings';
import { RadioGroup, Row, Slider } from './SettingControls';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

function newProvider(): AiProviderConfig {
  return {
    id: `openai-${crypto.randomUUID()}`,
    kind: 'openai-compatible',
    name: 'OpenAI-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    locality: 'local',
    hasSecret: false,
  };
}

/**
 * AI 设置分三层：运行方式和工作目录是基础设置直接可见；「高级 AI 设置」里
 * 按保存方式分成两组——Provider 与能力路由由「保存 AI 配置」统一保存，
 * 外部集成（反向 MCP、共享 Agent 身份）各自即时生效。
 */
export default function AiSettings() {
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [butlerBrain, setButlerBrainState] = useState<ButlerBrainKind>(getButlerBrain);
  const [butlerCodex, setButlerCodexState] = useState<ButlerCodexSettings>(getButlerCodexSettings);
  const [hostingCodex, setHostingCodexState] = useState<ButlerCodexSettings>(getAgentHostingCodexSettings);
  const [persona, setPersonaState] = useState<string>(getPersona);
  const [savedPersona, setSavedPersona] = useState<string>(getPersona);
  const [personality, setPersonalityState] = useState<PersonalityAxes>(loadPersonality);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [results, setResults] = useState<Record<string, string>>({});

  const updateProvider = (id: string, patch: Partial<AiProviderConfig>) => {
    setSettings((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    }));
  };

  const persist = async (notify = true): Promise<AiSettings> => {
    const providers = [...settings.providers];
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      const secret = secrets[provider.id]?.trim();
      if (secret) {
        await setAiSecret(provider.id, secret);
        providers[index] = { ...provider, hasSecret: true };
      }
    }
    const next = { ...settings, providers };
    saveAiSettings(next);
    setSettings(next);
    setSecrets({});
    if (notify) {
      toast.success(isTauri ? 'AI 配置已保存，密钥已写入系统钥匙串' : 'AI 配置已保存，密钥仅保留到本次页面会话');
    }
    return next;
  };

  const save = async () => {
    setBusy('save');
    try {
      await persist();
    } catch (error) {
      toast.error(error, '保存 AI 配置失败');
    } finally {
      setBusy(undefined);
    }
  };

  const test = async (providerId: string) => {
    setBusy(`test:${providerId}`);
    setResults((current) => ({ ...current, [providerId]: '' }));
    try {
      const saved = await persist(false);
      const provider = saved.providers.find((candidate) => candidate.id === providerId);
      if (!provider) throw new Error('Provider 不存在');
      if (provider.locality === 'external' && !provider.hasSecret) {
        throw new Error('请先填写 API 密钥');
      }
      const reply = await testAiProvider(providerId);
      setResults((current) => ({ ...current, [providerId]: `连接成功：${reply}` }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResults((current) => ({ ...current, [providerId]: `连接失败：${message}` }));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (providerId: string) => {
    if (settings.providers.length === 1) {
      toast.error('至少保留一个 AI Provider');
      return;
    }
    await deleteAiSecret(providerId);
    const fallback = settings.providers.find((provider) => provider.id !== providerId)?.id ?? '';
    setSettings((current) => ({
      providers: current.providers.filter((provider) => provider.id !== providerId),
      routes: Object.fromEntries(
        Object.entries(current.routes).map(([capability, route]) => [
          capability,
          route.providerId === providerId ? { ...route, providerId: fallback } : route,
        ]),
      ) as AiSettings['routes'],
    }));
  };

  const clearSecret = async (providerId: string) => {
    setBusy(`secret:${providerId}`);
    try {
      await deleteAiSecret(providerId);
      const next = {
        ...settings,
        providers: settings.providers.map((provider) =>
          provider.id === providerId ? { ...provider, hasSecret: false } : provider,
        ),
      };
      saveAiSettings(next);
      setSettings(next);
      setSecrets((current) => ({ ...current, [providerId]: '' }));
    } finally {
      setBusy(undefined);
    }
  };

  const updateButlerCodex = (patch: Partial<ButlerCodexSettings>) => {
    const next = { ...butlerCodex, ...patch };
    setButlerCodexSettings(next);
    setButlerCodexState(next);
  };

  const updateHostingCodex = (patch: Partial<ButlerCodexSettings>) => {
    const next = { ...hostingCodex, ...patch };
    setAgentHostingCodexSettings(next);
    setHostingCodexState(next);
  };

  const savePersona = () => {
    const value = persona.trim();
    if (!value || value === DEFAULT_PERSONA) {
      // 清空或改回默认文本都视为恢复默认
      resetPersona();
      setPersonaState(DEFAULT_PERSONA);
      setSavedPersona(DEFAULT_PERSONA);
    } else {
      setPersona(persona);
      setSavedPersona(persona);
    }
    toast.success('AI 人设已保存，对下一次提问生效');
  };

  const restoreDefaultPersona = () => {
    resetPersona();
    setPersonaState(DEFAULT_PERSONA);
    setSavedPersona(DEFAULT_PERSONA);
    toast.success('已恢复默认人设');
  };

  const codexAvailability = codexBrainAvailability();

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">AI 运行方式</h2>
        <div className="rounded-lg border border-line bg-surface px-4">
          <Row label="AI 管家大脑" hint="切换后立即对下一次管家提问生效；不会静默降级。">
            <RadioGroup
              value={butlerBrain}
              onChange={(brain) => {
                setButlerBrain(brain);
                setButlerBrainState(brain);
              }}
              options={[
                {
                  key: 'codex',
                  label: 'Codex（本机，桌面端）',
                  hint: codexAvailability.available ? '使用本机 ChatGPT 账号模型' : codexAvailability.reason,
                  disabled: !codexAvailability.available,
                },
                {
                  key: 'api',
                  label: 'API Provider',
                  hint: '使用高级 AI 设置里「按能力路由」中 Agent 指向的 Provider',
                },
              ]}
            />
          </Row>
          <Row
            label="人设"
            hint="只影响管家（桌面对话、房间管家面板与晨报等技能）；AI 托管的编码代理和安全纪律不受影响。保存后对下一次提问生效，Codex 大脑会自动换用新线程。"
          >
            <textarea
              aria-label="AI 人设"
              value={persona}
              onChange={(event) => setPersonaState(event.target.value)}
              rows={5}
              className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm leading-6 text-ink outline-none transition focus:border-primary"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={savePersona}
                disabled={persona === savedPersona}
                className="h-8 rounded-md bg-primary px-3 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                保存人设
              </button>
              <button
                onClick={restoreDefaultPersona}
                disabled={persona === DEFAULT_PERSONA && savedPersona === DEFAULT_PERSONA}
                className="h-8 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
              >
                恢复默认
              </button>
            </div>
          </Row>
          {butlerBrain === 'codex' && (
            <>
              <Row label="管家 Codex 模型" hint="留空时跟随 Codex CLI 的默认模型。">
                <input
                  aria-label="管家 Codex 模型"
                  value={butlerCodex.model}
                  onChange={(event) => updateButlerCodex({ model: event.target.value })}
                  placeholder="例如 gpt-5.4"
                  className={`${inputCls} max-w-xs`}
                />
              </Row>
              <Row label="管家推理强度" hint="只影响 AI 管家；模型不支持时 Codex 会返回明确错误。">
                <select
                  aria-label="管家 Codex 推理强度"
                  value={butlerCodex.effort}
                  onChange={(event) => updateButlerCodex({ effort: event.target.value as ButlerCodexSettings['effort'] })}
                  className={`${inputCls} max-w-xs`}
                >
                  {BUTLER_CODEX_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>{effort === 'default' ? '跟随 Codex 默认值' : effort}</option>
                  ))}
                </select>
              </Row>
            </>
          )}
          <Row label="AI 托管 Codex 模型" hint="只影响聊天中的 AI 托管；留空时跟随 Codex CLI 默认模型。">
            <input
              aria-label="AI 托管 Codex 模型"
              value={hostingCodex.model}
              onChange={(event) => updateHostingCodex({ model: event.target.value })}
              placeholder="例如 gpt-5.4"
              className={`${inputCls} max-w-xs`}
            />
          </Row>
          <Row label="AI 托管推理强度" hint="与管家独立，修改后对托管会话的下一次执行生效。">
            <select
              aria-label="AI 托管 Codex 推理强度"
              value={hostingCodex.effort}
              onChange={(event) => updateHostingCodex({ effort: event.target.value as ButlerCodexSettings['effort'] })}
              className={`${inputCls} max-w-xs`}
            >
              {BUTLER_CODEX_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>{effort === 'default' ? '跟随 Codex 默认值' : effort}</option>
              ))}
            </select>
          </Row>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">管家性格</h2>
        <p className="mb-2 text-xs text-ink-3">四条轴的组合覆盖从"极简效率"到"温和关怀"的跨度，影响管家的表达方式。</p>
        <div className="rounded-lg border border-line bg-surface px-4">
          {AXIS_META.map((axis) => (
            <Row
              key={axis.key}
              label={axis.label}
              hint={`${axis.low} ← → ${axis.high}`}
            >
              <div className="flex items-center gap-3">
                <span className="w-16 text-right text-xs text-ink-3">{axis.low}</span>
                <Slider
                  value={personality[axis.key]}
                  onChange={(v) => {
                    const next = { ...personality, [axis.key]: v };
                    setPersonalityState(next);
                    savePersonality(next);
                  }}
                  min={1}
                  max={5}
                />
                <span className="w-16 text-xs text-ink-3">{axis.high}</span>
              </div>
            </Row>
          ))}
          <Row label="" hint="">
            <button
              onClick={() => {
                setPersonalityState(DEFAULT_AXES);
                savePersonality(DEFAULT_AXES);
                toast.success('已恢复默认性格（克制、预判、不越界）');
              }}
              disabled={JSON.stringify(personality) === JSON.stringify(DEFAULT_AXES)}
              className="h-8 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
            >
              恢复默认
            </button>
          </Row>
        </div>
      </section>

      <LocalAgentEnvironmentsSettings />

      <details className="group rounded-lg border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 transition hover:bg-fill-hover">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">高级 AI 设置</div>
            <div className="mt-0.5 text-xs text-ink-3">模型 Provider、能力路由与外部集成</div>
          </div>
          <ChevronDown size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" />
        </summary>

        <div className="border-t border-line p-4">
          <section>
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">模型 Provider</h2>
                <p className="mt-0.5 text-xs leading-5 text-ink-3">
                  供会话总结、晨报、翻译等能力使用；「AI 运行方式」选 API 时也作为
                  AI 大脑。桌面端密钥只保存到系统钥匙串。
                </p>
              </div>
              <button
                onClick={() => setSettings((current) => ({ ...current, providers: [...current.providers, newProvider()] }))}
                className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line px-3 text-sm text-ink hover:bg-fill-hover"
              >
                <Plus size={14} /> 添加 OpenAI-compatible
              </button>
            </div>
            <div className="space-y-3">
              {settings.providers.map((provider) => (
                <div key={provider.id} className="rounded-lg border border-line bg-surface p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      aria-label="Provider 名称"
                      value={provider.name}
                      onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
                      className={`${inputCls} max-w-xs font-medium`}
                    />
                    <span className={`rounded px-2 py-1 text-xs ${provider.locality === 'local' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                      {provider.locality === 'local' ? '本地' : '外部'}
                    </span>
                    <button
                      title="删除 Provider"
                      onClick={() => void remove(provider.id)}
                      className="ml-auto rounded p-2 text-ink-3 hover:bg-fill-hover hover:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs text-ink-3">
                      协议
                      <select
                        value={provider.kind}
                        onChange={(event) => updateProvider(provider.id, { kind: event.target.value as AiProviderConfig['kind'] })}
                        className={`mt-1 ${inputCls}`}
                      >
                        <option value="openai-compatible">OpenAI-compatible</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="azure-openai">Azure OpenAI v1</option>
                      </select>
                    </label>
                    <label className="text-xs text-ink-3">
                      Base URL
                      <input
                        value={provider.baseUrl}
                        onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
                        className={`mt-1 ${inputCls}`}
                      />
                    </label>
                    <label className="text-xs text-ink-3">
                      Chat 模型
                      <input
                        value={provider.model}
                        onChange={(event) => updateProvider(provider.id, { model: event.target.value })}
                        placeholder="deepseek-v4-flash"
                        className={`mt-1 ${inputCls}`}
                      />
                    </label>
                    <label className="text-xs text-ink-3">
                      网络位置
                      <select
                        value={provider.locality}
                        onChange={(event) => updateProvider(provider.id, { locality: event.target.value as 'local' | 'external' })}
                        className={`mt-1 ${inputCls}`}
                      >
                        <option value="external">外部网络</option>
                        <option value="local">本机 / 内网</option>
                      </select>
                    </label>
                    <label className="text-xs text-ink-3 sm:col-span-2">
                      API 密钥 {provider.hasSecret && <span className="text-success">（已保存）</span>}
                      <div className="mt-1 flex gap-2">
                        <input
                          type="password"
                          value={secrets[provider.id] ?? ''}
                          onChange={(event) => setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))}
                          placeholder={provider.hasSecret ? '留空则保留现有密钥' : provider.locality === 'local' ? '本地服务可留空' : '输入后保存到系统钥匙串'}
                          autoComplete="new-password"
                          className={inputCls}
                        />
                        {provider.hasSecret && (
                          <button
                            onClick={() => void clearSecret(provider.id)}
                            className="shrink-0 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover"
                          >
                            清除密钥
                          </button>
                        )}
                      </div>
                    </label>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      onClick={() => void test(provider.id)}
                      disabled={!!busy}
                      className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
                    >
                      {busy === `test:${provider.id}` ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                      测试连接
                    </button>
                    {results[provider.id] && (
                      <span className={`text-xs ${results[provider.id].startsWith('连接成功') ? 'text-success' : 'text-danger'}`}>
                        {results[provider.id]}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-ink">按能力路由</h2>
            <div className="divide-y divide-line rounded-lg border border-line bg-surface">
              {AI_CAPABILITIES.map(({ id, label }) => {
                const route = settings.routes[id];
                return (
                  <div key={id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="w-40 text-sm text-ink">{label}</span>
                    <select
                      value={route.providerId}
                      onChange={(event) => setSettings((current) => ({
                        ...current,
                        routes: { ...current.routes, [id]: { ...route, providerId: event.target.value } },
                      }))}
                      className={`${inputCls} max-w-xs`}
                    >
                      {settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                    </select>
                    <label className="flex items-center gap-2 text-xs text-ink-2">
                      <input
                        type="checkbox"
                        checked={route.localOnly}
                        onChange={(event) => setSettings((current) => ({
                          ...current,
                          routes: { ...current.routes, [id]: { ...route, localOnly: event.target.checked } },
                        }))}
                      />
                      仅本地模型
                    </label>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={!!busy}
              className="h-9 rounded-md bg-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'save' ? '保存中…' : '保存 AI 配置'}
            </button>
            <span className="text-xs text-ink-3">保存上方 Provider 与能力路由</span>
          </div>

          <div className="mt-8 space-y-6 border-t border-line pt-5">
            <div>
              <h2 className="text-sm font-semibold text-ink">外部集成</h2>
              <p className="mt-0.5 text-xs text-ink-3">以下配置各自即时生效，不需要点「保存 AI 配置」。</p>
            </div>
            <ReverseMcpSettings />
            <AgentBotSettings />
          </div>
        </div>
      </details>
    </div>
  );
}
