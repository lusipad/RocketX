import { useState } from 'react';
import { ArrowLeft, Loader2, Rocket, XCircle } from 'lucide-react';
import { loadWorkbenchConfig, type WorkbenchConfig } from '../lib/ado';
import { canUseNtlm, directGetIdentity, probeAdo } from '../lib/adoDirect';
import { isTauri } from '../lib/client';
import { useAuth } from '../stores/auth';
import { useOnboarding } from '../stores/onboarding';
import { useWorkbench } from '../stores/workbench';

export default function AdoOnboardingPage() {
  const saved = loadWorkbenchConfig();
  const [mode, setMode] = useState<'direct' | 'bridge'>(saved?.mode ?? (isTauri ? 'direct' : 'bridge'));
  const [adoBase, setAdoBase] = useState(saved?.adoBase ?? '');
  const [bridge, setBridge] = useState(saved?.bridge ?? 'http://localhost:8377');
  const [pat, setPat] = useState(saved?.pat ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logout = useAuth((state) => state.logout);
  const setWorkbenchConfig = useWorkbench((state) => state.setConfig);
  const setAdo = useOnboarding((state) => state.setAdo);

  const finish = (config: WorkbenchConfig) => {
    setWorkbenchConfig(config);
    setAdo('configured');
  };

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'direct') {
        if (!adoBase.trim()) throw new Error('请填写 Azure DevOps 地址');
        const probe = await probeAdo(adoBase.trim(), pat.trim());
        if (!probe.found) {
          const tried = [...new Set(probe.steps.map((step) => step.auth))].join('、');
          const hint = !canUseNtlm
            ? '网页版不能使用 Windows 集成认证，请填写 PAT 或改用 ado-bridge。'
            : !pat.trim()
              ? 'Windows 集成认证未通过；如果服务器未启用 NTLM/Negotiate，请填写 PAT。'
              : '请检查 PAT 是否过期，并确认具备 Work Items、Code 和 Build 读取权限。';
          throw new Error(`连接失败${tried ? `（已尝试：${tried}）` : ''}。${hint}`);
        }
        let account = saved?.account ?? '';
        try {
          const identity = await directGetIdentity({
            adoBase: probe.found.adoBase,
            pat: pat.trim(),
            auth: probe.found.auth,
          });
          account = identity.account;
        } catch {
          /* 工作项查询仍可使用 @Me，身份识别失败不阻塞连接 */
        }
        finish({
          mode: 'direct',
          adoBase: probe.found.adoBase,
          pat: pat.trim() || undefined,
          auth: probe.found.auth,
          account,
        });
      } else {
        const base = bridge.trim().replace(/\/+$/, '');
        if (!base) throw new Error('请填写 ado-bridge 地址');
        const response = await fetch(`${base}/api/ado/config`);
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `桥接服务返回 ${response.status}`);
        }
        const data = (await response.json()) as {
          account?: string;
        };
        finish({ mode: 'bridge', bridge: base, account: data.account ?? '' });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '连接 Azure DevOps 失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-[640px] items-center justify-center bg-fill-2 px-6">
      <div className="w-full max-w-[560px] rounded-2xl border border-line bg-surface-4 p-8 shadow-[0_8px_36px_rgba(31,35,41,0.1)]">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-white">
              <Rocket size={23} />
            </div>
            <div>
              <div className="text-xs text-primary">首次设置 · 可跳过</div>
              <h1 className="mt-0.5 text-xl font-semibold text-ink">连接 Azure DevOps</h1>
            </div>
          </div>
          <button
            onClick={() => void logout()}
            className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
          >
            <ArrowLeft size={13} /> 返回登录
          </button>
        </div>

        <p className="mb-5 text-sm leading-relaxed text-ink-3">
          用于工作项、拉取请求和构建状态。暂时没有权限也可以跳过，不影响聊天。
        </p>

        <div className="mb-4 flex rounded-lg bg-fill-1 p-1">
          {(['direct', 'bridge'] as const).map((value) => (
            <button
              key={value}
              onClick={() => {
                setMode(value);
                setError(null);
              }}
              className={`h-8 flex-1 rounded-md text-sm transition ${
                mode === value ? 'bg-surface-4 font-medium text-primary shadow-sm' : 'text-ink-3'
              }`}
            >
              {value === 'direct' ? '直连 Azure DevOps' : '使用 ado-bridge'}
            </button>
          ))}
        </div>

        {mode === 'direct' ? (
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm text-ink-2">Azure DevOps 地址</span>
              <input
                value={adoBase}
                onChange={(event) => {
                  setAdoBase(event.target.value);
                  setError(null);
                }}
                placeholder="直接粘贴浏览器里的项目页地址"
                className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-primary"
                autoFocus
              />
              <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">
                {isTauri
                  ? '会自动找到集合根，并优先使用当前 Windows 域账号，无需手工拼地址。'
                  : '网页版不能使用 Windows 集成认证，请填写 PAT；也可以切换到 ado-bridge。'}
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm text-ink-2">个人访问令牌（PAT，可选）</span>
              <input
                type="password"
                value={pat}
                onChange={(event) => {
                  setPat(event.target.value);
                  setError(null);
                }}
                placeholder={isTauri ? '集成认证失败时再填写' : '网页版直连时需要填写'}
                className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-primary"
                autoComplete="off"
              />
            </label>
          </div>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-sm text-ink-2">ado-bridge 地址</span>
            <input
              value={bridge}
              onChange={(event) => {
                setBridge(event.target.value);
                setError(null);
              }}
              placeholder="http://bridge.example.com:8377"
              className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-primary"
              autoFocus
            />
            <span className="mt-1.5 block text-xs text-ink-3">PAT 保存在桥接服务端，不下发到浏览器。</span>
          </label>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-danger/15 px-3 py-2.5 text-sm text-danger">
            <XCircle size={16} />
            <span className="min-w-0 flex-1 leading-relaxed break-words">{error}</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={() => setAdo('skipped')}
            disabled={busy}
            className="h-9 px-2 text-sm text-ink-3 hover:text-ink disabled:opacity-50"
          >
            暂时跳过
          </button>
          <button
            onClick={() => void connect()}
            disabled={busy || (mode === 'direct' ? !adoBase.trim() : !bridge.trim())}
            className="flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? '正在连接…' : '连接并继续'}
          </button>
        </div>
      </div>
    </div>
  );
}
