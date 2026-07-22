import { useRef, useState } from 'react';
import {
  ArrowRight,
  BrainCircuit,
  Check,
  FileUp,
  GitBranch,
  Loader2,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react';
import { applyWorkspaceConfigDefaults } from '../components/WorkspaceConfigImport';
import { completeFirstRun } from '../lib/firstRun';
import { probeRocketChat } from '../lib/loginDiagnostic';
import { loadWorkspaceSource, parseWorkspaceConfig, type WorkspaceConfig } from '../lib/workspaceConfig';
import { fetchWorkspaceConfig } from '../lib/workspaceConfigSource';

function configSummary(config: WorkspaceConfig): { label: string; value: string }[] {
  const items: { label: string; value: string }[] = [];
  if (config.rocketChat) items.push({ label: 'Rocket.Chat', value: config.rocketChat.url });
  if (config.ado?.url) items.push({ label: 'Azure DevOps', value: config.ado.url });
  if (config.ai?.providers.length) {
    items.push({
      label: 'AI 服务',
      value: config.ai.providers
        .map((provider) => `${provider.name || provider.id} · ${provider.baseUrl} · ${provider.model}`)
        .join('、'),
    });
  }
  if (config.workItemTemplates) {
    items.push({
      label: '工作项模板',
      value: 'url' in config.workItemTemplates
        ? config.workItemTemplates.url
        : `${config.workItemTemplates.templates.length} 个内联模板`,
    });
  }
  if (config.update) {
    const value = config.update.source === 'github' ? 'GitHub Release' : config.update.location || config.update.source;
    items.push({ label: '更新源', value });
  }
  return items;
}

export default function FirstRunPage({ onContinue }: { onContinue: () => void }) {
  const existingSource = loadWorkspaceSource();
  const [url, setUrl] = useState(existingSource?.url ?? '');
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const acceptText = (text: string, nextSourceUrl?: string) => {
    const parsed = parseWorkspaceConfig(text);
    if (!parsed.rocketChat?.url) {
      throw new Error('团队配置必须包含 Rocket.Chat 服务器地址');
    }
    setConfig(parsed);
    setSourceUrl(nextSourceUrl);
  };

  const loadUrl = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await fetchWorkspaceConfig(url);
      if (!parsed.rocketChat?.url) throw new Error('团队配置必须包含 Rocket.Chat 服务器地址');
      setConfig(parsed);
      setSourceUrl(url.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取团队配置');
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      acceptText(await file.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : '配置文件无法读取');
    }
  };

  const continuePersonal = () => {
    completeFirstRun(localStorage);
    onContinue();
  };

  const joinTeam = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    let phase: 'probe' | 'apply' = 'probe';
    try {
      await probeRocketChat(config.rocketChat!.url);
      phase = 'apply';
      await applyWorkspaceConfigDefaults(config, sourceUrl);
      completeFirstRun(localStorage);
      onContinue();
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      setError(phase === 'probe' ? `Rocket.Chat 验证失败：${message}` : `团队配置无法应用：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const summary = config ? configSummary(config) : [];

  return (
    <main className="min-h-full overflow-y-auto bg-fill-2 px-5 py-8 lg:px-10">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-[1120px] overflow-hidden rounded-2xl border border-line bg-surface-4 shadow-[0_18px_60px_rgba(31,35,41,0.12)] lg:grid-cols-[1.15fr_0.85fr]">
        <section className="flex flex-col justify-between bg-ink px-8 py-10 text-white lg:px-12 lg:py-12">
          <div>
            <div className="mb-10 flex items-center gap-3 text-sm font-medium text-white/80">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-semibold text-white">RX</span>
              RocketX
            </div>
            <p className="text-sm font-medium text-primary-light">团队协作的 GTD 可信系统</p>
            <h1 className="mt-3 max-w-xl text-3xl leading-tight font-semibold tracking-tight lg:text-4xl">
              让团队消息进入系统，<br />而不是留在每个人的大脑里。
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-7 text-white/70">
              RocketX 连接团队已有的 Rocket.Chat，把消息、待办、工作项与日程纳入同一个可信流程。
              它不追求制造更多提醒，而是帮助团队捕获、理清、组织、回顾，最后把事情真正执行掉。
            </p>

            <div className="mt-9 space-y-5">
              <div className="flex gap-3">
                <MessageSquareText className="mt-0.5 shrink-0 text-primary-light" size={19} />
                <div>
                  <div className="text-sm font-medium">Rocket.Chat 保持不变</div>
                  <p className="mt-1 text-xs leading-5 text-white/60">消息和账号仍由原服务器管理，团队无需迁移历史，也不被新的服务端绑定。</p>
                </div>
              </div>
              <div className="flex gap-3">
                <BrainCircuit className="mt-0.5 shrink-0 text-primary-light" size={19} />
                <div>
                  <div className="text-sm font-medium">保护注意力，而不是放大噪声</div>
                  <p className="mt-1 text-xs leading-5 text-white/60">通知聚合、今日收件箱和 AI 管家把信息变成可处理的承诺，由人决定何时关注。</p>
                </div>
              </div>
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-primary-light" size={19} />
                <div>
                  <div className="text-sm font-medium">AI 行动有边界</div>
                  <p className="mt-1 text-xs leading-5 text-white/60">本地能力优先，权限与来源可见；Agent 可以帮助执行，但写入和危险操作必须经过确认。</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-10 border-t border-white/10 pt-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-white/55">
              {['捕获', '理清', '组织', '回顾', '执行'].map((step, index) => (
                <span key={step} className="flex items-center gap-2">
                  <span>{step}</span>
                  {index < 4 && <ArrowRight size={12} className="text-white/25" />}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="flex flex-col justify-center px-7 py-10 lg:px-10">
          <div className="mb-7 flex items-center gap-2 text-xs text-ink-3">
            <span className="font-medium text-primary">1 加入团队</span>
            <span>·</span>
            <span>2 验证身份</span>
            <span>·</span>
            <span>3 开始工作</span>
          </div>

          {!config ? (
            <>
              <GitBranch size={28} className="text-primary" />
              <h2 className="mt-4 text-xl font-semibold text-ink">加入团队工作区</h2>
              <p className="mt-2 text-sm leading-6 text-ink-3">
                粘贴团队提供的配置链接，一次设置 Rocket.Chat、Azure DevOps、AI、模板和更新源。
                配置可以放在 Git 仓库中，但必须使用本机无需登录即可访问的 rcx.workspace.json Raw 地址。
              </p>

              <label className="mt-6 block">
                <span className="mb-1.5 block text-sm text-ink-2">团队配置地址</span>
                <input
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError(null);
                  }}
                  placeholder="https://git.example.com/team/config/raw/rcx.workspace.json"
                  autoFocus
                  className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
                />
              </label>

              {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2.5 text-sm leading-5 text-danger">{error}</div>}

              <button
                onClick={() => void loadUrl()}
                disabled={!url.trim() || busy}
                className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                {busy ? '正在读取团队配置…' : '读取团队配置'}
              </button>

              <button
                onClick={() => fileRef.current?.click()}
                className="mt-2 flex h-9 w-full items-center justify-center gap-2 text-sm text-ink-3 hover:text-primary"
              >
                <FileUp size={14} /> 从本地选择 rcx.workspace.json
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  void loadFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />

              <div className="mt-7 border-t border-line pt-5 text-center text-xs text-ink-3">
                没有团队配置？{' '}
                <button onClick={continuePersonal} className="text-primary hover:underline">个人设置</button>
              </div>
            </>
          ) : (
            <>
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-success/15 text-success">
                <Check size={22} />
              </div>
              <h2 className="mt-4 text-xl font-semibold text-ink">加入「{config.name || '团队工作区'}」</h2>
              <p className="mt-2 text-sm leading-6 text-ink-3">
                以下非敏感配置将写入本机。继续前会验证 Rocket.Chat；ADO、AI 和模板在填写个人凭据后验证。
                用户名、密码、PAT 和 AI 密钥不会从团队配置读取。
              </p>

              <div className="mt-5 divide-y divide-line rounded-lg border border-line">
                {summary.map((item) => (
                  <div key={item.label} className="flex gap-3 px-3 py-2.5 text-xs">
                    <Check size={14} className="mt-0.5 shrink-0 text-success" />
                    <span className="w-20 shrink-0 text-ink-3">{item.label}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2" title={item.value}>{item.value}</span>
                  </div>
                ))}
              </div>

              {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2.5 text-sm leading-5 text-danger">{error}</div>}

              <button
                onClick={() => void joinTeam()}
                disabled={busy}
                className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                {busy ? '正在验证 Rocket.Chat…' : '确认并继续'}
              </button>
              <button
                onClick={() => {
                  setConfig(null);
                  setError(null);
                }}
                className="mt-2 h-9 text-sm text-ink-3 hover:text-primary"
              >
                返回修改地址
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
