import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
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
import { isTauri } from '../lib/http';
import { toast } from '../stores/toast';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

function newProvider(): AiProviderConfig {
  return {
    id: `openai-${crypto.randomUUID()}`,
    kind: 'openai-compatible',
    name: 'OpenAI-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    embeddingModel: '',
    locality: 'local',
    hasSecret: false,
  };
}

export default function AiSettings() {
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
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

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-2">
        <div className="font-medium text-ink">模型调用与隐私</div>
        <p className="mt-1 leading-6">
          DeepSeek 默认使用即将长期支持的 deepseek-v4-flash。桌面端密钥只存系统钥匙串；AI
          审计只记录 Provider、能力、耗时和结果，不记录提示词或密钥。
        </p>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Provider</h2>
          <button
            onClick={() => setSettings((current) => ({ ...current, providers: [...current.providers, newProvider()] }))}
            className="flex h-8 items-center gap-1 rounded-md border border-line px-3 text-sm text-ink hover:bg-fill-hover"
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
                  Embedding 模型（可选）
                  <input
                    value={provider.embeddingModel ?? ''}
                    onChange={(event) => updateProvider(provider.id, { embeddingModel: event.target.value })}
                    placeholder="DeepSeek 官方没有 embedding 模型"
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

      <section>
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

      <button
        onClick={() => void save()}
        disabled={!!busy}
        className="h-9 rounded-md bg-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy === 'save' ? '保存中…' : '保存 AI 配置'}
      </button>
    </div>
  );
}
